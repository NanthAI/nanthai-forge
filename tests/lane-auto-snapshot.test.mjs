// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentWorkflow } from './agent-advisory-fixture.mjs';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { nativeObjects } from '../dist/native-objects.js';
import { watchLanePresence } from '../dist/presence-worker.js';
import { readAutoSnapshot, snapshotLane } from '../dist/lane-auto-snapshot.js';

async function fixture(t, files = { 'file.txt': 'one\n' }) {
  const root = mkdtempSync(join(tmpdir(), 'forge-auto-snapshot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  initNative(root);
  const agent = new AgentWorkflow(root);
  const lane = (
    await agent.dispatch({ action: 'start', outcome: 'Synthetic auto-snapshot', actor: 'agent-a' })
  ).result;
  const store = agent.work.store;
  const objects = () => readdirSync(new NativeSource(root).directory).length;
  return { root, agent, lane, store, objects };
}
async function until(check, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    assert.ok(Date.now() < end, 'condition not reached in time');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const show = (agent, state, path) => agent.dispatch({ action: 'show', state, path });

test('an edit is snapshotted after the debounce without a checkpoint or Lane history entry', async t => {
  const { agent, lane, store } = await fixture(t);
  t.after(() => {
    delete process.env.FORGE_AUTO_SNAPSHOT_DEBOUNCE_MS;
    delete process.env.FORGE_AUTO_SNAPSHOT_INTERVAL_MS;
  });
  process.env.FORGE_AUTO_SNAPSHOT_DEBOUNCE_MS = '200';
  process.env.FORGE_AUTO_SNAPSHOT_INTERVAL_MS = '0';
  const controller = new AbortController();
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => {
    controller.abort();
    clearInterval(keepAlive);
  });
  const watching = watchLanePresence(store, lane.laneId, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 300));
  const edited = Date.now();
  writeFileSync(join(lane.path, 'file.txt'), 'unsaved edit\n');
  const snapshot = await until(() => readAutoSnapshot(store, lane.laneId));
  assert.ok(Date.parse(snapshot.at) - edited >= 150, 'snapshot waits for the debounce');
  assert.equal(snapshot.parent, lane.head);
  assert.deepEqual(snapshot.paths, ['file.txt']);
  const saved = store.select('lanes', lane.laneId);
  assert.equal(saved.head, lane.head, 'the Lane head is not moved');
  assert.equal(saved.checkpoints.length, lane.checkpoints?.length ?? 0, 'no save is recorded');
  assert.equal((await show(agent, snapshot.state, 'file.txt')).result.content, 'unsaved edit\n');
  const status = (await agent.dispatch({ action: 'status', laneId: lane.laneId })).result.lane;
  assert.equal(status.saves, saved.checkpoints.length);
  assert.equal(status.autoSnapshot.state, snapshot.state);
  assert.match(status.autoSnapshot.notice, /Unsaved edits recovered from auto-snapshot at /);
  controller.abort();
  await watching;
});

test('no change writes no State and rereads nothing; reverting to the head clears the snapshot', async t => {
  const files = Object.fromEntries(
    Array.from({ length: 50 }, (_, i) => [`src/m${i}.ts`, `export const v = ${i};\n`]),
  );
  const { lane, store, objects } = await fixture(t, files);
  assert.equal(snapshotLane(store, lane.laneId).status, 'clean');
  assert.equal(readAutoSnapshot(store, lane.laneId), undefined);
  writeFileSync(join(lane.path, 'src/m1.ts'), 'export const v = "edited";\n');
  const first = snapshotLane(store, lane.laneId);
  assert.equal(first.status, 'snapshot');
  assert.equal(first.changedPathCount, 1);
  assert.equal(first.reread, 1, 'only the edited file is read again');
  const count = objects();
  const second = snapshotLane(store, lane.laneId);
  assert.equal(second.status, 'unchanged');
  assert.equal(second.reread, 0, 'no file bytes are hashed again');
  assert.equal(objects(), count, 'no new object or State');
  writeFileSync(join(lane.path, 'src/m1.ts'), 'export const v = 1;\n');
  assert.equal(snapshotLane(store, lane.laneId).status, 'clean');
  assert.equal(readAutoSnapshot(store, lane.laneId), undefined);
});

test('a killed watcher process leaves a recoverable snapshot that start and status report', async t => {
  const { root, lane, store } = await fixture(t);
  const worker = new URL('../dist/presence-worker.js', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { WorkStore } = await import(${JSON.stringify(new URL('../dist/work-store.js', import.meta.url).href)});
       const { watchLanePresence } = await import(${JSON.stringify(worker)});
       await watchLanePresence(new WorkStore(process.argv[1]), process.argv[2]);`,
      root,
      lane.laneId,
    ],
    {
      stdio: 'ignore',
      env: { ...process.env, FORGE_AUTO_SNAPSHOT_DEBOUNCE_MS: '100', FORGE_AUTO_SNAPSHOT_INTERVAL_MS: '0' },
    },
  );
  t.after(() => child.kill('SIGKILL'));
  await until(
    () => existsSync(join(store.directory, 'presence-workers', lane.laneId)) || child.exitCode !== null,
  );
  await new Promise(resolve => setTimeout(resolve, 500));
  writeFileSync(join(lane.path, 'file.txt'), 'work in progress\n');
  writeFileSync(join(lane.path, 'new.txt'), 'brand new\n');
  const snapshot = await until(() => {
    const value = readAutoSnapshot(store, lane.laneId);
    return value?.changedPathCount === 2 ? value : undefined;
  });
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  // The machine "restarts" and the Lane folder is gone; only owner storage survives.
  rmSync(lane.path, { recursive: true, force: true });
  const restarted = new AgentWorkflow(root);
  const status = (await restarted.dispatch({ action: 'status', laneId: lane.laneId })).result.lane;
  assert.equal(status.autoSnapshot.state, snapshot.state);
  assert.deepEqual(status.autoSnapshot.paths, ['file.txt', 'new.txt']);
  const owner = (await restarted.dispatch({ action: 'status', detail: true })).result;
  assert.equal(owner.unsavedEdits[0].laneId, lane.laneId);
  for (const [path, text] of [
    ['file.txt', 'work in progress\n'],
    ['new.txt', 'brand new\n'],
  ])
    assert.equal((await show(restarted, snapshot.state, path)).result.content, text);
  const again = (
    await restarted.dispatch({ action: 'start', outcome: 'Resume after crash', actor: 'agent-a' })
  ).result;
  assert.ok(
    again.warnings.some(item => item.includes(lane.laneId) && item.includes('Unsaved edits recovered')),
  );
});

test('a pending merge, a held Lane lock or the disabled policy skip without capturing', async t => {
  const { agent, lane, store, objects } = await fixture(t);
  writeFileSync(join(lane.path, 'file.txt'), 'edit\n');
  const count = objects();
  const merging = Object.create(store);
  merging.select = (collection, ...rest) => {
    const record = store.select(collection, ...rest);
    return collection === 'lanes' && record
      ? { ...record, pendingMerge: { parent: record.head, files: [] } }
      : record;
  };
  assert.deepEqual(snapshotLane(merging, lane.laneId), { status: 'skipped', reason: 'merge-pending' });
  store.laneLocked(lane.laneId, () =>
    assert.deepEqual(snapshotLane(store, lane.laneId), { status: 'skipped', reason: 'busy' }),
  );
  assert.equal(objects(), count);
  await agent.dispatch({ action: 'set-policy', operationId: randomUUID(), autoSnapshot: false });
  assert.deepEqual(snapshotLane(store, lane.laneId), { status: 'skipped', reason: 'disabled' });
  assert.equal(objects(), count);
  await agent.dispatch({ action: 'set-policy', operationId: randomUUID(), autoSnapshot: true });
  assert.equal(snapshotLane(store, lane.laneId).status, 'snapshot');
});

test('snapshots never take the owner lock and hold the publication lock briefly', async t => {
  const files = Object.fromEntries(
    Array.from({ length: 400 }, (_, i) => [`src/d${i % 20}/m${i}.ts`, `export const v = ${i};\n`.repeat(40)]),
  );
  const { root, lane, store } = await fixture(t, files);
  const trace = join(root, '..', `${randomUUID()}-lock-trace.jsonl`);
  t.after(() => {
    delete process.env.FORGE_WORK_LOCK_TRACE;
    rmSync(trace, { force: true });
  });
  process.env.FORGE_WORK_LOCK_TRACE = trace;
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(lane.path, `src/d1/m${i * 20 + 1}.ts`), `export const edited = ${i};\n`);
    assert.equal(snapshotLane(store, lane.laneId).status, 'snapshot');
  }
  const holds = readFileSync(trace, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.ok(!holds.some(hold => hold.path === join(store.directory, 'lock')), 'owner lock never taken');
  const publication = holds.filter(hold => hold.operation === 'auto-snapshot publication');
  assert.equal(publication.length, 5);
  for (const hold of publication) assert.ok(hold.holdMs < 250, `publication held ${hold.holdMs}ms`);
});

test('collection retains the latest auto-snapshot and frees a superseded one', async t => {
  const { agent, lane, store } = await fixture(t);
  writeFileSync(join(lane.path, 'file.txt'), 'first unsaved\n');
  const first = snapshotLane(store, lane.laneId);
  writeFileSync(join(lane.path, 'file.txt'), 'second unsaved\n');
  const second = snapshotLane(store, lane.laneId);
  const removed = nativeObjects(store, { action: 'collect-native-objects' }).result.removed.map(
    item => item.id,
  );
  assert.ok(removed.includes(first.state), 'superseded snapshot is collectable');
  assert.ok(!removed.includes(second.state));
  assert.equal((await show(agent, second.state, 'file.txt')).result.content, 'second unsaved\n');
  assert.equal(snapshotLane(store, lane.laneId).status, 'unchanged');
});
