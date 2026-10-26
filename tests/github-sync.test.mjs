import { cleanupOwner } from './owner-cleanup.mjs';
import { until as untilWorker } from './landing-worker-fixture.mjs';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { withQueueSlot } from '../dist/landing-queue.js';
// SPDX-License-Identifier: Apache-2.0
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkService } from '../dist/work.js';
import { githubSync } from '../dist/github-sync.js';
import { drainGithubPush } from '../dist/github-auto-push.js';
import { pendingGithubPush } from '../dist/github-auto-push-state.js';
import { checkEnvironment } from '../dist/work-run.js';
import { githubSyncCli } from '../dist/github-sync-cli.js';
import { git, write, code } from './helpers.mjs';

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

// Reuse an immutable seed, copying the bare repository so every case can mutate
// its own refs/config/objects. Git history and all sync operations remain real.
let seedDirectory;
function seedRepository() {
  if (seedDirectory) return join(seedDirectory, 'remote.git');
  seedDirectory = mkdtempSync(join(tmpdir(), 'forge-github-seed-'));
  const seed = join(seedDirectory, 'seed');
  mkdirSync(seed);
  git(seed, ['init', '-q', '--initial-branch=main']);
  write(seed, 'old.txt', 'Old GitHub source');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-qm', 'GitHub root']);
  git(seed, ['clone', '--bare', seed, join(seedDirectory, 'remote.git')]);
  return join(seedDirectory, 'remote.git');
}
after(() => {
  if (seedDirectory) rmSync(seedDirectory, { recursive: true, force: true });
});

function fixture(t, flags = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'forge-github-sync-'));
  t.after(async () => {
    await cleanupOwner(owner, undefined, { stopChecks: true });
    rmSync(temporary, { recursive: true, force: true });
  });
  const remote = join(temporary, 'remote.git'),
    owner = join(temporary, 'forge-native');
  cpSync(seedRepository(), remote, { recursive: true });
  mkdirSync(owner);
  write(owner, 'a.txt', 'Accepted source\n');
  write(owner, '.env.local', 'synthetic secret');
  write(owner, '.gitignore', 'ignored.txt\n');
  write(owner, 'ignored.txt', 'not captured');
  write(owner, '.ssh/id_rsa', 'synthetic key');
  write(owner, '.github/workflows/ci.yml', 'name: synthetic\n');
  initNative(owner);
  const work = new WorkService(owner);
  const local = command => work.execute(command, work.store.load().revision).result;
  const accept = (outcome, files = {}, acceptedBy, earlierFiles = []) => {
    const base = work.store
      .load()
      .channelMoves.filter(move => move.channel === 'main' && move.status === 'accepted')
      .at(-1);
    const intent = local({
      action: 'intent',
      outcome,
      ...(base ? { baseChannel: { name: 'main', head: base.head, acceptanceId: base.id } } : {}),
    });
    const lane = local({ action: 'lane', intentId: intent.id, name: outcome });
    for (const batch of earlierFiles) {
      for (const [path, bytes] of Object.entries(batch)) write(work.store.path(lane.id), path, bytes);
      const state = work.status().lanes.find(item => item.id === lane.id);
      local({
        action: 'checkpoint',
        laneId: lane.id,
        expectedHead: state.head,
        expectedTree: state.indexTree,
        message: 'Earlier saved version',
      });
    }
    for (const [path, bytes] of Object.entries(files)) {
      if (bytes === null) rmSync(join(work.store.path(lane.id), path));
      else write(work.store.path(lane.id), path, bytes);
    }
    // H8 declarations are deliberately not authenticated GitHub identities.
    const data = work.store.load();
    data.lanes.find(item => item.id === lane.id).startedBy = {
      kind: 'agent',
      name: 'Synthetic Codex',
      tool: 'codex',
    };
    work.store.save(data);
    const state = work.status().lanes.find(item => item.id === lane.id);
    const saved = local({
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: state.head,
      expectedTree: state.indexTree,
      message: outcome,
    });
    const view = local({
      action: 'compose',
      intentId: intent.id,
      inputs: [{ laneId: lane.id, head: saved.head }],
    });
    const previous =
      work.store
        .load()
        .channelMoves.filter(move => move.channel === 'main' && move.status === 'accepted')
        .at(-1)?.head ?? null;
    const move = local({
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: view.id,
      expectedHead: view.head,
      expectedPrevious: previous,
    });
    if (acceptedBy !== undefined) {
      const data = work.store.load(),
        record = data.channelMoves.find(item => item.id === move.id);
      if (acceptedBy === null) delete record.acceptedBy;
      else record.acceptedBy = acceptedBy;
      work.store.save(data);
    }
    return { view, move, intent };
  };
  local({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
  });
  const first = accept('Initial accepted main', { 'acceptance.txt': 'First acceptance\n' });
  const bin = join(temporary, 'bin'),
    control = join(temporary, 'control.json');
  mkdirSync(bin);
  writeFileSync(control, JSON.stringify(flags));
  writeFileSync(
    join(bin, 'git-control.mjs'),
    `#!${process.execPath}
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,rmSync} from 'node:fs';
const file=${JSON.stringify(control)}, remote=${JSON.stringify(remote)}, real=${JSON.stringify(realGit)};
const state=JSON.parse(readFileSync(file));
const prefix='https://github.com/tests/';
const args=process.argv.slice(2).map(a=>{if(!a.startsWith(prefix)||!a.endsWith('.git'))return a;const n=a.slice(prefix.length,-4);return n==='sync'?remote:${JSON.stringify(temporary)}+'/'+n+'.git';});
const save=()=>{writeFileSync(file,JSON.stringify(state));if(state.failObserve)writeFileSync(file+'.observe-failure','');else rmSync(file+'.observe-failure',{force:true});};
if(args.includes('ls-remote')&&state.failObserve){state.failObserve=false;save();process.exit(91);}
if(args.includes('push')){
 state.pushes=(state.pushes??0)+1;
 (state.pushLeases??=[]).push(args.find(a=>a.startsWith('--force-with-lease=')));
 if(state.raceHead){spawnSync(real,['--git-dir='+(state.raceGit??remote),'update-ref','refs/heads/main',state.raceHead]);delete state.raceHead;}
 save();
 if(state.transientPush){state.transientPush--;save();process.stderr.write('! [remote rejected] a -> main (failed)');process.exit(1);}
 if(state.permanentPush){process.stderr.write('remote: Permission to tests/sync denied');process.exit(1);}
}
const out=spawnSync(real,['-c','user.name=Configured Human','-c','user.email=configured@example.test','-c','forge.githubSync.coAuthor=Synthetic lead <lead@example.test>',...(state.config??[]).flatMap(c=>['-c',c]),...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},...(args.includes('--stdin')||args.includes('mktree')?{input:readFileSync(0)}:{})});
process.stdout.write(out.stdout??'');process.stderr.write(out.stderr??'');
if(args.includes('push')&&state.lostTransientReply){state.lostTransientReply=false;save();process.stderr.write('RPC failed: connection reset');process.exit(1);}
if(args.includes('push')&&state.lostReply){state.lostReply=false;state.failObserve=true;save();process.exit(92);}
process.exit(out.status??1);
`,
    { mode: 0o700 },
  );
  // Most Git calls only need URL/config rewriting. Exec Git directly for those;
  // keep the Node shim for push/observation fault injection and retained counters.
  const writeShim = state => {
    if (state.failObserve) writeFileSync(control + '.observe-failure', '');
    else rmSync(control + '.observe-failure', { force: true });
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/bash
for arg in "$@"; do
  case "$arg" in
    push) exec ${shellQuote(process.execPath)} ${shellQuote(join(bin, 'git-control.mjs'))} "$@" ;;
    ls-remote) if [ -f ${shellQuote(control + '.observe-failure')} ]; then exec ${shellQuote(process.execPath)} ${shellQuote(join(bin, 'git-control.mjs'))} "$@"; fi ;;
  esac
done
args=()
for arg in "$@"; do
  case "$arg" in
    https://github.com/tests/*.git)
      name="\${arg#https://github.com/tests/}"
      name="\${name%.git}"
      if [ "$name" = sync ]; then arg=${shellQuote(remote)}; else arg=${shellQuote(temporary)}/"$name.git"; fi ;;
  esac
  args+=("$arg")
done
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
exec ${shellQuote(realGit)} -c 'user.name=Configured Human' -c 'user.email=configured@example.test' -c 'forge.githubSync.coAuthor=Synthetic lead <lead@example.test>' ${(state.config ?? []).map(value => '-c ' + shellQuote(value)).join(' ')} "\${args[@]}"
`,
      { mode: 0o700 },
    );
  };
  writeShim(flags);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  const sync = options => githubSync(owner, { repository: 'tests/sync', ...options });
  const head = () => git(remote, ['rev-parse', 'main']).trim();
  const controlState = () => JSON.parse(readFileSync(control));
  const change = values => {
    const state = { ...controlState(), ...values };
    writeFileSync(control, JSON.stringify(state));
    writeShim(state);
  };
  const bare = name => {
    const path = join(temporary, `${name}.git`);
    git(temporary, ['init', '-q', '--bare', '--initial-branch=main', path]);
    return path;
  };
  return { temporary, bare, owner, remote, work, first, accept, sync, head, change, controlState };
}

// A real checkout and bare destination keep merge/squash ancestry and trees realistic.
function externalCommit(f, files = {}, kind = 'commit') {
  const checkout = join(f.temporary, `external-${randomUUID()}`);
  git(f.temporary, ['clone', '-q', '--no-hardlinks', f.remote, checkout]);
  if (kind !== 'commit') git(checkout, ['checkout', '-qb', 'topic']);
  for (const [path, bytes] of Object.entries(files)) {
    if (bytes === null) rmSync(join(checkout, path));
    else write(checkout, path, bytes);
  }
  git(checkout, ['add', '-A']);
  git(checkout, ['commit', '--allow-empty', '-qm', 'External work']);
  if (kind !== 'commit') {
    git(checkout, ['checkout', '-q', 'main']);
    git(checkout, ['merge', kind === 'squash' ? '--squash' : '--no-ff', 'topic', '-m', 'GitHub merge']);
    if (kind === 'squash') git(checkout, ['commit', '--allow-empty', '-qm', 'Squashed external work']);
  }
  git(f.remote, ['fetch', '--no-tags', checkout, 'main:refs/heads/main']);
  return f.head();
}

test('default dry-run prints adoption and file changes without pushing or saving Work', async t => {
  const f = fixture(t),
    before = f.work.store.snapshotBytes(),
    oldHead = f.head();
  const plan = await githubSyncCli([f.owner, '--repo', 'tests/sync']);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.pushed, false);
  assert.equal(plan.ref, 'refs/heads/main');
  assert.equal(plan.commits.length, 1);
  assert.equal(plan.commits[0].parent, oldHead);
  assert.match(plan.commits[0].message, /^Adopt Forge native main [a-f0-9]{64}/);
  assert.ok(plan.commits[0].files.some(file => file.status === 'D' && file.path === 'old.txt'));
  assert.ok(plan.commits[0].files.some(file => file.status === 'A' && file.path === 'a.txt'));
  assert.ok(!plan.commits[0].files.some(file => /\.env|\.ssh|ignored/.test(file.path)));
  assert.equal(f.head(), oldHead);
  assert.deepEqual(f.work.store.snapshotBytes(), before);
  assert.equal(f.controlState().pushes, undefined);
  await assert.rejects(githubSyncCli([f.owner, '--dry-run', '--push']), code('BAD_ARGUMENT'));
  await assert.rejects(githubSyncCli([f.owner, '--repo', '--push']), code('BAD_ARGUMENT'));
});

test('adoption has the GitHub parent, exact accepted tree, mapping, attribution and excluded files absent', async t => {
  const f = fixture(t),
    oldHead = f.head(),
    operationId = randomUUID();
  write(f.owner, 'a.txt', 'Unaccepted owner edit');
  const plan = await f.sync({ push: true, operationId }),
    adopted = f.head();
  assert.equal(plan.pushed, true);
  assert.equal(git(f.remote, ['rev-parse', `${adopted}^`]).trim(), oldHead);
  assert.equal(git(f.remote, ['show', `${adopted}:a.txt`]), 'Accepted source\n');
  const paths = git(f.remote, ['ls-tree', '-r', '--name-only', adopted]).trim().split('\n');
  assert.deepEqual(
    paths,
    new NativeSource(f.owner).state(f.first.view.head).files.map(file => file.path),
  );
  assert.ok(paths.includes('.github/workflows/ci.yml'));
  assert.ok(!paths.some(path => /\.env|\.ssh|ignored/.test(path)));
  assert.match(
    git(f.remote, ['show', '-s', '--format=%B', adopted]),
    /Co-authored-by: Synthetic lead <lead@example.test>/,
  );
  assert.match(
    git(f.remote, ['show', '-s', '--format=%B', adopted]),
    /Co-authored-by: Synthetic Codex <noreply@openai.com>/,
  );
  const binding = f.work.store.load().githubSync;
  assert.equal(binding.adoptedCommit, oldHead);
  assert.equal(binding.commits[0].state, f.first.view.head);
  assert.equal(binding.commits[0].commit, adopted);
  assert.equal(binding.pushed, 1);
  assert.ok(Number.isFinite(Date.parse(binding.pushedAt)));
  assert.equal((await f.sync({ push: true, operationId })).alreadyPushed, true);
  assert.equal(f.controlState().pushes, 1);
});

test('incremental sync writes one commit per acceptance in order with Intent, View and actor attribution', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const adoption = f.head();
  const second = f.accept(
    'Second outcome',
    { 'a.txt': 'Second\n' },
    { kind: 'person', name: 'Accepting Human' },
  );
  const third = f.accept(
    'Third outcome',
    { 'b.txt': 'Third\n' },
    { kind: 'agent', name: 'Claude reviewer', tool: 'claude' },
  );
  const dry = await f.sync();
  assert.equal(dry.commits.length, 2);
  assert.equal(f.head(), adoption);
  const plan = await f.sync({ push: true });
  assert.deepEqual(
    plan.commits.map(entry => entry.state),
    [second.view.head, third.view.head],
  );
  assert.equal(plan.commits[0].parent, adoption);
  assert.equal(plan.commits[1].parent, plan.commits[0].commit);
  assert.equal(
    git(f.remote, ['show', '-s', '--format=%an', plan.commits[0].commit]).trim(),
    'Accepting Human',
  );
  assert.equal(git(f.remote, ['show', '-s', '--format=%an', f.head()]).trim(), 'Claude reviewer');
  assert.match(plan.commits[1].message, /Third outcome\n/);
  assert.ok(plan.commits[1].message.includes(`Forge-Acceptance: ${third.move.id}`));
  assert.ok(plan.commits[1].message.includes(`Forge-View: ${third.view.id}`));
  assert.equal(git(f.remote, ['show', `${plan.commits[0].commit}:a.txt`]), 'Second\n');
  assert.equal(git(f.remote, ['show', `${f.head()}:b.txt`]), 'Third\n');
  assert.equal((await f.sync({ push: true })).commits.length, 0);
  f.accept('Old acceptance without H8', { 'b.txt': 'Fourth\n' }, null);
  const fourth = await f.sync({ push: true });
  assert.equal(fourth.commits[0].author.name, 'Configured Human');
});

test('remote edits and racing ref moves are refused without overwriting', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const synced = f.head();
  f.accept('Next native acceptance', { 'next.txt': 'Next\n' });
  const outside = externalCommit(f, { 'outside.txt': 'External only\n' });
  await assert.rejects(
    f.sync({ push: true }),
    error => error.code === 'GITHUB_SYNC_CHANGED' && error.message.includes('GitHub changed outside Forge'),
  );
  assert.equal(f.head(), outside);
  assert.equal(f.work.store.load().githubSync.commits.length, 1);
  git(f.remote, ['update-ref', 'refs/heads/main', synced]);
  f.change({ raceHead: outside });
  await assert.rejects(f.sync({ push: true }), code('GITHUB_SYNC_CHANGED'));
  assert.equal(f.head(), outside);
  assert.equal(f.work.store.load().githubSync.pushed, 1);
  // A reset to an ancestor is also an outside move, even though ordinary push could fast-forward it.
  git(f.remote, ['update-ref', 'refs/heads/main', synced]);
  const oldHead = git(f.remote, ['rev-parse', `${synced}^`]).trim();
  f.change({ raceHead: oldHead });
  await assert.rejects(f.sync({ push: true }), code('GITHUB_SYNC_CHANGED'));
  assert.equal(f.head(), oldHead);
});

test('lost push reply resumes the original pending mapping without duplicating commits', async t => {
  const f = fixture(t, { lostReply: true }),
    operationId = randomUUID();
  await assert.rejects(f.sync({ push: true, operationId }), code('GITHUB_SYNC_GIT_FAILED'));
  const head = f.head(),
    pending = f.work.store.load().githubSync;
  assert.equal(pending.pushed, 0);
  assert.equal(pending.commits[0].commit, head);
  // A later acceptance must wait until the unknown original batch is reconciled.
  const next = f.accept('Accepted after unknown push', { 'later.txt': 'Later\n' });
  const resumed = await f.sync({ push: true });
  assert.equal(resumed.alreadyPushed, true);
  assert.equal(f.head(), head);
  assert.equal(f.work.store.load().githubSync.pushed, 1);
  assert.equal(f.controlState().pushes, 1);
  const incremental = await f.sync({ push: true });
  assert.equal(incremental.commits.length, 1);
  assert.equal(incremental.commits[0].state, next.view.head);
  assert.equal(git(f.remote, ['rev-list', '--count', 'main']).trim(), '3');
  const replay = await f.sync({ push: true, operationId });
  assert.equal(replay.alreadyPushed, true);
  assert.equal(f.controlState().pushes, 2);
});

test('explicitly retained tracked source follows accepted capture membership, not filename heuristics', async t => {
  const f = fixture(t),
    source = new NativeSource(f.owner),
    data = f.work.store.load();
  const head = source.writeState(
    [
      ...source.state(f.first.view.head).files,
      {
        path: 'src/secrets.ts',
        blob: source.put(Buffer.from('export const synthetic = true;')),
        mode: 'file',
      },
      { path: '.env.example', blob: source.put(Buffer.from('SYNTHETIC_PLACEHOLDER=')), mode: 'file' },
    ],
    [f.first.view.head],
    'Explicitly retained tracked source',
    new Date().toISOString(),
  );
  data.channelMoves.at(-1).head = head;
  data.views.find(view => view.id === f.first.view.id).head = head;
  f.work.store.save(data);
  const plan = await f.sync({ push: true });
  assert.equal(git(f.remote, ['show', `${f.head()}:src/secrets.ts`]), 'export const synthetic = true;');
  assert.equal(git(f.remote, ['show', `${f.head()}:.env.example`]), 'SYNTHETIC_PLACEHOLDER=');
  assert.equal(plan.commits[0].state, head);
});

test('CLI supports dry-run and rejects retargeting an existing binding', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const child = spawnSync(process.execPath, [resolve('dist/cli.js'), 'github-sync', f.owner, '--dry-run'], {
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).commits.length, 0);
  assert.equal(JSON.parse(child.stdout).reason, 'dry-run');
  await assert.rejects(f.sync({ repository: 'tests/elsewhere' }), code('GITHUB_SYNC_BINDING'));
});

test('GitHub status uses audit-compatible Work format and retries hosted metadata with stable pins', async t => {
  const { publishGithubStatus } = await import('../dist/github-sync-status.js');
  const { updateHostState } = await import('../dist/host-binding.js');
  const { ownerSyncSchema } = await import('../dist/owner-sync-types.js');
  const { workSchema } = await import('../dist/work-types.js');
  const f = fixture(t),
    schema = f.work.store.load().schema;
  await f.sync({ push: true });
  const data = f.work.store.load();
  assert.equal(data.schema, Math.max(schema, 13)); // Main audit evidence uses the existing format 13.
  assert.ok(data.runs.some(run => run.mainCheck && run.status === 'passed'));
  const { z } = await import('zod');
  const previousShape = { ...workSchema.shape };
  delete previousShape.githubSync;
  assert.equal(z.object(previousShape).parse(data).githubSync, undefined); // older shapes ignore unknown optional fields
  updateHostState(f.work.store, state => {
    state.binding = {
      projectId: 'project',
      deployment: 'https://synthetic.convex.cloud',
      projectUrl: 'https://example.test/project',
      operationId: randomUUID(),
      name: 'Synthetic',
      visibility: 'private',
      backupId: 'backup',
    };
  });
  const sent = [];
  const client = {
    mutation: async (_, input) => {
      sent.push(input);
      if (sent.length === 1) throw new Error('lost reply');
    },
  };
  assert.equal((await publishGithubStatus(f.work.store, client)).status, 'deferred');
  assert.equal((await publishGithubStatus(f.work.store, client)).status, 'published');
  assert.deepEqual(sent[0], sent[1]);
  const payload = ownerSyncSchema.parse(JSON.parse(sent[1].metadata));
  const binding = payload.entries[0].value;
  assert.equal(binding.repository, 'tests/sync');
  assert.equal(binding.branch, 'main');
  assert.equal(binding.commits[0].commit, f.head());
  assert.equal(binding.pushedAt, data.githubSync.pushedAt);
  assert.equal(f.controlState().pushes, 1);
});

async function green(f, view = f.first.view) {
  const check = f.work.execute(
    {
      action: 'define-check',
      name: 'synthetic passing check',
      executable: process.execPath,
      args: ['-e', '0'],
    },
    f.work.store.revision(),
  ).result;
  const result = await f.work.dispatch(
    {
      action: 'run-check',
      operationId: randomUUID(),
      viewId: view.id,
      expectedHead: view.head,
      checkId: check.id,
      expectedDefinition: check.definition,
      expectedEnvironment: checkEnvironment().fingerprint,
    },
    f.work.store.revision(),
  );
  await until(() => f.work.store.load().runs.find(run => run.id === result.result.id)?.status === 'passed');
}
async function until(predicate) {
  for (let i = 0; i < 600; i++) {
    try {
      if (predicate()) return;
    } catch (error) {
      if (error.code !== 'SOURCE_CHANGED') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Timed out waiting for local mirror worker');
}
async function mirrorPolicy(f, autoPush = true) {
  return f.work.dispatch(
    {
      action: 'set-policy',
      operationId: randomUUID(),
      githubMirror: { repo: 'tests/sync', autoPush, laneRefs: false },
    },
    f.work.store.revision(),
  );
}
const drain = f => drainGithubPush(f.work.store, { debounceMs: 0, retryMs: 1 });

test('green main acceptance starts a detached push without waiting for Git', async t => {
  const f = fixture(t);
  await green(f);
  await mirrorPolicy(f);
  const move = f.work.execute(
    {
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: f.first.view.id,
      expectedHead: f.first.view.head,
      expectedPrevious: f.first.view.head,
    },
    f.work.store.revision(),
  ).result;
  assert.equal(move.status, 'accepted');
  await until(() => {
    const status = f.work.store.load().githubAutoPush;
    return status?.status === 'pushed' && !status.worker;
  });
  assert.equal(f.work.store.load().githubSync.commits.at(-1).acceptanceId, move.id);
  assert.equal(f.controlState().pushes, 1);
  const refs = git(f.remote, ['for-each-ref', '--format=%(refname)']).trim().split('\n');
  assert.deepEqual(refs, ['refs/heads/main']);
  assert.equal(f.work.store.load().githubAutoPush.undo.includes('autoPush:false'), true);
});

test('auto-push coalesces a burst to the newest green main and preserves all mapped acceptances', async t => {
  const f = fixture(t);
  await green(f);
  await f.sync({ push: true });
  f.accept('Burst one', { 'one.txt': 'one' });
  const latest = f.accept('Burst two', { 'two.txt': 'two' });
  await green(f, latest.view);
  await mirrorPolicy(f);
  await Promise.all([drain(f), drain(f), drain(f)]);
  assert.equal(f.controlState().pushes, 2); // one initial manual push, one burst
  assert.equal(f.work.store.load().githubSync.commits.length, 3);
  assert.equal(f.work.store.load().githubSync.commits.at(-1).state, latest.view.head);
  assert.equal(git(f.remote, ['show', 'main:two.txt']), 'two');
});

test('auto-push hydrates and stages outside the writer lock, including its sync recorder', async t => {
  const f = fixture(t);
  await green(f);
  await mirrorPolicy(f);
  let held = false,
    publications = 0;
  const locked = WorkStore.prototype.locked;
  t.mock.method(WorkStore.prototype, 'locked', function (run, options) {
    return locked.call(
      this,
      () => {
        held = true;
        publications++;
        try {
          return run();
        } finally {
          held = false;
        }
      },
      options,
    );
  });
  for (const name of ['load', 'prepareSave']) {
    const original = WorkStore.prototype[name];
    t.mock.method(WorkStore.prototype, name, function (...args) {
      assert.equal(held, false, `${name} ran under the writer lock`);
      return original.apply(this, args);
    });
  }
  await drain(f);
  assert.equal(f.work.store.load().githubAutoPush.status, 'pushed');
  assert.equal(f.controlState().pushes, 1);
  assert.ok(publications > 0, 'only CAS publication acquires the lock');
});

test('auto-push divergence records both heads as Needs you without replacing remote history', async t => {
  const f = fixture(t);
  await green(f);
  await f.sync({ push: true });
  const original = f.head();
  const latest = f.accept('New main', { 'a.txt': 'later' });
  await green(f, latest.view);
  const foreign = externalCommit(f, { 'outside.txt': 'External only\n' });
  await mirrorPolicy(f);
  await drain(f);
  const status = f.work.store.load().githubAutoPush;
  assert.equal(status.status, 'needs-you');
  assert.equal(status.expectedHead, original);
  assert.equal(status.remoteHead, foreign);
  assert.match(status.detail, /outside\.txt/);
  assert.match(status.detail, /nforge agent ROOT start/);
  assert.ok(status.localHead);
  assert.equal(f.head(), foreign);
  assert.equal(f.controlState().pushes, 1);
  await drain(f);
  assert.equal(f.controlState().pushes, 1);
});

test('default/off policy and unchecked main do no remote work; lane ref publication is rejected', async t => {
  const f = fixture(t);
  await drain(f);
  assert.equal(f.work.store.load().githubAutoPush, undefined);
  await green(f);
  await mirrorPolicy(f, false);
  await drain(f);
  assert.equal(f.controlState().pushes, undefined);
  f.accept('Unchecked', { 'unchecked.txt': 'no green check' });
  await mirrorPolicy(f);
  await drain(f);
  assert.equal(f.controlState().pushes, undefined);
  await assert.rejects(
    f.work.dispatch(
      {
        action: 'set-policy',
        operationId: randomUUID(),
        githubMirror: { repo: 'tests/sync', autoPush: true, laneRefs: true },
      },
      f.work.store.revision(),
    ),
    code('BAD_ARGUMENT'),
  );
});

test('transient auto-push failures back off and reconcile their retained operation', async t => {
  const f = fixture(t, { lostReply: true });
  await green(f);
  await mirrorPolicy(f);
  const delays = [];
  await drainGithubPush(f.work.store, {
    debounceMs: 0,
    retryMs: 1,
    sleep: async ms => {
      delays.push(ms);
    },
  });
  assert.equal(f.controlState().pushes, 1);
  assert.equal(f.work.store.load().githubAutoPush.status, 'pushed');
  assert.equal(f.work.store.load().githubAutoPush.attempts, 2);
  assert.ok(delays.length > 1);
});

test('automatic projection exports secret-named source and templates, omits credentials and never publishes Lane refs', async t => {
  const f = fixture(t),
    source = new NativeSource(f.owner);
  const data = f.work.store.load(),
    view = data.views.find(v => v.id === f.first.view.id);
  const included = [
    'src/secret-crypto.ts',
    'convex/secrets.ts',
    'tests/secrets.test.mjs',
    'web/src/Secrets.tsx',
    'src/credentials.py',
    '.env.example',
    '.env.sample',
    '.env.template',
  ];
  const excluded = [
    '.env.local',
    '.env.production',
    '.env.example.local',
    '.env.ts',
    '.npmrc',
    '.netrc',
    'credentials.json',
    'secrets.json',
    'tls/cert.pem',
    'tls/private.key',
    'tls/client.p12',
    'tls/client.pfx',
    'tls/client.keystore',
    '.ssh/id_rsa',
    '.aws/credentials',
    'private-artifacts/secrets.ts',
  ];
  const files = [
    ...source.state(view.head).files,
    ...[...included, ...excluded].map(path => ({
      path,
      blob: source.put(Buffer.from(`synthetic fixture: ${path}\n`)),
      mode: 'file',
    })),
  ];
  const head = source.writeState(files, [view.head], 'private tracked fixture', new Date().toISOString());
  view.head = head;
  data.channelMoves.at(-1).head = head;
  f.work.store.save(data);
  await green(f, view);
  await mirrorPolicy(f);
  const before = f.work.store.snapshotBytes(),
    oldHead = f.head(),
    dry = await f.sync({ autoPush: true });
  assert.equal(dry.dryRun, true);
  assert.equal(f.head(), oldHead);
  assert.deepEqual(f.work.store.snapshotBytes(), before);
  for (const path of included)
    assert(
      dry.commits[0].files.some(file => file.path === path),
      path,
    );
  for (const path of excluded) assert(!dry.commits[0].files.some(file => file.path === path), path);
  await drain(f);
  const paths = git(f.remote, ['ls-tree', '-r', '--name-only', 'main']).trim().split('\n');
  assert.deepEqual(
    paths,
    files
      .map(file => file.path)
      .filter(path => !excluded.includes(path))
      .sort(),
  );
  assert.deepEqual(f.work.store.load().githubSync.commits[0].excludedPaths, [...excluded].sort());
  for (const path of included)
    assert.equal(git(f.remote, ['show', `main:${path}`]), `synthetic fixture: ${path}\n`);
  assert.equal(git(f.remote, ['for-each-ref', '--format=%(refname)']).trim(), 'refs/heads/main');
});

test('policy survives presets and hosted metadata reports pending status before a first push', async t => {
  const f = fixture(t);
  await mirrorPolicy(f);
  await f.work.dispatch(
    { action: 'set-policy', operationId: randomUUID(), preset: 'trusted' },
    f.work.store.revision(),
  );
  assert.equal(f.work.store.load().autonomyPolicy.githubMirror.autoPush, true);
  const data = f.work.store.load();
  data.githubAutoPush = {
    id: 'github-auto-push',
    repository: 'tests/sync',
    acceptanceId: f.first.move.id,
    state: f.first.view.head,
    operationId: randomUUID(),
    status: 'retrying',
    attempts: 1,
    at: new Date().toISOString(),
    code: 'GITHUB_SYNC_GIT_FAILED',
    undo: 'Disable autoPush',
  };
  f.work.store.save(data);
  const { updateHostState } = await import('../dist/host-binding.js');
  updateHostState(f.work.store, state => {
    state.binding = {
      projectId: 'project',
      deployment: 'https://synthetic.convex.cloud',
      projectUrl: 'https://example.test/project',
      operationId: randomUUID(),
      name: 'Synthetic',
      visibility: 'private',
      backupId: 'backup',
    };
  });
  const { publishGithubStatus } = await import('../dist/github-sync-status.js');
  const sent = [];
  assert.equal(
    (await publishGithubStatus(f.work.store, { mutation: async (_, payload) => sent.push(payload) })).status,
    'published',
  );
  const payload = JSON.parse(sent[0].metadata);
  assert.equal(payload.entries[0].collection, 'githubAutoPush');
  assert.equal(payload.entries[0].value.status, 'retrying');
  assert.equal(payload.entries[0].value.state, f.first.view.head);
  assert.equal(f.controlState().pushes, undefined);
});

test('acceptance wakeup tolerates a transient Work observation failure', async () => {
  const { wakeGithubPush } = await import('../dist/github-auto-push.js');
  assert.doesNotThrow(() =>
    wakeGithubPush({
      native: true,
      readRecords: () => {
        throw Object.assign(new Error('synthetic concurrent manifest replacement'), {
          code: 'SOURCE_CHANGED',
        });
      },
    }),
  );
});

test('rebind is refused while the current binding has a pending operation', async t => {
  const f = fixture(t);
  f.change({ lostReply: true });
  await assert.rejects(f.sync({ push: true }), code('GITHUB_SYNC_GIT_FAILED'));
  const before = f.work.store.load();
  assert.ok(before.githubSync.pushed < before.githubSync.commits.length);
  f.bare('fresh');
  await assert.rejects(
    githubSync(f.owner, { repository: 'tests/fresh', rebind: true, push: true }),
    code('GITHUB_SYNC_PENDING'),
  );
  await assert.rejects(
    githubSync(f.owner, { repository: 'tests/fresh', push: true }),
    code('GITHUB_SYNC_BINDING'),
  );
  assert.deepEqual(f.work.store.load().githubSync, before.githubSync);
});

test('rebind dry-run writes nothing and reports the unchanged mirror policy', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  f.bare('fresh');
  const data = f.work.store.load();
  data.autonomyPolicy = {
    ...data.autonomyPolicy,
    githubMirror: { repo: 'tests/sync', autoPush: false, laneRefs: false },
  };
  f.work.store.save(data);
  const before = JSON.stringify(f.work.store.load());
  const plan = await githubSync(f.owner, { repository: 'tests/fresh', rebind: true });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.commits.length, 1);
  assert.equal(plan.commits[0].parent, '');
  assert.equal(plan.rebind.from.repository, 'tests/sync');
  assert.equal(plan.rebind.to.repository, 'tests/fresh');
  assert.match(plan.rebind.mirrorPolicy, /tests\/sync.*does not change it/);
  assert.equal(JSON.stringify(f.work.store.load()), before);
  await assert.rejects(githubSync(f.owner, { rebind: true }), code('BAD_ARGUMENT'));
  await assert.rejects(
    githubSync(f.owner, { repository: 'tests/sync', rebind: true }),
    code('GITHUB_SYNC_REBIND'),
  );
  await assert.rejects(f.sync({ repository: 'tests/fresh' }), code('GITHUB_SYNC_BINDING'));
});

test('rebind to an empty repository writes one root commit, then fast-forwards later acceptances', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const oldBinding = f.work.store.load().githubSync;
  const fresh = f.bare('fresh');
  f.change({
    config: [
      'forge.githubSync.name=Sync Name',
      'forge.githubSync.email=12345+owner@users.noreply.github.com',
    ],
  });
  const result = await githubSync(f.owner, { repository: 'tests/fresh', rebind: true, push: true });
  assert.equal(result.pushed, true);
  const root = git(fresh, ['rev-parse', 'main']).trim();
  assert.equal(git(fresh, ['rev-list', '--count', 'main']).trim(), '1');
  assert.equal(git(fresh, ['rev-list', '--parents', '-n1', 'main']).trim(), root);
  assert.equal(git(fresh, ['show', `${root}:a.txt`]), 'Accepted source\n');
  assert.equal(git(fresh, ['show', `${root}:acceptance.txt`]), 'First acceptance\n');
  assert.match(git(fresh, ['show', '-s', '--format=%s', root]), /^Adopt Forge native main [0-9a-f]{64}\n$/);
  assert.equal(
    git(fresh, ['show', '-s', '--format=%ae|%ce', root]).trim(),
    '12345+owner@users.noreply.github.com|12345+owner@users.noreply.github.com',
  );
  assert.doesNotMatch(git(fresh, ['log', '--format=%an %ae %cn %ce', 'main']), /configured@example\.test/);
  const data = f.work.store.load();
  assert.equal(data.githubSync.repository, 'tests/fresh');
  assert.equal(data.githubSync.adoptedCommit, '');
  assert.equal(data.githubSync.commits.length, 1);
  assert.equal(data.githubSync.commits[0].commit, root);
  assert.equal(data.githubSync.commits[0].parent, '');
  assert.equal(data.githubSync.pushed, 1);
  assert.equal(data.githubSyncHistory.length, 1);
  assert.deepEqual(data.githubSyncHistory[0].binding, oldBinding);
  // The old repository was not touched.
  assert.equal(git(f.remote, ['rev-list', '--count', 'main']).trim(), '2');
  f.accept('Second on new home', { 'next.txt': 'Next\n' });
  const next = await githubSync(f.owner, { repository: 'tests/fresh', push: true });
  assert.equal(next.commits.length, 1);
  assert.equal(git(fresh, ['rev-list', '--count', 'main']).trim(), '2');
  assert.equal(git(fresh, ['rev-parse', 'main^']).trim(), root);
  assert.equal(
    git(fresh, ['show', '-s', '--format=%ae|%ce', 'main']).trim(),
    '12345+owner@users.noreply.github.com|12345+owner@users.noreply.github.com',
  );
  assert.equal((await githubSync(f.owner, { push: true })).commits.length, 0);
});

test('a branch created concurrently makes the first empty-repository push a conflict and overwrites nothing', async t => {
  const f = fixture(t);
  const fresh = f.bare('fresh');
  git(fresh, ['fetch', '-q', f.remote, 'main:refs/heads/seed']);
  const seed = git(fresh, ['rev-parse', 'seed']).trim();
  git(fresh, ['update-ref', '-d', 'refs/heads/seed']);
  f.change({ raceGit: fresh, raceHead: seed });
  await assert.rejects(
    githubSync(f.owner, { repository: 'tests/fresh', push: true }),
    error => error.code === 'GITHUB_SYNC_CHANGED' && error.expectedHead === '' && error.remoteHead === seed,
  );
  assert.equal(git(fresh, ['rev-parse', 'main']).trim(), seed);
});

test('sync identity precedence: env, forge.githubSync config, then user config', async t => {
  const f = fixture(t);
  const author = async () => (await githubSync(f.owner, { repository: 'tests/sync' })).commits;
  const fresh = f.bare('fresh');
  const dry = async () =>
    (await githubSync(f.owner, { repository: 'tests/fresh', rebind: true })).commits[0].author;
  void author;
  await f.sync({ push: true });
  assert.deepEqual(await dry(), { name: 'Configured Human', email: 'configured@example.test' });
  f.change({
    config: ['forge.githubSync.name=Cfg Name', 'forge.githubSync.email=cfg@users.noreply.github.com'],
  });
  assert.deepEqual(await dry(), { name: 'Cfg Name', email: 'cfg@users.noreply.github.com' });
  process.env.FORGE_GITHUB_SYNC_EMAIL = 'env@users.noreply.github.com';
  process.env.FORGE_GITHUB_SYNC_NAME = 'Env Name';
  t.after(() => {
    delete process.env.FORGE_GITHUB_SYNC_EMAIL;
    delete process.env.FORGE_GITHUB_SYNC_NAME;
  });
  assert.deepEqual(await dry(), { name: 'Env Name', email: 'env@users.noreply.github.com' });
  process.env.FORGE_GITHUB_SYNC_EMAIL = 'bad<x>@example.test';
  await assert.rejects(dry(), code('GITHUB_SYNC_IDENTITY'));
  assert.ok(fresh);
});

test('incremental commits keep the accepting actor name but use the sync-only email', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  f.change({ config: ['forge.githubSync.email=cfg@users.noreply.github.com'] });
  f.accept('Actor commit', { 'actor.txt': 'x\n' }, { kind: 'person', name: 'Real Person' });
  await f.sync({ push: true });
  assert.equal(
    git(f.remote, ['show', '-s', '--format=%an|%ae|%cn|%ce', 'main']).trim(),
    'Real Person|cfg@users.noreply.github.com|Configured Human|cfg@users.noreply.github.com',
  );
});

test('mirror retries a transient rejection with the same exact lease', async t => {
  const f = fixture(t, { transientPush: 1 });
  const before = f.head(),
    delays = [];
  const result = await f.sync({
    push: true,
    sleep: async ms => {
      delays.push(ms);
    },
  });
  assert.equal(delays.length, 1);
  assert.ok(delays[0] >= 1000 && delays[0] <= 3000, 'first retry retains its jittered backoff');
  assert.equal(result.pushed, true);
  assert.equal(f.controlState().pushes, 2);
  assert.deepEqual(
    f.controlState().pushLeases,
    Array(2).fill(`--force-with-lease=refs/heads/main:${before}`),
  );
  assert.equal(f.head(), f.work.store.load().githubSync.commits.at(-1).commit);
});
test('mirror reconciles a transient lost push reply without pushing twice', async t => {
  const f = fixture(t, { lostTransientReply: true });
  assert.equal((await f.sync({ push: true })).pushed, true);
  assert.equal(f.controlState().pushes, 1);
});
test('mirror stops when a transient rejection observes a different remote head', async t => {
  const f = fixture(t);
  const before = f.head();
  const tree = git(f.remote, ['rev-parse', `${before}^{tree}`]).trim();
  const outside = git(f.remote, ['commit-tree', tree, '-p', before, '-m', 'Synthetic outside change']).trim();
  f.change({ transientPush: 1, raceHead: outside });
  await assert.rejects(f.sync({ push: true }), code('GITHUB_SYNC_CHANGED'));
  assert.equal(f.controlState().pushes, 1);
  assert.equal(f.head(), outside);
});
test('mirror permission rejection keeps the existing error and does not retry', async t => {
  const f = fixture(t, { permanentPush: true });
  await assert.rejects(f.sync({ push: true }), code('GITHUB_SYNC_GIT_FAILED'));
  assert.equal(f.controlState().pushes, 1);
});

test('contained squash merge adopts GitHub history and the newest accepted tree, then continues incrementally', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const recorded = f.head(),
    beforeBinding = f.work.store.load().githubSync,
    outside = externalCommit(f, { 'a.txt': 'Node security fix\n' }, 'squash');
  f.accept('Same security change', { 'a.txt': 'Node security fix\n' });
  const latest = f.accept('Additional native work', { 'more.txt': 'More\n' });
  write(f.owner, 'a.txt', 'Unaccepted local edit');
  const before = f.work.store.snapshotBytes(),
    plan = await f.sync();
  assert.equal(plan.reconciliation.status, 'contained');
  assert.deepEqual(plan.reconciliation.commits, [outside]);
  assert.deepEqual(plan.reconciliation.paths, ['a.txt']);
  assert.deepEqual(plan.reconciliation.missingPaths, []);
  assert.equal(plan.commits.length, 1);
  assert.equal(plan.commits[0].parent, outside);
  assert.equal(plan.commits[0].state, latest.view.head);
  assert.match(plan.commits[0].message, /^Adopt Forge native main/);
  assert.deepEqual(f.work.store.snapshotBytes(), before);
  assert.equal(f.head(), outside);
  const result = await f.sync({ push: true });
  const adopted = f.head();
  assert.equal(git(f.remote, ['rev-parse', `${adopted}^`]).trim(), outside);
  assert.equal(git(f.remote, ['merge-base', recorded, adopted]).trim(), recorded);
  assert.equal(git(f.remote, ['show', `${adopted}:a.txt`]), 'Node security fix\n');
  assert.equal(git(f.remote, ['show', `${adopted}:more.txt`]), 'More\n');
  assert.equal(f.controlState().pushLeases.at(-1), `--force-with-lease=refs/heads/main:${outside}`);
  assert.equal(result.commits[0].author.email, 'configured@example.test');
  const binding = f.work.store.load().githubSync;
  assert.deepEqual(binding.commits.slice(0, 1), beforeBinding.commits);
  assert.equal(binding.adoptedCommit, beforeBinding.adoptedCommit);
  assert.equal(binding.pushed, 2);
  assert.equal((await f.sync({ push: true })).commits.length, 0);
  const next = f.accept('Continue after GitHub merge', { 'next.txt': 'Next\n' });
  const incremental = await f.sync({ push: true });
  assert.equal(incremental.commits[0].parent, adopted);
  assert.equal(incremental.commits[0].state, next.view.head);
});

test('contained GitHub merge commits retain both parents; empty external commits need no new acceptance', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const outside = externalCommit(f, { 'merged.txt': 'Merged change\n' }, 'merge');
  const latest = f.accept('Same merged change', { 'merged.txt': 'Merged change\n' });
  const result = await f.sync({ push: true });
  assert.equal(git(f.remote, ['rev-list', '--parents', '-n1', outside]).trim().split(' ').length, 3);
  assert.equal(result.reconciliation.status, 'contained');
  assert.equal(result.reconciliation.commits.length, 2);
  assert.deepEqual(result.reconciliation.paths, ['merged.txt']);
  assert.equal(result.commits[0].parent, outside);
  assert.equal(result.commits[0].state, latest.view.head);
  const empty = externalCommit(f);
  const adopted = await f.sync({ push: true });
  assert.deepEqual(adopted.reconciliation.paths, []);
  assert.equal(adopted.commits[0].parent, empty);
  assert.equal(adopted.commits[0].state, latest.view.head);
});

test('contained external edits adopt after Forge edits the same file further', async t => {
  const f = fixture(t),
    base = 'runtime: old\n\nkeep this section\n\ntest: old\n',
    external = base.replace('runtime: old', 'runtime: secure'),
    current = external.replace('test: old', 'test: deterministic');
  f.accept('Shared multiline base', { 'a.txt': base });
  await f.sync({ push: true });
  const outside = externalCommit(f, { 'a.txt': external }, 'squash');
  f.accept('Same runtime fix', { 'a.txt': external });
  const latest = f.accept('Later deterministic test fix', { 'a.txt': current });
  const before = f.work.store.snapshotBytes(),
    plan = await f.sync();
  assert.equal(plan.reconciliation.status, 'contained');
  assert.deepEqual(plan.reconciliation.missingPathReasons, []);
  assert.equal(plan.commits[0].parent, outside);
  assert.equal(plan.commits[0].state, latest.view.head);
  assert.deepEqual(f.work.store.snapshotBytes(), before);
  const result = await f.sync({ push: true });
  assert.equal(result.reconciliation.status, 'contained');
  assert.equal(git(f.remote, ['rev-parse', 'main^']).trim(), outside);
  assert.equal(git(f.remote, ['show', 'main:a.txt']), current);
});

test('a missing external hunk refuses only its path even when other external paths are contained', async t => {
  const f = fixture(t),
    base = 'runtime: old\n\nkeep this section\n\ntest: old\n';
  f.accept('Shared multiline base', { 'a.txt': base });
  await f.sync({ push: true });
  const outside = externalCommit(f, {
    'a.txt': base.replace('runtime: old', 'runtime: secure'),
    'already-contained.txt': 'Same change\n',
  });
  f.accept('Later test edit without external runtime fix', {
    'a.txt': base.replace('test: old', 'test: deterministic'),
    'already-contained.txt': 'Same change\n',
  });
  const before = f.work.store.snapshotBytes();
  for (const push of [false, true]) {
    await assert.rejects(f.sync({ push }), error => {
      assert.equal(error.code, 'GITHUB_SYNC_CHANGED');
      assert.deepEqual(error.reconciliation.missingPaths, ['a.txt']);
      assert.deepEqual(error.reconciliation.missingPathReasons, [
        { path: 'a.txt', reason: 'merge would change Forge content' },
      ]);
      assert.ok(!error.message.includes('already-contained.txt'));
      assert.match(error.message, /merge would change Forge content/);
      return true;
    });
    if (!push) assert.deepEqual(f.work.store.snapshotBytes(), before);
  }
  assert.equal(f.head(), outside);
  assert.equal(f.controlState().pushes, 1);
});

test('a superseded exact accepted main version proves historical containment', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const outside = externalCommit(f, { 'a.txt': 'Security fix\n' }),
    historical = f.accept('Same external security fix', { 'a.txt': 'Security fix\n' });
  f.accept('Later replacement after security fix', { 'a.txt': 'Further accepted edit\n' });
  const plan = await f.sync();
  assert.equal(plan.reconciliation.status, 'contained');
  assert.deepEqual(plan.reconciliation.historyProofs, [
    {
      kind: 'accepted-main',
      path: 'a.txt',
      state: historical.view.head,
      acceptanceId: historical.move.id,
      viewId: historical.view.id,
    },
  ]);
  await f.sync({ push: true });
  assert.equal(git(f.remote, ['rev-parse', 'main^']).trim(), outside);
  assert.equal(git(f.remote, ['show', 'main:a.txt']), 'Further accepted edit\n');
});

test('a superseded saved version of an accepted Lane proves add/add containment', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const outside = externalCommit(f, { 'new-test.txt': 'Original external test\n' }),
    accepted = f.accept(
      'Node fix with later deterministic test edit',
      {
        'new-test.txt': 'Later deterministic test\n',
      },
      undefined,
      [{ 'new-test.txt': 'Original external test\n' }],
    ),
    before = f.work.store.snapshotBytes(),
    plan = await f.sync(),
    lane = f.work.store.load().lanes.find(lane => lane.id === accepted.view.inputs[0].laneId);
  assert.equal(plan.reconciliation.status, 'contained');
  assert.deepEqual(plan.reconciliation.historyProofs, [
    {
      kind: 'accepted-lane-checkpoint',
      path: 'new-test.txt',
      state: lane.checkpoints[0].head,
      acceptanceId: accepted.move.id,
      viewId: accepted.view.id,
      laneId: lane.id,
      checkpoint: 0,
    },
  ]);
  assert.deepEqual(f.work.store.snapshotBytes(), before);
  await f.sync({ push: true });
  assert.equal(git(f.remote, ['rev-parse', 'main^']).trim(), outside);
  assert.equal(git(f.remote, ['show', 'main:new-test.txt']), 'Later deterministic test\n');
});

test('conflicting external edits refuse with a per-path conflict reason', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const outside = externalCommit(f, { 'a.txt': 'External replacement\n' });
  f.accept('Conflicting native replacement', { 'a.txt': 'Forge replacement\n' });
  for (const push of [false, true]) {
    await assert.rejects(f.sync({ push }), error => {
      assert.equal(error.code, 'GITHUB_SYNC_CHANGED');
      assert.deepEqual(error.reconciliation.missingPaths, ['a.txt']);
      assert.deepEqual(error.reconciliation.missingPathReasons, [
        { path: 'a.txt', reason: 'content conflicts or cannot be merged as text' },
      ]);
      assert.match(error.message, /content conflicts/);
      return true;
    });
  }
  assert.equal(f.head(), outside);
  assert.equal(f.controlState().pushes, 1);
});

test('uncontained GitHub commits report paths and a contribution import route in dry-run and push', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const outside = externalCommit(f, { 'external only.txt': 'Preserve this\n' }),
    before = f.work.store.snapshotBytes(),
    binding = f.work.store.load().githubSync;
  for (const push of [false, true]) {
    await assert.rejects(f.sync({ push }), error => {
      assert.equal(error.code, 'GITHUB_SYNC_CHANGED');
      assert.equal(error.reconciliation.status, 'not-contained');
      assert.deepEqual(error.reconciliation.missingPaths, ['external only.txt']);
      assert.ok(error.message.includes(outside));
      assert.match(error.message, /external only\.txt/);
      assert.match(error.message, /nforge agent ROOT start/);
      return true;
    });
    if (!push) assert.deepEqual(f.work.store.snapshotBytes(), before);
  }
  assert.equal(f.head(), outside);
  assert.deepEqual(f.work.store.load().githubSync, binding);
  assert.equal(f.controlState().pushes, 1);
});

test('a rewritten GitHub head is refused even when its tree equals Forge main', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const original = f.head(),
    rewritten = git(f.remote, ['commit-tree', `${original}^{tree}`, '-m', 'Unrelated root']).trim(),
    before = f.work.store.snapshotBytes(),
    binding = f.work.store.load().githubSync;
  git(f.remote, ['update-ref', 'refs/heads/main', rewritten]);
  for (const push of [false, true]) {
    await assert.rejects(f.sync({ push }), error => {
      assert.equal(error.code, 'GITHUB_SYNC_CHANGED');
      assert.equal(error.reconciliation.status, 'rewritten');
      assert.match(error.message, /history was rewritten/);
      return true;
    });
    if (!push) assert.deepEqual(f.work.store.snapshotBytes(), before);
  }
  assert.equal(f.head(), rewritten);
  assert.deepEqual(f.work.store.load().githubSync, binding);
  assert.equal(f.controlState().pushes, 1);
});

test('an adoption exact lease refuses a second GitHub move and retains the original batch', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const outside = externalCommit(f),
    raced = git(f.remote, [
      'commit-tree',
      `${outside}^{tree}`,
      '-p',
      outside,
      '-m',
      'Concurrent GitHub merge',
    ]).trim(),
    operationId = randomUUID();
  f.change({ raceHead: raced });
  await assert.rejects(f.sync({ push: true, operationId }), code('GITHUB_SYNC_CHANGED'));
  assert.equal(f.head(), raced);
  const binding = f.work.store.load().githubSync;
  assert.equal(binding.pushed, 1);
  assert.equal(binding.commits.length, 2);
  assert.equal(binding.commits[1].parent, outside);
  assert.equal(binding.commits[1].operationId, operationId);
  assert.equal(f.controlState().pushLeases.at(-1), `--force-with-lease=refs/heads/main:${outside}`);
});

test('lost adoption reply replays its original operation after later acceptances and syncs', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const outside = externalCommit(f, { 'a.txt': 'Contained\n' });
  f.accept('Contained change', { 'a.txt': 'Contained\n' });
  const operationId = randomUUID();
  f.change({ lostReply: true });
  await assert.rejects(f.sync({ push: true, operationId }), code('GITHUB_SYNC_GIT_FAILED'));
  const adopted = f.head(),
    pending = f.work.store.load().githubSync.commits[1];
  assert.equal(pending.parent, outside);
  assert.equal(pending.commit, adopted);
  const next = f.accept('After lost reply', { 'after.txt': 'Later\n' });
  assert.equal((await f.sync({ push: true, operationId })).alreadyPushed, true);
  assert.deepEqual(f.work.store.load().githubSync.commits[1], pending);
  assert.equal(f.controlState().pushes, 2);
  const result = await f.sync({ push: true });
  assert.equal(result.commits[0].state, next.view.head);
  assert.equal(result.commits[0].parent, adopted);
  assert.equal((await f.sync({ push: true, operationId })).alreadyPushed, true);
  assert.equal(f.controlState().pushes, 3);
});

test('a rejected adoption retries its saved external parent without changing the operation', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const outside = externalCommit(f),
    operationId = randomUUID();
  f.change({ permanentPush: true });
  await assert.rejects(f.sync({ push: true, operationId }), code('GITHUB_SYNC_GIT_FAILED'));
  const pending = f.work.store.load().githubSync.commits[1];
  assert.equal(f.head(), outside);
  f.change({ permanentPush: false });
  const result = await f.sync({ push: true, operationId });
  assert.equal(result.commits[0].commit, pending.commit);
  assert.equal(f.head(), pending.commit);
  assert.deepEqual(f.work.store.load().githubSync.commits[1], pending);
});

test('auto-push resumes a paused mirror when native main contains the external merge', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const outside = externalCommit(f, { 'a.txt': 'Security fix\n' }, 'squash');
  const missing = f.accept('Native work before import', { 'native.txt': 'Native\n' });
  await green(f, missing.view);
  await mirrorPolicy(f);
  await drain(f);
  assert.equal(f.work.store.load().githubAutoPush.status, 'needs-you');
  const latest = f.accept('Same security fix in main', { 'a.txt': 'Security fix\n' });
  await green(f, latest.view);
  await drain(f);
  await until(() => f.work.store.load().githubAutoPush.status === 'pushed');
  assert.equal(git(f.remote, ['rev-parse', 'main^']).trim(), outside);
  assert.equal(git(f.remote, ['show', 'main:a.txt']), 'Security fix\n');
  assert.equal(git(f.remote, ['show', 'main:native.txt']), 'Native\n');
  assert.equal(f.work.store.load().githubAutoPush.detail, '');
});

test('containment includes binary content, deletions and renames', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const binary = Buffer.from([0, 255, 8, 0, 1]);
  const files = { 'binary.dat': binary, 'acceptance.txt': null, 'renamed.txt': 'First acceptance\n' };
  const outside = externalCommit(f, files);
  f.accept('Binary and rename from GitHub', files);
  const result = await f.sync({ push: true });
  assert.equal(result.reconciliation.status, 'contained');
  assert.equal(result.commits[0].parent, outside);
  assert.deepEqual(result.reconciliation.paths, ['acceptance.txt', 'binary.dat', 'renamed.txt']);
  assert.equal(
    git(f.remote, ['rev-parse', 'main:binary.dat']).trim(),
    git(f.remote, ['rev-parse', `${outside}:binary.dat`]).trim(),
  );
  assert.equal(git(f.remote, ['ls-tree', 'main', 'acceptance.txt']), '');
});

test('containment refuses a mode-only change even when the bytes match', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const checkout = join(f.temporary, 'mode-checkout');
  git(f.temporary, ['clone', '-q', f.remote, checkout]);
  git(checkout, ['update-index', '--chmod=+x', 'a.txt']);
  git(checkout, ['commit', '-qm', 'External executable mode']);
  git(f.remote, ['fetch', '--no-tags', checkout, 'main:refs/heads/main']);
  const outside = f.head();
  await assert.rejects(f.sync({ push: true }), error => {
    assert.equal(error.code, 'GITHUB_SYNC_CHANGED');
    assert.deepEqual(error.reconciliation.missingPaths, ['a.txt']);
    return true;
  });
  assert.equal(f.head(), outside);
  assert.equal(f.controlState().pushes, 1);
});

test('unaccepted native content cannot satisfy containment', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const outside = externalCommit(f, { 'a.txt': 'External change\n' });
  write(f.owner, 'a.txt', 'External change\n');
  await assert.rejects(f.sync({ push: true }), error => {
    assert.equal(error.code, 'GITHUB_SYNC_CHANGED');
    assert.deepEqual(error.reconciliation.missingPaths, ['a.txt']);
    return true;
  });
  assert.equal(f.head(), outside);
});

async function heldAudit(f) {
  let release, admitted;
  const ready = new Promise(resolve => {
    admitted = resolve;
  });
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const pending = withQueueSlot(
    join(f.work.store.directory, 'post-accept-main-queue'),
    async () => {
      admitted();
      await gate;
    },
    { anchor: f.work.store.directory },
  );
  await ready;
  return async () => {
    release();
    await pending;
  };
}

function syncChild(f, flags, onProgress = () => {}) {
  const child = spawn(
    process.execPath,
    [resolve('dist/cli.js'), 'github-sync', f.owner, '--repo', 'tests/sync', ...flags],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', bytes => {
    stdout += bytes;
  });
  child.stderr.on('data', bytes => {
    stderr += bytes;
    onProgress(stderr);
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', status => resolve({ status, stdout, stderr }));
  });
}

test('busy audit and expired --wait-audit always print a JSON no-push reason and nonzero exit', async t => {
  const f = fixture(t),
    old = f.head(),
    release = await heldAudit(f);
  try {
    for (const flags of [[], ['--wait-audit', '--audit-timeout-ms', '100']]) {
      const child = await syncChild(f, ['--push', ...flags]);
      assert.equal(child.status, 1, child.stderr);
      const result = JSON.parse(child.stdout);
      assert.equal(result.pushed, false);
      assert.equal(result.reason, flags.length ? 'GITHUB_SYNC_AUDIT_TIMEOUT' : 'WORK_BUSY');
      assert.equal(f.head(), old);
    }
  } finally {
    await release();
    await drainPostAccept(f.work.store);
  }
});

test('--wait-audit observes the retained worker, prints progress, then exports fresh main and pushes', async t => {
  const f = fixture(t),
    release = await heldAudit(f);
  let advanced = false;
  try {
    const child = await syncChild(f, ['--push', '--wait-audit'], stderr => {
      if (!advanced && stderr.includes('waiting for main audit')) {
        advanced = true;
        f.accept('Main advanced while waiting', { 'latest.txt': 'Latest accepted main\n' });
        void release();
      }
    });
    assert.equal(advanced, true);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).pushed, true);
    assert.match(child.stderr, /waiting for main audit/);
    assert.equal(git(f.remote, ['show', 'main:latest.txt']), 'Latest accepted main\n');
    assert.equal(f.work.store.load().runs.filter(r => r.mainCheck).length, 1);
    assert.equal(f.controlState().pushes, 1);
  } finally {
    await release();
  }
});

test('up-to-date --push returns an explicit no-push reason and exits 0', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const child = await syncChild(f, ['--push', '--wait-audit']);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.pushed, false);
  assert.equal(result.reason, 'nothing-to-push');
  assert.equal(f.controlState().pushes, 1);
});

test('CLI no-push validation failures return JSON on stdout and never silently succeed', async t => {
  const f = fixture(t);
  const child = await syncChild(f, ['--push', '--audit-timeout-ms', 'invalid']);
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).reason, 'BAD_ARGUMENT');
  assert.equal(f.controlState().pushes, undefined);
});

test('an asynchronous sync with no completion cannot produce empty stdout and exit zero', async t => {
  const f = fixture(t);
  const loader = join(f.temporary, 'incomplete-sync.mjs');
  writeFileSync(
    loader,
    `import { registerHooks } from 'node:module';
registerHooks({load(url, context, next) {
 if (url.endsWith('/github-sync-cli.js')) return {format:'module',shortCircuit:true,source:'export const githubSyncCli = () => new Promise(() => {});'};
 return next(url, context);
}});`,
  );
  const child = spawnSync(
    process.execPath,
    ['--import', loader, resolve('dist/cli.js'), 'github-sync', f.owner, '--push'],
    { encoding: 'utf8' },
  );
  assert.notEqual(child.status, 0);
  assert.equal(JSON.parse(child.stdout).reason, 'GITHUB_SYNC_INCOMPLETE');
});

test('--wait-audit timeout exits while its newly started audit continues under the same run', async t => {
  const { createServer } = await import('node:net');
  const { once } = await import('node:events');
  const f = fixture(t),
    endpoint = join(f.temporary, 'audit-gate');
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
  });
  server.listen(endpoint);
  await once(server, 'listening');
  f.work.execute(
    {
      action: 'define-check',
      checkId: f.work.store.load().checks[0].id,
      name: 'verify',
      executable: process.execPath,
      args: [
        '-e',
        `require('net').connect(${JSON.stringify(endpoint)}).on('end',()=>process.exit(0)).resume()`,
      ],
    },
    f.work.store.revision(),
  );
  try {
    // Give the worker admission time independently of the observation deadline:
    // stdout progress acknowledges that it is retained; the socket proves execution.
    const pending = syncChild(f, ['--push', '--wait-audit', '--audit-timeout-ms', '3000']);
    await untilWorker({ store: f.work.store }, () => sockets.size > 0, 'retained audit starts');
    const runId = f.work.store.load().runs.find(run => run.mainCheck).id;
    const child = await pending;
    assert.equal(child.status, 1, child.stderr);
    assert.equal(JSON.parse(child.stdout).reason, 'GITHUB_SYNC_AUDIT_TIMEOUT');
    // The socket proves execution; its running progress record can still be
    // queued behind another writer. Timeout must retain that same live run.
    const retained = f.work.store.load().runs.find(run => run.id === runId);
    assert.ok(['preparing', 'running'].includes(retained.status));
    assert.equal(retained.endedAt, undefined);
    assert.ok(!retained.cancelRequested);
    for (const socket of sockets) socket.end();
    await drainPostAccept(f.work.store);
    assert.equal(f.work.store.load().runs.filter(run => run.mainCheck).length, 1);
    assert.equal(f.work.store.load().runs.find(run => run.id === runId).status, 'passed');
    assert.equal(f.controlState().pushes, undefined);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
    await drainPostAccept(f.work.store);
  }
});

// Incident 2026-10-24: re-landed old entries made accepted moves with head == previous,
// and each one became a 0-file GitHub commit titled after the old Lane.
test('accepted moves with no source change advance the cursor and never push an empty commit', async t => {
  const f = fixture(t);
  await f.sync({ push: true });
  const adopted = f.head(),
    pushes = f.controlState().pushes;
  const noop = () =>
    f.work.execute(
      {
        action: 'accept-channel',
        operationId: randomUUID(),
        channel: 'main',
        viewId: f.first.view.id,
        expectedHead: f.first.view.head,
        expectedPrevious: f.first.view.head,
      },
      f.work.store.revision(),
    ).result;
  const repeats = [noop(), noop(), noop()];
  // A different head with the same published tree is no change either.
  const sameTree = f.accept('Edit then revert', { 'a.txt': 'Accepted source\n' }, undefined, [
    { 'a.txt': 'Temporary\n' },
  ]);
  assert.notEqual(sameTree.move.head, f.first.view.head);
  const dry = await f.sync();
  assert.equal(dry.commits.length, 0);
  assert.deepEqual(
    dry.skipped.map(item => item.acceptanceId),
    [...repeats.map(move => move.id), sameTree.move.id],
  );
  assert.equal(f.work.store.load().githubSync.cursor, undefined);
  const pushed = await f.sync({ push: true });
  assert.equal(pushed.commits.length, 0);
  assert.equal(f.head(), adopted);
  assert.equal(f.controlState().pushes, pushes);
  const binding = f.work.store.load().githubSync;
  assert.equal(binding.commits.length, 1);
  assert.deepEqual(binding.cursor, { acceptanceId: sameTree.move.id, state: sameTree.move.head });
  // Nothing pending: the auto-push worker neither loops nor pushes.
  await green(f, sameTree.view);
  await mirrorPolicy(f);
  assert.equal(pendingGithubPush(f.work.store.load()), false);
  await drain(f);
  assert.equal(f.controlState().pushes, pushes);
  // A real change after skipped moves parents on the last published commit.
  const real = f.accept('Real change after no-ops', { 'b.txt': 'Real\n' });
  noop2(f, real);
  const next = await f.sync({ push: true });
  assert.equal(next.commits.length, 1);
  assert.equal(next.commits[0].parent, adopted);
  assert.equal(next.commits[0].acceptanceId, real.move.id);
  assert.ok(next.commits[0].filesChanged > 0);
  assert.equal(next.skipped.length, 1);
  assert.equal(f.work.store.load().githubSync.cursor.acceptanceId, next.skipped[0].acceptanceId);
});
function noop2(f, accepted) {
  return f.work.execute(
    {
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: accepted.view.id,
      expectedHead: accepted.view.head,
      expectedPrevious: accepted.view.head,
    },
    f.work.store.revision(),
  ).result;
}
