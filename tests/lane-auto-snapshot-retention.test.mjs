// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { WorkService } from '../dist/work.js';
import { agentClean } from '../dist/agent-clean.js';
import { RETENTION_MS } from '../dist/clean-retention.js';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { nativeObjects } from '../dist/native-objects.js';
import { readAutoSnapshot, snapshotLane } from '../dist/lane-auto-snapshot.js';
import { autoSnapshotRetentionPlan } from '../dist/lane-auto-snapshot-retention.js';
import { automaticCleanup } from '../dist/work-auto-clean.js';
import { mockProcessCoverage } from './cleanup-process-fixture.mjs';

async function fixture(t) {
  mockProcessCoverage(t);
  const root = mkdtempSync(join(tmpdir(), 'forge-snapshot-retention-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  writeFileSync(join(root, 'file.txt'), 'saved\n');
  writeFileSync(join(root, 'shared.txt'), 'shared with main\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store,
    source = new NativeSource(root);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Synthetic snapshot retention' })).result;
  writeFileSync(join(lane.path, 'file.txt'), 'unsaved\n');
  const snapshot = snapshotLane(store, lane.laneId);
  assert.equal(snapshot.status, 'snapshot');
  const path = join(store.directory, 'auto-snapshots', `${lane.laneId}.json`);
  const cache = path.replace(/\.json$/, '.cache.json');
  const now = Date.now(),
    old = now - RETENTION_MS - 60_000;
  const age = at =>
    writeFileSync(
      path,
      JSON.stringify({ ...readAutoSnapshot(store, lane.laneId), at: new Date(at).toISOString() }),
    );
  const close = (state, at = old) =>
    store.locked(() => {
      const tx = store.records();
      if (state === 'abandoned') tx.setSchema(13);
      const found = tx.find('lanes', lane.laneId);
      tx.replace('lanes', found.position, {
        ...found.record,
        state,
        lifecycle: [
          ...(found.record.lifecycle ?? []),
          { from: found.record.state, to: state, at: new Date(at).toISOString() },
        ],
      });
      store.commitRecords(tx);
    });
  age(old);
  const clean = patch =>
    agentClean(store, { action: 'clean', apply: false, kinds: ['auto-snapshots'], ...patch }).result;
  const inspect = () =>
    nativeObjects(store, { action: 'inspect-native-objects' }).result.candidates.map(item => item.id);
  return { agent, store, source, lane, snapshot, path, cache, now, old, age, close, clean, inspect };
}

test('dry-run disk bytes include protected open snapshots and deduplicate their shared objects', async t => {
  const p = await fixture(t);
  const another = (await p.agent.dispatch({ action: 'start', outcome: 'Another open synthetic Lane' }))
    .result;
  writeFileSync(join(another.path, 'file.txt'), 'unsaved\n');
  assert.equal(snapshotLane(p.store, another.laneId).status, 'snapshot');
  const dry = p.clean();
  assert.equal(dry.totals.count, 0);
  const usage = dry.disk.kinds.find(item => item.kind === 'auto-snapshots');
  const snapshots = [p.lane.laneId, another.laneId].map(id => readAutoSnapshot(p.store, id));
  const ids = new Set(
    snapshots.flatMap(snapshot => [
      snapshot.state,
      ...p.source.state(snapshot.state).files.map(file => file.blob),
    ]),
  );
  const bytes = [...ids].reduce((sum, id) => sum + lstatSync(join(p.source.directory, id)).size, 0);
  assert.equal(usage.count, 2);
  assert.equal(usage.objectBytes, bytes);
  assert.ok(usage.metadataBytes > 0);
  assert.equal(usage.bytes, usage.objectBytes + usage.metadataBytes);
  assert.equal(usage.unavailableSnapshots + usage.unavailableObjects, 0);
});

for (const state of ['active', 'paused', 'ready'])
  test(`${state} Lane snapshot is protected regardless of age`, async t => {
    const p = await fixture(t);
    p.close(state, p.old - RETENTION_MS);
    assert.equal(p.clean().totals.count, 0);
    assert.ok(!p.inspect().includes(p.snapshot.state));
    nativeObjects(p.store, { action: 'collect-native-objects' });
    assert.equal(p.source.state(p.snapshot.state).files.length, 2);
  });

for (const state of ['completed', 'abandoned'])
  test(`${state} Lane retains snapshots inside the window and releases them strictly after it`, async t => {
    const p = await fixture(t);
    p.close(state, p.now);
    assert.equal(autoSnapshotRetentionPlan(p.store, p.now + RETENTION_MS).length, 0, 'exact boundary stays');
    assert.ok(!p.inspect().includes(p.snapshot.state), 'old snapshot with recent closure stays');
    assert.equal(autoSnapshotRetentionPlan(p.store, p.now + RETENTION_MS + 1).length, 1);
    p.close(state);
    p.age(p.now);
    assert.equal(p.clean().totals.count, 0, 'recent snapshot with old closure stays');
    p.age(p.old);
    assert.ok(p.inspect().includes(p.snapshot.state));
    assert.equal(p.clean().totals.count, 1);
    assert.deepEqual(snapshotLane(p.store, p.lane.laneId), { status: 'skipped', reason: 'inactive' });
  });

test('dry run measures pointer/cache and snapshot bytes without mutation; apply removes metadata only and is retryable', async t => {
  const p = await fixture(t);
  p.close('completed');
  const pointer = readFileSync(p.path),
    work = p.store.pointer();
  const dry = p.clean();
  const group = dry.candidates.find(item => item.kind === 'auto-snapshots');
  const ids = [p.snapshot.state, ...p.source.state(p.snapshot.state).files.map(file => file.blob)];
  assert.equal(group.bytes, lstatSync(p.path).size + lstatSync(p.cache).size);
  assert.equal(
    group.snapshotBytes,
    [...new Set(ids)].reduce((sum, id) => sum + lstatSync(join(p.source.directory, id)).size, 0),
  );
  assert.ok(group.bytes > 0 && group.snapshotBytes > 0);
  assert.equal(group.items[0].snapshotBytes, group.snapshotBytes);
  assert.deepEqual(readFileSync(p.path), pointer);
  assert.ok(p.store.pointer().equals(work));
  const defaults = agentClean(p.store, { action: 'clean', apply: false }).result;
  assert.ok(defaults.candidates.some(item => item.kind === 'auto-snapshots'));
  const result = p.clean({ apply: true, items: [p.path] });
  assert.equal(result.removed[0].bytes, group.bytes);
  assert.ok(!existsSync(p.path) && !existsSync(p.cache));
  assert.equal(p.source.state(p.snapshot.state).files.length, 2, 'clean leaves object collection separate');
  assert.equal(p.clean({ apply: true }).totals.count, 0);
});

test('reopening within the window protects the snapshot and a stale clean selection cannot remove it', async t => {
  const p = await fixture(t);
  p.close('completed', p.now);
  await p.agent.dispatch({ action: 'reopen', laneId: p.lane.laneId });
  assert.equal(autoSnapshotRetentionPlan(p.store, p.now + RETENTION_MS * 2).length, 0);
  assert.equal(p.clean({ apply: true, items: [p.path] }).totals.count, 0);
  nativeObjects(p.store, { action: 'collect-native-objects' });
  assert.equal(p.source.state(p.snapshot.state).files.length, 2);
  // A new closure starts a fresh grace period rather than using the first close.
  p.close('completed', p.now + 1);
  assert.equal(autoSnapshotRetentionPlan(p.store, p.now + RETENTION_MS).length, 0);
});

test('reopening after an expired dry run restores protection before apply or collection', async t => {
  const p = await fixture(t);
  p.close('abandoned');
  const items = p
    .clean()
    .candidates.flatMap(group => group.items)
    .map(item => item.id);
  assert.deepEqual(items, [p.path]);
  await p.agent.dispatch({ action: 'reopen', laneId: p.lane.laneId });
  assert.equal(p.clean({ apply: true, items }).totals.count, 0);
  assert.ok(existsSync(p.path));
  assert.ok(!p.inspect().includes(p.snapshot.state));
});

test('expired snapshot objects are collected only when unreachable; shared main objects survive', async t => {
  const p = await fixture(t);
  // Give main a recorded root that shares the unchanged blob with the snapshot.
  // This test keeps the Lane open after main accepts it; completion on accept would close it.
  await p.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    lifecycle: { completeOnAccept: false },
  });
  await p.agent.dispatch({ action: 'checkpoint', laneId: p.lane.laneId, message: 'Save to main' });
  const saved = p.store.select('lanes', p.lane.laneId);
  const view = (
    await p.agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: saved.intentId,
      inputs: [{ laneId: saved.id, head: saved.head }],
    })
  ).result;
  await new WorkService(p.store.root).dispatch(
    {
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: view.viewId,
      expectedHead: view.head,
      expectedPrevious: null,
    },
    p.store.revision(),
  );
  writeFileSync(join(p.lane.path, 'file.txt'), 'another unsaved version\n');
  const latest = snapshotLane(p.store, p.lane.laneId);
  p.age(p.old);
  p.close('abandoned');
  const shared = p.source.state(latest.state).files.find(file => file.path === 'shared.txt').blob;
  const privateBlob = p.source.state(latest.state).files.find(file => file.path === 'file.txt').blob;
  const dry = agentClean(p.store, {
    action: 'clean',
    apply: false,
    kinds: ['auto-snapshots', 'objects'],
  }).result;
  assert.ok(
    dry.candidates.find(g => g.kind === 'objects').items.some(item => item.id === `object:${latest.state}`),
  );
  p.clean({ apply: true });
  const removed = nativeObjects(p.store, { action: 'collect-native-objects' }).result.removed.map(
    item => item.id,
  );
  assert.ok(removed.includes(latest.state) && removed.includes(privateBlob));
  assert.ok(!removed.includes(shared));
  assert.equal(p.source.object(shared).toString(), 'shared with main\n');
});

test('automatic retention uses existing opt-in and records permanent snapshot cleanup; replay leaves new snapshots alone', async t => {
  const p = await fixture(t);
  p.close('completed');
  assert.equal(automaticCleanup(p.store, 'disabled', 'test'), undefined);
  assert.ok(existsSync(p.path));
  await p.agent.dispatch({ action: 'set-policy', operationId: randomUUID(), preset: 'autonomous' });
  const cleaned = automaticCleanup(p.store, 'retention', 'test', { runId: randomUUID() });
  assert.equal(cleaned.removed.find(g => g.kind === 'auto-snapshots').count, 1);
  assert.match(cleaned.automatic.undo, /auto-snapshot.*cannot be restored/);
  await p.agent.dispatch({ action: 'reopen', laneId: p.lane.laneId });
  assert.equal(snapshotLane(p.store, p.lane.laneId).status, 'snapshot');
  automaticCleanup(p.store, 'retention', 'test', { runId: randomUUID() });
  assert.ok(existsSync(p.path));
});

test('reopening after object collection rebuilds a snapshot even when its old cache and pointer remain', async t => {
  const p = await fixture(t);
  p.close('completed');
  nativeObjects(p.store, { action: 'collect-native-objects' });
  assert.ok(existsSync(p.path) && existsSync(p.cache));
  await p.agent.dispatch({ action: 'reopen', laneId: p.lane.laneId });
  const snapshot = snapshotLane(p.store, p.lane.laneId);
  assert.equal(snapshot.status, 'snapshot');
  assert.ok(snapshot.reread > 0);
  assert.equal(
    p.source
      .object(p.source.state(snapshot.state).files.find(file => file.path === 'file.txt').blob)
      .toString(),
    'unsaved\n',
  );
});
