// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { localBrief } from '../dist/agent-brief-local.js';
import { trustAgents } from './autonomy-fixture.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-stack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'shared.txt'), 'original\n');
  initNative(root);
  trustAgents(root);
  const agent = new AgentWorkflow(root);
  const call = async (action, body = {}) => (await agent.dispatch({ action, ...body })).result;
  await call('define-check', { name: 'verify', executable: process.execPath, args: ['-e', '0'] });
  const start = (outcome, stackOn) =>
    call('start', { outcome, ...(stackOn ? { stackOn: stackOn.laneId } : {}) });
  const edit = (lane, file, bytes) => writeFileSync(join(lane.path, file), bytes);
  const save = lane => call('checkpoint', { laneId: lane.laneId, message: 'Save work' });
  const finish = (lane, extra = {}) =>
    call('finish', { laneId: lane.laneId, message: 'Land work', accept: true, ...extra });
  const text = (lane, file) => readFileSync(join(lane.path, file), 'utf8');
  const status = async lane => (await call('status', { laneId: lane.laneId })).lane;
  return { root, agent, store: agent.work.store, call, start, edit, save, finish, text, status };
}

test('depth-three starts from saved heads, carries parent handoff, and reports moved ancestors', async t => {
  const f = await fixture(t),
    a = await f.start('First');
  f.edit(a, 'first.txt', 'first\n');
  const saved = await f.save(a);
  await f.call('handoff', { laneId: a.laneId, summary: 'Parent API is ready', next: ['Use the parent API'] });
  f.edit(a, 'first.txt', 'unsaved parent draft\n');
  const request = { operationId: randomUUID(), outcome: 'Second', stackOn: a.laneId };
  const b = await f.call('start', request);
  assert.equal(b.base, saved.head);
  assert.deepEqual(b.after, { intentId: a.intentId });
  assert.equal(f.text(b, 'first.txt'), 'first\n');
  f.edit(b, 'second.txt', 'second\n');
  await f.save(b);
  const c = await f.start('Third', b);
  assert.equal(f.text(c, 'second.txt'), 'second\n');
  assert.equal((await f.status(c)).stackStatus.depth, 3);
  assert.match((await f.call('peers', { laneId: c.laneId })).stack.summary, / → .* → /);
  const brief = localBrief(f.store, { situation: 'continue-lane', laneId: b.laneId });
  assert.match(brief.full, /Parent API is ready/);
  const handoff = await f.call('handoff', { laneId: b.laneId, summary: 'Child ready' });
  assert.equal(handoff.handoff.parentHandoff.summary, 'Parent API is ready');
  assert.deepEqual(handoff.handoff.parentHandoff.next, ['Use the parent API']);
  assert.equal((await f.call('handoff-read', { laneId: b.laneId })).parentHandoff.laneId, a.laneId);
  f.edit(a, 'first.txt', 'updated\n');
  await f.save(a);
  assert.equal((await f.status(b)).stackStatus.status, 'parent-moved');
  assert.equal((await f.call('peers', { laneId: b.laneId })).stack.status, 'parent-moved');
  const replay = await f.call('start', request);
  assert.equal(replay.laneId, b.laneId);
  assert.equal(replay.head, saved.head);
  await assert.rejects(f.call('start', { ...request, stackOn: b.laneId }), {
    code: 'WORK_OPERATION_CHANGED',
  });
  const sync = {
    operationId: randomUUID(),
    laneId: b.laneId,
    expectedHead: f.store.select('lanes', b.laneId).head,
  };
  const merged = await f.call('sync', sync);
  assert.equal(merged.status, 'merged');
  assert.equal(f.text(b, 'first.txt'), 'updated\n');
  assert.equal(f.text(b, 'second.txt'), 'second\n');
  const restackedReplay = await f.call('start', request);
  assert.equal(restackedReplay.head, saved.head);
  assert.equal(restackedReplay.base, saved.head);
  assert.equal(restackedReplay.currentHead, merged.head);
  f.edit(a, 'newer.txt', 'newer\n');
  await f.save(a);
  assert.equal((await f.call('sync', sync)).head, merged.head);
  assert.equal((await f.status(b)).stackStatus.status, 'parent-moved');
  assert.equal((await f.status(c)).stackStatus.status, 'parent-moved');
});

test('child finish waits and a reverse-order depth-three chain lands through land-ready', async t => {
  const f = await fixture(t),
    a = await f.start('First');
  f.edit(a, 'a.txt', 'a\n');
  await f.save(a);
  const b = await f.start('Second', a);
  f.edit(b, 'b.txt', 'b\n');
  await f.save(b);
  const c = await f.start('Third', b);
  f.edit(c, 'c.txt', 'c\n');
  assert.equal((await f.finish(c)).status, 'waiting-for-dependency');
  assert.equal((await f.finish(b)).status, 'waiting-for-dependency');
  assert.equal(f.store.load().channelMoves.length, 0);
  assert.equal((await f.finish(a)).status, 'accepted');
  assert.equal((await f.status(b)).stackStatus.status, 'parent-landed');
  const landed = await f.call('land-ready');
  assert.equal(landed.finishes.length, 2);
  assert.ok(landed.finishes.every(result => result.status === 'accepted'));
  assert.deepEqual(
    f.store.load().channelMoves.map(move => f.store.select('views', move.viewId).intentId),
    [a.intentId, b.intentId, c.intentId],
  );
});

test('land waits for parent and retries the same ordered saved inputs', async t => {
  const f = await fixture(t),
    a = await f.start('Parent');
  f.edit(a, 'a.txt', 'a\n');
  await f.save(a);
  const b = await f.start('Child', a);
  f.edit(b, 'b.txt', 'b\n');
  await f.save(b);
  const request = { operationId: randomUUID(), laneIds: [b.laneId, a.laneId] };
  const result = await f.call('land', request);
  assert.ok(result);
  assert.equal(f.store.load().channelMoves.length, 2);
  const count = f.store.load().channelMoves.length;
  await f.call('land', request);
  assert.equal(f.store.load().channelMoves.length, count);
});

test('landed parent retargets child without overwriting unsaved work; sync rebases onto main', async t => {
  const f = await fixture(t),
    a = await f.start('Parent');
  f.edit(a, 'a.txt', 'a\n');
  await f.save(a);
  const b = await f.start('Child', a);
  f.edit(b, 'b.txt', 'unsaved child\n');
  f.edit(a, 'a.txt', 'new parent\n');
  await f.save(a);
  const landed = await f.finish(a);
  assert.equal(landed.status, 'accepted');
  const status = await f.status(b);
  assert.equal(status.stackStatus.status, 'parent-landed');
  assert.equal(status.stackStatus.acceptanceId, landed.acceptance.acceptanceId);
  assert.equal(f.text(b, 'b.txt'), 'unsaved child\n');
  await f.save(b);
  assert.equal((await f.call('sync', { laneId: b.laneId })).status, 'merged');
  assert.equal(f.text(b, 'a.txt'), 'new parent\n');
  assert.equal(f.text(b, 'b.txt'), 'unsaved child\n');
  assert.equal((await f.status(b)).stackStatus.status, 'main');
  assert.equal((await f.finish(b)).status, 'accepted');
});

test('parent main conflict keeps child waiting; parent resolution is rebased through receipt', async t => {
  const f = await fixture(t),
    a = await f.start('Parent'),
    other = await f.start('Main competitor');
  f.edit(a, 'shared.txt', 'parent\n');
  await f.save(a);
  const b = await f.start('Child', a);
  f.edit(b, 'b.txt', 'child\n');
  f.edit(other, 'shared.txt', 'main\n');
  assert.equal((await f.finish(other)).status, 'accepted');
  assert.equal((await f.finish(a)).status, 'conflict');
  assert.equal((await f.finish(b)).status, 'waiting-for-dependency');
  f.edit(a, 'shared.txt', 'resolved\n');
  await f.save(a);
  assert.equal((await f.finish(a)).status, 'accepted');
  const ready = await f.call('land-ready');
  assert.equal(ready.finishes[0].status, 'accepted');
  assert.equal(f.text(b, 'shared.txt'), 'resolved\n');
});

test('parent movement conflicts use normal markers, checkpoint resolution and new base', async t => {
  const f = await fixture(t),
    a = await f.start('Parent');
  f.edit(a, 'shared.txt', 'parent\n');
  await f.save(a);
  const b = await f.start('Child', a);
  f.edit(b, 'shared.txt', 'child\n');
  await f.save(b);
  f.edit(a, 'shared.txt', 'parent updated\n');
  const parent = await f.save(a);
  const sync = {
    laneId: b.laneId,
    operationId: randomUUID(),
    expectedHead: f.store.select('lanes', b.laneId).head,
  };
  assert.equal((await f.call('sync', sync)).status, 'conflict');
  assert.match(f.text(b, 'shared.txt'), /<<<<<<< lane/);
  assert.equal((await f.call('sync', sync)).status, 'conflict');
  f.edit(b, 'shared.txt', 'both resolved\n');
  await f.save(b);
  assert.equal(f.store.select('lanes', b.laneId).base, parent.head);
  assert.equal((await f.status(b)).stackStatus.status, 'up-to-date');
  const source = new NativeSource(f.root);
  assert.deepEqual(source.state(f.store.select('lanes', b.laneId).head).parents, [
    parent.head,
    sync.expectedHead,
  ]);
});

test('abandoned parent remains visible and explicit main retarget preserves only child delta', async t => {
  const f = await fixture(t),
    a = await f.start('Parent');
  f.edit(a, 'parent.txt', 'unlanded parent\n');
  await f.save(a);
  const b = await f.start('Child', a);
  f.edit(b, 'child.txt', 'child\n');
  await f.save(b);
  await f.call('abandon', { laneId: a.laneId, reason: 'Superseded' });
  assert.equal((await f.status(b)).stackStatus.status, 'parent-abandoned');
  assert.equal((await f.finish(b)).status, 'waiting-for-dependency');
  await f.call('sync', { laneId: b.laneId, ontoMain: true });
  const saved = f.store.select('lanes', b.laneId);
  assert.equal(saved.stack.detached, true);
  assert.equal(saved.after, undefined);
  assert.equal(
    new NativeSource(f.root).state(saved.head).files.some(file => file.path === 'parent.txt'),
    false,
  );
  assert.equal(f.text(b, 'child.txt'), 'child\n');
  const landed = await f.finish(b);
  assert.equal(landed.status, 'accepted');
  assert.equal(
    new NativeSource(f.root).state(landed.acceptance.head).files.some(file => file.path === 'parent.txt'),
    false,
  );
});

test('restack interruption pins the old target despite later parent saves; undo restores stack base', async t => {
  const f = await fixture(t),
    a = await f.start('Parent');
  f.edit(a, 'a.txt', 'first\n');
  await f.save(a);
  const b = await f.start('Child', a);
  f.edit(b, 'b.txt', 'child\n');
  await f.save(b);
  const before = f.store.select('lanes', b.laneId);
  f.edit(a, 'a.txt', 'second\n');
  const second = await f.save(a);
  const sync = { laneId: b.laneId, operationId: randomUUID(), expectedHead: before.head };
  const { syncTestHooks } = await import('../dist/agent-sync.js');
  syncTestHooks.afterWorkspace = () => {
    throw new Error('Synthetic reply loss');
  };
  try {
    await assert.rejects(f.call('sync', sync), /Synthetic reply loss/);
  } finally {
    delete syncTestHooks.afterWorkspace;
  }
  f.edit(a, 'a.txt', 'third\n');
  await f.save(a);
  const resumed = await f.call('sync', sync);
  assert.equal(resumed.target, second.head);
  assert.equal(f.text(b, 'a.txt'), 'second\n');
  await assert.rejects(f.call('sync', { ...sync, ontoMain: true }), { code: 'WORK_OPERATION_CHANGED' });
  await f.call('undo-sync', { laneId: b.laneId, syncOperationId: sync.operationId });
  const undone = f.store.select('lanes', b.laneId);
  assert.equal(undone.head, before.head);
  assert.equal(undone.base, before.base);
  assert.deepEqual(undone.stack, before.stack);
  assert.equal((await f.status(b)).stackStatus.status, 'parent-moved');
});

test('stack metadata survives unified records and portable reads without changing ordinary owner formats', async t => {
  const f = await fixture(t),
    a = await f.start('Parent');
  f.edit(a, 'parent.txt', 'parent\n');
  await f.save(a);
  const { convertWorkTo18 } = await import('../dist/work-intent-converter.js');
  const { parseWork } = await import('../dist/work-unified-types.js');
  f.store.locked(() => {
    const data = f.store.load();
    data.schema = 15;
    f.store.save(convertWorkTo18(data));
  });
  const b = await f.start('Unified child', a);
  assert.equal(f.store.load().schema, 22);
  f.edit(b, 'child.txt', 'child\n');
  await f.save(b);
  f.edit(a, 'next.txt', 'parent moved\n');
  await f.save(a);
  await f.call('sync', { laneId: b.laneId });
  const data = parseWork(JSON.parse(f.store.snapshotBytes()));
  assert.equal(data.schema, 22);
  assert.deepEqual(
    data.lanes.find(lane => lane.id === b.laneId).stack,
    f.store.select('lanes', b.laneId).stack,
  );
  assert.equal(convertWorkTo18(data).schema, 22);
  const { batchEdit } = await import('../dist/landing-batch-store.js');
  await batchEdit(f.agent.work, randomUUID(), () => {});
  assert.equal(f.store.load().schema, 22);
  const { validateSourceReturn } = await import('../dist/work-source-return.js');
  assert.throws(() => validateSourceReturn(data, { ...data, schema: 20 }, {}), {
    code: 'WORK_UPGRADE_REQUIRED',
  });
});

test('same-Intent stack waits for its exact parent, not unrelated siblings, and pending shows the chain', async t => {
  const f = await fixture(t),
    a = await f.start('Parent');
  f.edit(a, 'parent.txt', 'parent\n');
  await f.save(a);
  await f.call('start', { intentId: a.intentId, outcome: 'Unrelated sibling' });
  const b = await f.call('start', { intentId: a.intentId, outcome: 'Same Intent child', stackOn: a.laneId });
  f.edit(b, 'child.txt', 'child\n');
  await f.save(b);
  const { pendingStatus } = await import('../dist/pending-status.js');
  const { formatPendingStatus } = await import('../dist/pending-status-format.js');
  const pending = pendingStatus(f.store.load());
  assert.equal(pending.lanes.find(lane => lane.laneId === b.laneId).status, 'waiting');
  assert.match(formatPendingStatus(pending), /Stack: .* → .* · up-to-date/);
  const sync = await f.call('sync', { laneId: b.laneId });
  await f.call('undo-sync', { laneId: b.laneId, syncOperationId: sync.operationId });
  assert.equal(f.store.select('lanes', b.laneId).after, undefined);
  assert.equal((await f.finish(b)).status, 'waiting-for-dependency');
  assert.equal((await f.finish(a)).status, 'accepted');
  assert.equal((await f.call('land-ready')).finishes[0].status, 'accepted');
});
