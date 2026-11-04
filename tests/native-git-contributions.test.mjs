// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { LegacyWorkService as WorkService } from './autonomy-fixture.mjs';
import { initLegacyNative as initNative } from './autonomy-fixture.mjs';
import { NativeSource } from '../dist/native-source.js';
import { snapshotLane } from '../dist/lane-auto-snapshot.js';
import { importNativeGit, exportNativeGit } from '../dist/native-git.js';
import { restoreNativeWork } from '../dist/native-backup.js';
import { workGit } from '../dist/work-git.js';
import { importNativeGitContribution } from '../dist/native-git-contribution.js';
import { nativeGitContributionRequest } from '../dist/native-git-contribution.js';
import { exportNativeSource } from '../dist/native-backup.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer, request as httpRequest } from 'node:http';
const node = process.execPath,
  hash = b => createHash('sha256').update(b).digest('hex');
function git(root, args, { input, fail = false } = {}) {
  return new Promise((done, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-C', root, ...args],
      {
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'Original contributor',
          GIT_AUTHOR_EMAIL: 'claim@example.invalid',
          GIT_COMMITTER_NAME: 'Original committer',
          GIT_COMMITTER_EMAIL: 'claim@example.invalid',
        },
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        error
          ? fail
            ? done({ failed: true, stdout, stderr })
            : reject(
                Error(
                  `Git fixture failed (${error.code ?? ''}, ${error.signal ?? ''}, killed=${error.killed}): ` +
                    stderr,
                ),
              )
          : done(stdout),
    );
    child.stdin.end(input);
  });
}
async function fixture(t, kind = 'plain', { snapshotDirty = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-native-git-return-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(dir, 'owner');
  let rawBase;
  if (kind === 'plain') {
    mkdirSync(root);
    writeFileSync(join(root, 'a.ts'), 'export const a=1;\n');
    initNative(root);
  } else {
    const original = join(dir, 'original');
    mkdirSync(original);
    await git(original, ['init', '--template=', `--object-format=${kind}`, '--initial-branch=main']);
    writeFileSync(join(original, 'a.ts'), 'export const a=1;\n');
    writeFileSync(join(original, 'binary.bin'), Buffer.from([0, 255, 128]));
    writeFileSync(join(original, 'run.sh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(original, 'run.sh'), 0o700);
    await git(original, ['add', '.']);
    await git(original, ['commit', '-m', 'Original source']);
    const head = (await git(original, ['rev-parse', 'HEAD'])).trim();
    await git(original, ['branch', 'side', head]);
    await importNativeGit(original, head, root);
    rawBase = await git(original, ['cat-file', 'commit', head]);
  }
  const w = new WorkService(root),
    data = () => w.store.load(),
    act = c => w.execute(c, data().revision).result;
  const source = new NativeSource(root),
    initial = act({ action: 'intent', outcome: 'Accept initial source' }),
    first = act({ action: 'lane', intentId: initial.id, name: 'Initial' });
  const initialView = act({
    action: 'compose',
    operationId: randomUUID(),
    intentId: initial.id,
    inputs: [{ laneId: first.id, head: first.head }],
  });
  const acceptance = act({
    action: 'accept-channel',
    operationId: randomUUID(),
    viewId: initialView.id,
    expectedHead: initialView.head,
    expectedPrevious: null,
    channel: 'main',
  });
  const intent = act({
    action: 'intent',
    outcome: 'Native Git return',
    baseChannel: { name: 'main', head: acceptance.head, acceptanceId: acceptance.id },
  });
  const dirty = act({ action: 'lane', intentId: intent.id, name: 'Preserve owner work' });
  writeFileSync(join(w.store.path(dirty.id), 'a.ts'), 'Preserve unfinished owner edits\n');
  // The rejection test compares the complete object set. Establish the dirty
  // Lane's legitimate recovery objects before the owner observer can race it.
  if (snapshotDirty) assert.equal(snapshotLane(w.store, dirty.id).status, 'snapshot');
  const client = join(dir, 'client');
  const projected = await exportNativeGit(root, intent.base, join(dir, 'fixture-projection'));
  await git(dir, [
    'clone',
    '--template=',
    `--branch=forge-native/${intent.base}`,
    '--',
    projected.bundle.path,
    client,
  ]);
  return {
    dir,
    root,
    w,
    data,
    act,
    source,
    intent,
    dirty,
    client,
    acceptance,
    rawBase,
  };
}

async function candidate(
  f,
  { operationId = randomUUID(), name = 'Explicit native Git bundle', signed = false } = {},
) {
  writeFileSync(join(f.client, 'a.ts'), 'export const a=8;\n');
  await git(f.client, ['add', '.']);
  await git(f.client, ['commit', '-m', 'Original return']);
  let head = (await git(f.client, ['rev-parse', 'HEAD'])).trim();
  if (signed) {
    const tree = (await git(f.client, ['rev-parse', 'HEAD^{tree}'])).trim(),
      parent = (await git(f.client, ['rev-parse', 'HEAD^'])).trim();
    const raw = `tree ${tree}\nparent ${parent}\nauthor Original author <claim@example.invalid> 1700000000 +0000\ncommitter Original committer <claim@example.invalid> 1700000001 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n unverified-original-bytes\n -----END PGP SIGNATURE-----\n\nOriginal signature claim\n`;
    head = (await git(f.client, ['hash-object', '-w', '-t', 'commit', '--stdin'], { input: raw })).trim();
  }
  await git(f.client, ['update-ref', 'refs/heads/contribution', head]);
  const path = join(f.dir, operationId + '.bundle');
  await git(f.client, ['bundle', 'create', path, 'refs/heads/contribution']);
  chmodSync(path, 0o600);
  return {
    action: 'import-native-git-contribution',
    operationId,
    intentId: f.intent.id,
    expectedBase: f.intent.base,
    expectedHead: head,
    path,
    ref: 'refs/heads/contribution',
    sha256: hash(readFileSync(path)),
    name,
  };
}
const code = expected => error => error.code === expected;

test(
  'native Git bundle import preserves lost-reply creating recovery, dirty bytes, stale-owner protection and exact request reconciliation',
  { timeout: 120000 },
  async t => {
    const f = await fixture(t),
      command = await candidate(f, { signed: true }),
      revision = f.data().revision,
      before = f.data();
    const save = f.w.store.save.bind(f.w.store);
    let creatingSaved = false;
    f.w.store.save = data => {
      save(data);
      if (!creatingSaved) {
        creatingSaved = true;
        throw Error('lost creating reply');
      }
    };
    await assert.rejects(importNativeGitContribution(f.w.store, command, revision), /lost creating reply/);
    f.w.store.save = save;
    assert.equal(f.data().lanes.at(-1).state, 'creating');
    assert.equal(f.data().nativeContributionReceipts[0].request, nativeGitContributionRequest(command));
    const replay = await importNativeGitContribution(
      f.w.store,
      { ...command, path: '/missing-transient-bundle' },
      0,
    );
    assert.equal(replay.result.state, 'active');
    assert.equal(f.data().nativeContributionReceipts.length, 1);
    assert.deepEqual(f.data().channelMoves, before.channelMoves);
    assert.deepEqual(f.data().runs, before.runs);
    await assert.rejects(
      importNativeGitContribution(f.w.store, { ...command, name: 'Another request' }, 0),
      code('WORK_OPERATION_CHANGED'),
    );
    const bytes = readWorkBytes(join(f.w.store.directory, 'work.json'));
    await importNativeGitContribution(f.w.store, { ...command, path: '/still-missing' }, 0);
    assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), bytes);
    const projected = await exportNativeGit(f.root, replay.result.head, join(f.dir, 'signed-projection'));
    assert.equal(
      await git(join(projected.path, 'repository.git'), ['cat-file', 'commit', command.expectedHead]),
      await git(f.client, ['cat-file', 'commit', command.expectedHead]),
    );
    assert.deepEqual(
      f.source.object(f.data().nativeContributionReceipts[0].inputSha256),
      readFileSync(command.path),
    );
    const next = { ...command, operationId: randomUUID() },
      starting = f.data().revision,
      pending = importNativeGitContribution(f.w.store, next, starting);
    f.act({
      action: 'note',
      intentId: f.intent.id,
      kind: 'decision',
      text: 'Preserve concurrent original note',
    });
    const changed = readWorkBytes(join(f.w.store.directory, 'work.json'));
    await assert.rejects(pending, code('WORK_STALE'));
    assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), changed);
    assert.equal(f.data().nativeContributionReceipts.length, 1);
    let saves = 0;
    f.w.store.save = data => {
      saves++;
      if (saves === 2) throw Error('lost active registration');
      save(data);
    };
    await assert.rejects(
      importNativeGitContribution(f.w.store, next, f.data().revision),
      /lost active registration/,
    );
    f.w.store.save = save;
    assert.equal(f.data().lanes.at(-1).state, 'creating');
    const dirtyPath = join(f.w.store.path(next.operationId), 'a.ts');
    writeFileSync(dirtyPath, 'preserve later interrupted edit');
    const dirtyWork = readWorkBytes(join(f.w.store.directory, 'work.json'));
    await assert.rejects(
      importNativeGitContribution(f.w.store, { ...next, path: '/missing' }, 0),
      code('LANE_UNAVAILABLE'),
    );
    assert.equal(readFileSync(dirtyPath, 'utf8'), 'preserve later interrupted edit');
    assert.deepEqual(readWorkBytes(join(f.w.store.directory, 'work.json')), dirtyWork);
  },
);

test(
  'full format6 recovery and ordinary native operations keep Git optional; receipts/projections/input bundles survive collection',
  { timeout: 120000 },
  async t => {
    const f = await fixture(t, 'sha256'),
      command = await candidate(f),
      imported = (await f.w.dispatch(command, f.data().revision)).result;
    const receipt = f.data().nativeContributionReceipts[0],
      bin = join(f.dir, 'no-git'),
      used = join(bin, 'used');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\n/usr/bin/touch '${used}'\nexit 91\n`, { mode: 0o700 });
    for (const tool of ['tar', 'gzip']) symlinkSync(`/usr/bin/${tool}`, join(bin, tool));
    const priorPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      const selected = (await exportNativeSource(f.w.store, f.data().revision, imported.head)).result;
      const sourceTarget = join(f.dir, 'source-only');
      await restoreNativeWork(selected.archive.path, sourceTarget);
      const sourceOwner = new WorkService(sourceTarget);
      assert.equal(sourceOwner.store.load().schema, 24);
      assert.deepEqual(sourceOwner.store.load().nativeContributionReceipts ?? [], []);
      assert.equal(sourceOwner.store.load().intents.length, 0);
      assert.equal(new NativeSource(sourceTarget).state(imported.head).git.commit, command.expectedHead);
      const data = f.data(),
        archive = (await f.w.dispatch({ action: 'export-work', archive: true }, data.revision)).result;
      const target = join(f.dir, 'recovered-six');
      await restoreNativeWork(archive.archive.path, target);
      const recovered = new WorkService(target);
      assert.equal(recovered.store.load().schema, 24);
      assert.deepEqual(recovered.store.load().nativeContributionReceipts, [receipt]);
      const retry = await recovered.dispatch({ ...command, path: '/missing-after-recovery' }, 0);
      assert.equal(retry.result.id, imported.id);
      await recovered.dispatch({ action: 'collect-native-objects' }, recovered.store.load().revision);
      const current = recovered.status({ compact: true });
      assert.equal(current.capabilities.nativeSource, true);
      assert.equal(existsSync(used), false);
      const own = recovered.execute(
        { action: 'intent', outcome: 'Continue Git-free after Git return' },
        recovered.store.load().revision,
      ).result;
      const lane = recovered.execute(
        { action: 'lane', intentId: own.id, name: 'Git-free native source' },
        recovered.store.load().revision,
      ).result;
      writeFileSync(join(recovered.store.path(lane.id), 'new.ts'), 'export const native=true;\n');
      const source = new NativeSource(target);
      recovered.execute(
        {
          action: 'checkpoint',
          laneId: lane.id,
          expectedHead: lane.head,
          expectedTree: source.tree(source.capture(recovered.store.path(lane.id), false, lane.head)),
          message: 'Native source after Git return',
        },
        recovered.store.load().revision,
      );
      assert.equal(existsSync(used), false);
      for (const id of [
        receipt.inputSha256,
        receipt.bundleSha256,
        receipt.projection.bundle,
        receipt.projection.mapping,
      ])
        assert.equal(existsSync(join(source.directory, id)), true);
    } finally {
      process.env.PATH = priorPath;
    }
  },
);

test(
  'real local MCP and CLI select native Git return and reconcile its original source after losing the input path',
  { timeout: 120000 },
  async t => {
    const f = await fixture(t),
      command = await candidate(f),
      client = new Client({ name: 'native-git-return-proof', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/cli.js'), 'mcp', f.root, '--work'],
      env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      stderr: 'pipe',
    });
    await client.connect(transport);
    t.after(() => client.close());
    const reply = await client.callTool({
      name: 'forge_work_command',
      arguments: { command, revision: f.data().revision },
    });
    assert.equal(reply.isError, undefined);
    assert.equal(JSON.parse(reply.content[0].text).result.id, command.operationId);
    const file = join(f.dir, 'original-command.json');
    writeFileSync(file, JSON.stringify({ ...command, path: '/input-no-longer-present' }), { mode: 0o600 });
    const output = JSON.parse(
      execFileSync(node, [resolve('dist/cli.js'), 'work', f.root, '--command-file', file, '0'], {
        encoding: 'utf8',
        timeout: 30000,
      }),
    );
    assert.equal(output.result.id, command.operationId);
    assert.equal(f.data().nativeContributionReceipts.length, 1);
    assert.equal(f.data().channelMoves.length, 1);
  },
);
