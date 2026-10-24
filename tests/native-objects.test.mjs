// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { LegacyWorkService as WorkService } from './autonomy-fixture.mjs';
import { initLegacyNative as initNative } from './autonomy-fixture.mjs';
import { NativeSource } from '../dist/native-source.js';
import { withWorkLockOptions } from '../dist/work-lock.js';
import { nativeObjects } from '../dist/native-objects.js';
import { restoreNativeWork } from '../dist/native-backup.js';
import { prepareNativeProjection, importNativeGit } from '../dist/native-git.js';
import { digest } from '../dist/hash.js';
import { setup as publicationFixture } from './publication-fixture.mjs';
import { fixture, git, code } from './helpers.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { serveRepository } from '../dist/http.js';

function setup(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'forge-objects-')),
    root = join(dir, 'owner');
  fs.mkdirSync(root);
  fs.writeFileSync(join(root, 'a.ts'), 'export const a=1;\n');
  initNative(root);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = new WorkService(root),
    source = new NativeSource(root),
    act = c => w.execute(c, w.store.load().revision).result,
    call = c => w.dispatch(c, w.store.load().revision);
  const intent = act({ action: 'intent', outcome: 'Collection' }),
    lane = act({ action: 'lane', intentId: intent.id, name: 'Preserved' }),
    view = act({
      action: 'compose',
      operationId: randomUUID(),
      intentId: intent.id,
      inputs: [{ laneId: lane.id, head: lane.head }],
    });
  return {
    dir,
    root,
    w,
    source,
    act,
    call,
    intent,
    lane,
    view,
    collect: () => nativeObjects(w.store, { action: 'collect-native-objects' }),
    inspect: () => nativeObjects(w.store, { action: 'inspect-native-objects' }),
  };
}

test('inspection preserves format and collection retains all old source, dirty work, private evidence and fresh Git-free restore', async t => {
  const f = setup(t),
    workFile = join(f.w.store.directory, 'work.json'),
    before = fs.readFileSync(workFile),
    orphan = f.source.put(Buffer.from('orphan bytes'));
  fs.writeFileSync(join(f.w.store.path(f.lane.id), 'a.ts'), 'dirty workspace\n');
  fs.writeFileSync(join(f.source.directory, 'temporary.tmp'), 'unfinished');
  fs.writeFileSync(join(f.source.directory, 'f'.repeat(64)), 'invalid digest');
  const linked = f.source.put(Buffer.from('linked object'));
  fs.linkSync(join(f.source.directory, linked), join(f.dir, 'linked-copy'));
  const scan = f.inspect();
  assert.deepEqual(fs.readFileSync(workFile), before);
  assert.equal(scan.result.format, 1);
  assert.deepEqual(
    scan.result.candidates.map(x => x.id),
    [orphan],
  );
  assert.equal(scan.result.preserved.length, 3);
  // New committed source since the old scan must be kept by the fresh collection.
  const current = f.w.status().lanes[0];
  f.act({
    action: 'checkpoint',
    laneId: f.lane.id,
    expectedHead: current.head,
    expectedTree: current.indexTree,
    message: 'New source after inspect',
  });
  const later = f.act({
    action: 'compose',
    operationId: randomUUID(),
    intentId: f.intent.id,
    inputs: [{ laneId: f.lane.id, head: f.w.store.load().lanes[0].head }],
  });
  await f.call({
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'main',
    viewId: later.id,
    expectedHead: later.head,
    expectedPrevious: null,
  });
  const check = f.act({
    action: 'define-check',
    name: 'Evidence',
    executable: process.execPath,
    args: ['-e', 'console.log("retained evidence")'],
  });
  const run = (
    await f.call({
      action: 'run-check',
      operationId: randomUUID(),
      viewId: later.id,
      expectedHead: later.head,
      checkId: check.id,
      expectedDefinition: check.definition,
      expectedEnvironment: f.w.status().environment.fingerprint,
    })
  ).result;
  for (let i = 0; i < 150 && !f.w.status().runs[0].endedAt; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(f.w.store.load().runs[0].status, 'passed');
  const log = join(f.w.store.directory, 'check-' + run.id, 'stdout.log'),
    logBytes = fs.readFileSync(log);
  fs.writeFileSync(join(f.w.store.path(f.lane.id), 'a.ts'), 'still dirty\n');
  const collected = f.collect();
  assert.equal(collected.result.format, 12); // the new checkpoint records its actor
  assert.deepEqual(
    collected.result.removed.map(x => x.id),
    [orphan],
  );
  assert.equal(f.source.state(f.view.head).files.length, 1);
  assert.ok(f.source.state(later.head));
  assert.equal(fs.readFileSync(join(f.w.store.path(f.lane.id), 'a.ts'), 'utf8'), 'still dirty\n');
  assert.deepEqual(fs.readFileSync(log), logBytes);
  assert.equal(fs.existsSync(join(f.source.directory, linked)), true);
  assert.deepEqual(f.collect().result.removed, []);
  const backup = (await f.call({ action: 'export-work', archive: true })).result;
  const bin = join(f.dir, 'bin'),
    marker = join(f.dir, 'git-called');
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, 'git'), `#!/bin/sh\ntouch '${marker}'\nexit 99\n`, { mode: 0o700 });
  const path = process.env.PATH;
  process.env.PATH = bin + ':' + path;
  try {
    const restored = join(f.dir, 'restored');
    await restoreNativeWork(backup.archive.path, restored);
    const restoredWork = new WorkService(restored).store.load();
    assert.equal(restoredWork.schema, 12);
    assert.equal(restoredWork.lanes[0].checkpoints.at(-1).actor.kind, 'person');
    assert.deepEqual(
      fs.readFileSync(join(restored, '.forge/work', 'check-' + run.id, 'stdout.log')),
      logBytes,
    );
    assert.equal(fs.existsSync(marker), false);
  } finally {
    process.env.PATH = path;
  }
});

test('invalid retained closure blocks every deletion; interrupted collection and lost format-upgrade replies reconcile', t => {
  const f = setup(t),
    a = f.source.put(Buffer.from('orphan a')),
    b = f.source.put(Buffer.from('orphan b')),
    head = f.w.store.load().nativeHead,
    headPath = join(f.source.directory, head),
    original = fs.readFileSync(headPath);
  fs.writeFileSync(headPath, 'corrupt');
  assert.throws(f.collect, code('INVALID_NATIVE_SOURCE'));
  assert.equal(f.w.store.load().schema, 1);
  assert.equal(fs.existsSync(join(f.source.directory, a)), true);
  fs.writeFileSync(headPath, original);
  const save = f.w.store.save.bind(f.w.store);
  f.w.store.save = data => {
    save(data);
    throw Error('Lost upgrade reply');
  };
  assert.throws(f.collect, /Lost upgrade reply/);
  f.w.store.save = save;
  assert.equal(f.w.store.load().schema, 3);
  assert.equal(fs.existsSync(join(f.source.directory, a)), true);
  const unlink = fs.unlinkSync;
  let deleted = 0;
  fs.unlinkSync = function (path) {
    if (String(path).startsWith(f.source.directory + '/')) {
      if (deleted++) throw Error('Interrupted sweep');
    }
    return unlink(path);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(f.collect, /Interrupted sweep/);
  } finally {
    fs.unlinkSync = unlink;
    syncBuiltinESMExports();
  }
  assert.equal([a, b].filter(id => fs.existsSync(join(f.source.directory, id))).length, 1);
  assert.equal(f.collect().result.removed.length, 1);
  assert.ok(f.source.state(head));
});

test('history insertion is locked and collected owners preserve format3, archive reachability and exact export', async t => {
  const f = setup(t),
    root = fixture(t, { 'a.ts': 'original' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Original']);
  const old = new WorkService(root),
    archive = (await old.dispatch({ action: 'export-work', archive: true }, 0)).result.archive;
  const accepted = (
    await f.call({
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: f.view.id,
      expectedHead: f.view.head,
      expectedPrevious: null,
    })
  ).result;
  f.collect();
  const put = NativeSource.prototype.put;
  let writes = 0;
  NativeSource.prototype.put = function (bytes) {
    if (this.owner === f.w.store.root) {
      writes++;
      assert.throws(() => withWorkLockOptions({ waitMs: 0 }, f.collect), code('WORK_BUSY'));
    }
    return put.call(this, bytes);
  };
  let record;
  try {
    record = (
      await f.call({
        action: 'import-work-history',
        operationId: randomUUID(),
        path: archive.path,
        sha256: archive.sha256,
        name: 'History',
        acceptanceId: accepted.id,
        expectedHead: accepted.head,
      })
    ).result;
  } finally {
    NativeSource.prototype.put = put;
  }
  assert.equal(writes, 1);
  assert.equal(f.w.store.load().schema, 3);
  assert.deepEqual(f.collect().result.removed, []);
  assert.deepEqual(
    fs.readFileSync((await f.call({ action: 'export-work-history', id: record.id })).result.path),
    fs.readFileSync(archive.path),
  );
});

test('prepared projection survives collection before registration and publication/provider bundles insert only under Work lock', async t => {
  const fixture = publicationFixture(t),
    root = join(fixture.root, '.git/native-gc');
  await importNativeGit(fixture.root, fixture.command.expectedHead, root);
  const w = new WorkService(root),
    act = c => w.execute(c, w.store.load().revision).result;
  const i = act({ action: 'intent', outcome: 'Native publication' }),
    l = act({ action: 'lane', intentId: i.id, name: 'Publish' }),
    v = act({ action: 'compose', intentId: i.id, inputs: [{ laneId: l.id, head: l.head }] }),
    collect = () => nativeObjects(w.store, { action: 'collect-native-objects' });
  collect();
  const prepared = await prepareNativeProjection(w.store, v.head);
  assert.equal(fs.existsSync(join(w.store.directory, 'objects', prepared.projection.mapping)), false);
  collect();
  // Prepared source is process-private until actual publication registers it.
  const put = NativeSource.prototype.put;
  let writes = 0;
  NativeSource.prototype.put = function (bytes) {
    if (this.owner === w.store.root) {
      writes++;
      assert.throws(() => withWorkLockOptions({ waitMs: 0 }, collect), code('WORK_BUSY'));
    }
    return put.call(this, bytes);
  };
  const locked = w.store.locked.bind(w.store);
  let entering = false;
  w.store.locked = fn => {
    if (!entering) {
      entering = true;
      try {
        collect();
      } finally {
        entering = false;
      }
    }
    return locked(fn);
  };
  try {
    const command = { ...fixture.command, operationId: randomUUID(), viewId: v.id, expectedHead: v.head };
    const pub = (await w.dispatch(command, w.store.load().revision)).result;
    assert.equal(writes, 2);
    collect();
    const base = git(fixture.remote, ['rev-parse', 'main']).trim(),
      accepted = git(fixture.remote, [
        'commit-tree',
        `${pub.projection.head}^{tree}`,
        '-p',
        base,
        '-m',
        'Merge',
      ]).trim();
    git(fixture.remote, ['update-ref', 'refs/heads/main', accepted]);
    const pulls = fixture.state().pulls;
    Object.assign(pulls[0], {
      state: 'closed',
      merged: true,
      merged_at: new Date().toISOString(),
      merge_commit_sha: accepted,
    });
    fixture.change({ pulls });
    const observed = (
      await w.dispatch({ action: 'check-publication', publicationId: pub.id }, 0)
    ).result.checks.at(-1);
    assert.equal(observed.acceptance, 'accepted');
    assert.equal(writes, 3);
    collect();
    assert.equal(digest(new NativeSource(root).object(observed.bundle)), observed.bundle);
  } finally {
    NativeSource.prototype.put = put;
    w.store.locked = locked;
  }
});

test('HTTP and CLI expose explicit collection while schema1/2 owners remain unchanged until collect', async t => {
  const f = setup(t),
    server = await serveRepository(f.root, 0);
  t.after(() => server.close());
  const url = new URL(server.url),
    token = new URLSearchParams(url.hash.slice(1)).get('token');
  const body = JSON.stringify({ revision: 0, command: { action: 'collect-native-objects' } });
  assert.equal(
    (
      await fetch(url.origin + '/api/work', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
    ).status,
    401,
  );
  assert.equal(f.w.store.load().schema, 1);
  const cli = JSON.parse(
    execFileSync(
      process.execPath,
      [resolve('dist/cli.js'), 'work', f.root, JSON.stringify({ action: 'inspect-native-objects' }), '0'],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(cli.result.format, 1);
  const response = await fetch(url.origin + '/api/work', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.format, 3);
  const client = new Client({ name: 'native-object-acceptance', version: '1' }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/cli.js'), 'mcp', f.root, '--work'],
      env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      stderr: 'pipe',
    });
  await client.connect(transport);
  t.after(() => client.close());
  const inspected = await client.callTool({
    name: 'forge_work_command',
    arguments: { revision: 0, command: { action: 'inspect-native-objects' } },
  });
  assert.equal(JSON.parse(inspected.content[0].text).result.format, 3);
  const collected = await client.callTool({
    name: 'forge_work_command',
    arguments: { revision: 0, command: { action: 'collect-native-objects' } },
  });
  assert.deepEqual(JSON.parse(collected.content[0].text).result.removed, []);
});

// Supply an actual prior build for release acceptance; do not imitate its parser here.
test(
  'previous compiled CLI rejects format3 before mutating Work',
  { skip: !process.env.FORGE_LEGACY_CLI },
  async t => {
    const f = setup(t),
      legacy = process.env.FORGE_LEGACY_CLI,
      path = join(f.w.store.directory, 'work.json');
    const command = {
      action: 'note',
      intentId: f.intent.id,
      kind: 'comment',
      text: 'Must not reach old writer',
    };
    const rejected = () => {
      const bytes = fs.readFileSync(path),
        revision = f.w.store.load().revision;
      const result = spawnSync(
        process.execPath,
        [legacy, 'work', f.root, JSON.stringify(command), String(revision)],
        { encoding: 'utf8' },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /INVALID_WORK_STORE/);
      assert.deepEqual(fs.readFileSync(path), bytes);
    };
    // The old executable rejects the new physical layout even when its portable data is supported.
    assert.equal(JSON.parse(fs.readFileSync(path)).schema, 'forge-work-records-v2');
    rejected();
    const supported = f.w.store.snapshotBytes();
    fs.writeFileSync(path, supported);
    const initial = spawnSync(process.execPath, [legacy, 'work', f.root, '--compact'], { encoding: 'utf8' });
    assert.equal(initial.status, 0, initial.stderr);
    assert.deepEqual(fs.readFileSync(path), supported);
    f.collect();
    assert.equal(f.w.store.load().schema, 3);
    assert.equal(JSON.parse(fs.readFileSync(path)).schema, 'forge-work-records-v2');
    rejected();
    // Portable format3 must also be rejected: do not accidentally test only the storage marker.
    const unsupported = f.w.store.snapshotBytes();
    fs.writeFileSync(path, unsupported);
    rejected();
  },
);

test('separate collector respects live Work lock and recovers after process death between deletions', t => {
  const f = setup(t),
    cli = resolve('dist/cli.js'),
    command = JSON.stringify({ action: 'collect-native-objects' });
  f.w.store.locked(() => {
    const child = spawnSync(process.execPath, [cli, 'work', f.root, command, '0'], {
      encoding: 'utf8',
      env: { ...process.env, FORGE_WORK_LOCK_WAIT_MS: '0' },
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /WORK_BUSY/);
  });
  const ids = ['one', 'two', 'three'].map(value => f.source.put(Buffer.from('orphan ' + value)));
  const script = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {WorkStore} from ${JSON.stringify(new URL('../dist/work-store.js', import.meta.url).href)};import {nativeObjects} from ${JSON.stringify(new URL('../dist/native-objects.js', import.meta.url).href)};const original=fs.unlinkSync;fs.unlinkSync=function(path){original(path);if(String(path).includes('/objects/'))process.kill(process.pid,'SIGKILL');};syncBuiltinESMExports();nativeObjects(new WorkStore(process.argv[1]),{action:'collect-native-objects'});`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.root], {
    encoding: 'utf8',
  });
  assert.equal(killed.signal, 'SIGKILL');
  assert.equal(ids.filter(id => fs.existsSync(join(f.source.directory, id))).length, 2);
  assert.equal(f.collect().result.removed.length, 2);
  assert.ok(f.source.state(f.w.store.load().nativeHead));
});
