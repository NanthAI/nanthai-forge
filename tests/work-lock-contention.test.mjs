// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { NativeSource } from '../dist/native-source.js';
import { nativeObjects } from '../dist/native-objects.js';
import { indexBuild, indexGet, indexSet, indexUpdate } from '../dist/work-record-index.js';
import { digest } from '../dist/hash.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { ForgeError } from '../dist/errors.js';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'source.txt'), 'original\n');
  initNative(root);
  return new AgentWorkflow(root);
}
async function start(agent) {
  return (
    await agent.dispatch({
      action: 'start',
      operationId: randomUUID(),
      outcome: 'Contention fixture',
      channel: null,
    })
  ).result;
}
test('native checkpoint prepares bytes outside owner lock and original retry does not recapture', async t => {
  const agent = fixture(t),
    lane = await start(agent),
    store = agent.work.store,
    locked = store.locked.bind(store),
    capture = NativeSource.prototype.captureReport;
  let inside = false,
    captures = 0;
  store.locked = run =>
    locked(() => {
      inside = true;
      try {
        return run();
      } finally {
        inside = false;
      }
    });
  NativeSource.prototype.captureReport = function (...args) {
    captures++;
    assert.equal(inside, false);
    return capture.apply(this, args);
  };
  t.after(() => {
    NativeSource.prototype.captureReport = capture;
  });
  writeFileSync(join(lane.path, 'source.txt'), 'changed\n');
  const command = {
    action: 'checkpoint',
    operationId: randomUUID(),
    laneId: lane.laneId,
    expectedHead: lane.head,
    message: 'Prepared source',
  };
  const first = await agent.dispatch(command);
  assert.equal(captures, 1);
  assert.deepEqual((await agent.dispatch(command)).result, first.result);
  assert.equal(captures, 1);
  assert.equal(store.load().lanes[0].checkpoints.length, 1);
});
test('candidate cannot overwrite concurrent Lane head and original same-operation reply wins', async t => {
  const agent = fixture(t),
    lane = await start(agent),
    store = agent.work.store,
    peer = new AgentWorkflow(store.root),
    locked = store.laneLocked.bind(store);
  writeFileSync(join(lane.path, 'source.txt'), 'changed\n');
  const command = {
    action: 'checkpoint',
    operationId: randomUUID(),
    laneId: lane.laneId,
    expectedHead: lane.head,
    message: 'Same original operation',
  };
  let original;
  store.laneLocked = (id, run) => {
    store.laneLocked = locked;
    original = peer.dispatch(command);
    return locked(id, run);
  };
  const reply = await agent.dispatch(command);
  assert.deepEqual(reply.result, (await original).result);
  assert.equal(store.load().lanes[0].checkpoints.length, 1);
  const next = { ...command, operationId: randomUUID(), expectedHead: reply.result.head };
  writeFileSync(join(lane.path, 'source.txt'), 'another\n');
  store.laneLocked = (id, run) => {
    store.laneLocked = locked;
    void peer.dispatch({ ...next, operationId: randomUUID() });
    return locked(id, run);
  };
  await assert.rejects(agent.dispatch(next), error => error.code === 'LANE_STALE');
  assert.equal(store.load().lanes[0].checkpoints.length, 2);
});
test('metadata publication retains revision guard and same-revision extensions', async t => {
  const agent = fixture(t),
    lane = await start(agent),
    store = agent.work.store,
    peer = new WorkStore(store.root),
    locked = store.locked.bind(store);
  const command = { action: 'note', intentId: lane.intentId, kind: 'comment', text: 'Prepared note' },
    revision = store.revision();
  store.locked = run => {
    store.locked = locked;
    peer.locked(() => {
      const tx = peer.records();
      tx.patchFields('intents', lane.intentId, { futureExtension: { keep: true } });
      peer.commitRecords(tx, tx.revision);
    });
    return locked(run);
  };
  await agent.work.dispatch(command, revision, { compact: true });
  assert.deepEqual(store.load().intents[0].futureExtension, { keep: true });
  assert.equal(store.load().intents[0].notes.length, 1);
  store.locked = run => {
    store.locked = locked;
    peer.locked(() => {
      const tx = peer.records();
      tx.patchFields('intents', lane.intentId, { status: 'ready' });
      peer.commitRecords(tx);
    });
    return locked(run);
  };
  await assert.rejects(
    agent.work.dispatch({ ...command, text: 'Stale' }, store.revision(), { compact: true }),
    error => error.code === 'WORK_STALE',
  );
  assert.equal(store.load().intents[0].notes.length, 1);
});
test('failed speculative preparation retains busy and original validation precedence', async t => {
  const agent = fixture(t),
    lane = await start(agent),
    store = agent.work.store,
    locked = store.locked.bind(store);
  store.locked = () => {
    throw new ForgeError('WORK_BUSY', 'held');
  };
  await assert.rejects(
    agent.work.dispatch(
      { action: 'note', intentId: randomUUID(), kind: 'comment', text: 'missing' },
      store.revision(),
      { compact: true },
    ),
    error => error.code === 'WORK_BUSY',
  );
  writeFileSync(join(lane.path, 'source.txt'), 'changed\n');
  await assert.rejects(
    agent.dispatch({
      action: 'checkpoint',
      operationId: randomUUID(),
      laneId: lane.laneId,
      expectedHead: lane.head,
      expectedTree: 'f'.repeat(64),
      message: 'Wrong tree',
    }),
    error => error.code === 'WORK_BUSY',
  );
  store.locked = locked;
  await assert.rejects(
    agent.dispatch({
      action: 'checkpoint',
      operationId: randomUUID(),
      laneId: lane.laneId,
      expectedHead: lane.head,
      expectedTree: 'f'.repeat(64),
      message: 'Wrong tree',
    }),
    error => error.code === 'LANE_STALE',
  );
  assert.equal(store.load().lanes[0].checkpoints.length, 0);
});
test('live fast-busy, ambiguous and interrupted recovery retain original locks; dead owner is recovered', t => {
  const agent = fixture(t),
    store = agent.work.store,
    path = join(store.directory, 'lock'),
    recovery = join(store.directory, 'lock-recovery');
  const live = JSON.stringify({ pid: process.pid, host: hostname() });
  writeFileSync(path, live);
  assert.throws(
    () => store.locked(() => assert.fail(), { waitMs: 0 }),
    error => error.code === 'WORK_BUSY',
  );
  assert.equal(readFileSync(path, 'utf8'), live);
  assert.equal(existsSync(recovery), false);
  rmSync(path);
  writeFileSync(path, '{incomplete');
  assert.throws(
    () => store.locked(() => assert.fail(), { waitMs: 0 }),
    error => error.code === 'WORK_BUSY',
  );
  assert.equal(readFileSync(path, 'utf8'), '{incomplete');
  mkdirSync(recovery);
  assert.throws(
    () => store.locked(() => assert.fail(), { waitMs: 0 }),
    error => error.code === 'WORK_BUSY',
  );
  rmSync(recovery, { recursive: true });
  rmSync(path);
  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import {WorkStore} from ${JSON.stringify(new URL('../dist/work-store.js', import.meta.url).href)};new WorkStore(process.argv[1]).locked(()=>process.exit(0));`,
    store.root,
  ]);
  assert.equal(
    store.locked(() => 42),
    42,
  );
  assert.equal(existsSync(path), false);
});

test('collection between speculative source and owner publication cannot leave dangling blobs', async t => {
  const agent = fixture(t),
    lane = await start(agent),
    store = agent.work.store,
    peer = new WorkStore(store.root),
    locked = store.locked.bind(store);
  writeFileSync(join(lane.path, 'source.txt'), 'collectible candidate\n');
  let removed = [];
  store.locked = run => {
    store.locked = locked;
    removed = nativeObjects(peer, { action: 'collect-native-objects' }).result.removed;
    return locked(run);
  };
  const checkpoint = (
    await agent.dispatch({
      action: 'checkpoint',
      operationId: randomUUID(),
      laneId: lane.laneId,
      expectedHead: lane.head,
      message: 'Recover collected candidate',
    })
  ).result;
  assert.ok(removed.length >= 1);
  const source = new NativeSource(store.root),
    state = source.state(checkpoint.head);
  for (const file of state.files) assert.equal(digest(source.object(file.blob)), file.blob);
  assert.equal(
    source.object(state.files.find(file => file.path === 'source.txt').blob).toString(),
    'collectible candidate\n',
  );
  assert.equal(store.load().lanes[0].checkpoints.length, 1);
});
test('multi-selector index updates preserve lookups across splits and removals with fewer persisted nodes', () => {
  const objects = new Map();
  let writes = 0;
  const io = {
    read: id => structuredClone(objects.get(id)),
    put: value => {
      const id = digest(JSON.stringify(value));
      objects.set(id, structuredClone(value));
      writes++;
      return id;
    },
  };
  const values = new Map(Array.from({ length: 200 }, (_, i) => ['key-' + i, [i]])),
    base = indexBuild(io, values);
  const changes = new Map([
    ...Array.from({ length: 30 }, (_, i) => ['key-' + i, i % 2 ? [] : [i, 300 + i]]),
    ...Array.from({ length: 30 }, (_, i) => ['new-' + i, [500 + i]]),
  ]);
  writes = 0;
  let sequential = base;
  for (const [key, positions] of changes) sequential = indexSet(io, sequential, key, positions);
  const previousWrites = writes;
  writes = 0;
  const batched = indexUpdate(io, base, changes),
    batchedWrites = writes;
  assert.ok(batchedWrites < previousWrites);
  for (const key of new Set([...values.keys(), ...changes.keys()]))
    assert.deepEqual(indexGet(io, batched, key), indexGet(io, sequential, key));
  assert.deepEqual(indexGet(io, base, 'key-0'), [0]);
});

test('interrupted grouped lookup write leaves original Work authoritative and original retry creates one Lane', async t => {
  const agent = fixture(t),
    store = agent.work.store,
    before = store.snapshotBytes(),
    fsync = fs.fsyncSync,
    command = {
      action: 'start',
      operationId: randomUUID(),
      outcome: 'Interrupted grouped selectors',
      channel: null,
    };
  let calls = 0;
  fs.fsyncSync = (...args) => {
    if (++calls === 3) throw Object.assign(Error('Injected durability interruption'), { code: 'EIO' });
    return fsync(...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(agent.dispatch(command), error => error.code === 'EIO');
  } finally {
    fs.fsyncSync = fsync;
    syncBuiltinESMExports();
  }
  assert.deepEqual(store.snapshotBytes(), before);
  const retry = await agent.dispatch(command);
  assert.deepEqual((await agent.dispatch(command)).result, retry.result);
  assert.equal(store.load().intents.length, 1);
  assert.equal(store.load().lanes.length, 1);
});
