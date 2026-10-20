// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkService } from '../dist/work.js';
import { githubSync } from '../dist/github-sync.js';
import { drainGithubPush } from '../dist/github-auto-push.js';
import { checkEnvironment } from '../dist/work-run.js';
import { githubSyncCli } from '../dist/github-sync-cli.js';
import { git, write, code } from './helpers.mjs';

function fixture(t, flags = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'forge-github-sync-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const remote = join(temporary, 'remote.git'),
    seed = join(temporary, 'seed'),
    owner = join(temporary, 'native');
  mkdirSync(seed);
  git(seed, ['init', '-q', '--initial-branch=main']);
  write(seed, 'old.txt', 'Old GitHub source');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-qm', 'GitHub root']);
  git(seed, ['clone', '--bare', seed, remote]);
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
  const accept = (outcome, files = {}, acceptedBy) => {
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
    for (const [path, bytes] of Object.entries(files)) write(work.store.path(lane.id), path, bytes);
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
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim(),
    bin = join(temporary, 'bin'),
    control = join(temporary, 'control.json');
  mkdirSync(bin);
  writeFileSync(control, JSON.stringify(flags));
  writeFileSync(
    join(bin, 'git'),
    `#!${process.execPath}
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
const file=${JSON.stringify(control)}, remote=${JSON.stringify(remote)}, real=${JSON.stringify(realGit)};
const state=JSON.parse(readFileSync(file));
const prefix='https://github.com/tests/';
const args=process.argv.slice(2).map(a=>{if(!a.startsWith(prefix)||!a.endsWith('.git'))return a;const n=a.slice(prefix.length,-4);return n==='sync'?remote:${JSON.stringify(temporary)}+'/'+n+'.git';});
const save=()=>writeFileSync(file,JSON.stringify(state));
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
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  const sync = options => githubSync(owner, { repository: 'tests/sync', ...options });
  const head = () => git(remote, ['rev-parse', 'main']).trim();
  const controlState = () => JSON.parse(readFileSync(control));
  const change = values => writeFileSync(control, JSON.stringify({ ...controlState(), ...values }));
  const bare = name => {
    const path = join(temporary, `${name}.git`);
    git(temporary, ['init', '-q', '--bare', '--initial-branch=main', path]);
    return path;
  };
  return { temporary, bare, owner, remote, work, first, accept, sync, head, change, controlState };
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
  const outside = git(f.remote, [
    'commit-tree',
    `${synced}^{tree}`,
    '-p',
    synced,
    '-m',
    'Outside Forge',
  ]).trim();
  git(f.remote, ['update-ref', 'refs/heads/main', outside]);
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
  const child = execFileSync(
    process.execPath,
    [resolve('dist/cli.js'), 'github-sync', f.owner, '--dry-run'],
    { encoding: 'utf8' },
  );
  assert.equal(JSON.parse(child).commits.length, 0);
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

test('auto-push divergence records both heads as Needs you without replacing remote history', async t => {
  const f = fixture(t);
  await green(f);
  await f.sync({ push: true });
  const original = f.head();
  const latest = f.accept('New main', { 'a.txt': 'later' });
  await green(f, latest.view);
  const foreign = git(f.remote, [
    '-c',
    'user.name=Outside',
    '-c',
    'user.email=outside@example.test',
    'commit-tree',
    'main^{tree}',
    '-p',
    'main',
    '-m',
    'external change',
  ]).trim();
  git(f.remote, ['update-ref', 'refs/heads/main', foreign]);
  await mirrorPolicy(f);
  await drain(f);
  const status = f.work.store.load().githubAutoPush;
  assert.equal(status.status, 'needs-you');
  assert.equal(status.expectedHead, original);
  assert.equal(status.remoteHead, foreign);
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

test('automatic projection omits private tracked paths and never publishes Lane refs', async t => {
  const f = fixture(t),
    source = new NativeSource(f.owner);
  const data = f.work.store.load(),
    view = data.views.find(v => v.id === f.first.view.id);
  const files = [
    ...source.state(view.head).files,
    { path: '.env.production', blob: source.put(Buffer.from('synthetic-private')), mode: 'file' },
  ];
  const head = source.writeState(files, [view.head], 'private tracked fixture', new Date().toISOString());
  view.head = head;
  data.channelMoves.at(-1).head = head;
  f.work.store.save(data);
  await green(f, view);
  await mirrorPolicy(f);
  await drain(f);
  const paths = git(f.remote, ['ls-tree', '-r', '--name-only', 'main']);
  assert.equal(paths.includes('.env.production'), false);
  assert.ok(f.work.store.load().githubSync.commits[0].excludedPaths.includes('.env.production'));
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
  const before = f.head();
  const result = await f.sync({ push: true });
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
