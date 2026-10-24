// SPDX-License-Identifier: Apache-2.0
// Incident 2026-10-24: after an outage ~40 old entries whose content was already on main
// each ran a pre-accept check, a head == previous acceptance and a post-accept full check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { enqueueLanding, batchEdit } from '../dist/landing-batch-store.js';
import { drainLandingBatches } from '../dist/landing-batch.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { fixture as batchFixture } from './landing-batch-fixture.mjs';
import { NativeSource } from '../dist/native-source.js';
import { waitingDependencies, acceptedInputs } from '../dist/agent-dependencies.js';
import { stackStatus } from '../dist/agent-stack.js';

async function fixture(t) {
  const f = await batchFixture(t, { delay: 0 });
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    acceptance: { batchWindowMs: 0 },
  });
  return f;
}
const counts = f => {
  const data = f.store.load();
  return { runs: data.runs.length, moves: data.channelMoves.length };
};
async function landOnce(f, path, keepOpen) {
  const landed = await f.candidate(path, `${path}\n`, false);
  landed.command.keepOpen = keepOpen;
  await enqueueLanding(f.work, landed.command, landed.view);
  await drainLandingBatches(f.work, 'main');
  await drainPostAccept(f.store);
  assert.equal(f.store.select('landingEntries', landed.command.operationId).status, 'accepted');
  return landed;
}

test('an entry whose content is already on main completes its Lane without a check or acceptance', async t => {
  const f = await fixture(t);
  const landed = await landOnce(f, 'landed.txt', true);
  assert.equal(f.store.select('lanes', landed.lane.laneId).state, 'active');
  const before = counts(f),
    main = f.main();
  const replay = { ...landed.command, operationId: randomUUID(), keepOpen: false };
  await enqueueLanding(f.work, replay, landed.view);
  await drainLandingBatches(f.work, 'main');
  await drainPostAccept(f.store);
  const entry = f.store.select('landingEntries', replay.operationId);
  assert.equal(entry.status, 'accepted');
  assert.equal(entry.alreadyOnMain, main.head);
  assert.equal(entry.acceptanceId, undefined);
  assert.match(entry.reason, /Already on main/);
  assert.deepEqual(counts(f), before);
  assert.equal(f.main().id, main.id);
  assert.equal(f.store.select('lanes', landed.lane.laneId).state, 'completed');
});

test('a queued entry whose Lane is already completed is dropped before selection', async t => {
  const f = await fixture(t);
  const landed = await landOnce(f, 'done.txt', false);
  assert.equal(f.store.select('lanes', landed.lane.laneId).state, 'completed');
  // Contained content of a completed Lane is reported as landed.
  const stale = { ...landed.command, operationId: randomUUID() };
  await enqueueLanding(f.work, stale, landed.view);
  // Completed but never landed: nothing lands, with a reason and undo.
  const abandoned = await f.candidate('abandoned.txt', 'abandoned\n', false);
  f.work.execute(
    { action: 'lane-status', laneId: abandoned.lane.laneId, state: 'completed' },
    f.store.revision(),
  );
  await enqueueLanding(f.work, abandoned.command, abandoned.view);
  const before = counts(f);
  await drainLandingBatches(f.work, 'main');
  const contained = f.store.select('landingEntries', stale.operationId);
  assert.equal(contained.status, 'accepted');
  assert.equal(contained.alreadyOnMain, f.main().head);
  const dropped = f.store.select('landingEntries', abandoned.command.operationId);
  assert.equal(dropped.status, 'cancelled');
  assert.match(dropped.reason, /completed before this landing ran.*Reopen the Lane/);
  assert.deepEqual(counts(f), before);
  assert.equal(f.content('abandoned.txt'), undefined);
});

test('duplicate entries for one Lane/head run one check and one acceptance', async t => {
  const f = await fixture(t);
  const first = await f.candidate('dup.txt', 'dup\n');
  // Legacy duplicates predate enqueue's in-progress refusal; replay them directly.
  await batchEdit(f.work, randomUUID(), data => {
    const original = data.landingEntries.find(entry => entry.id === first.command.operationId);
    for (let i = 0; i < 3; i++) data.landingEntries.push({ ...original, id: randomUUID() });
  });
  const other = await f.candidate('other.txt', 'other\n');
  await drainLandingBatches(f.work, 'main');
  await drainPostAccept(f.store);
  const data = f.store.load();
  assert.equal(data.runs.filter(run => !run.mainCheck).length, 1);
  assert.equal(data.channelMoves.length, 1);
  assert.equal(data.landingBatches[0].prefixes.length, 2);
  assert.ok(data.landingEntries.every(entry => entry.status === 'accepted'));
  const duplicates = data.landingEntries.filter(entry => entry.viewId === first.view.id);
  assert.equal(duplicates.length, 4);
  assert.equal(duplicates.filter(entry => entry.acceptanceId).length, 1);
  assert.equal(duplicates.filter(entry => entry.alreadyOnMain).length, 3);
  assert.equal(f.content('dup.txt'), 'dup\n');
  assert.equal(f.content('other.txt'), 'other\n');
  assert.equal(f.store.select('lanes', other.lane.laneId).state, 'completed');
});

test('identical content with independent States lands once and only its exact receipt releases dependencies', async t => {
  const f = await fixture(t);
  const first = await f.candidate('identical.txt', 'same\n', false);
  const twin = await f.candidate('identical.txt', 'same\n', false);
  const sibling = await f.candidate('sibling.txt', 'sibling\n', false, twin.lane.intentId);
  const start = async options =>
    (await f.agent.dispatch({ action: 'start', outcome: 'Dependent', ...options })).result;
  const byIntent = await start({ after: { intentId: twin.lane.intentId } });
  const byView = await start({ after: { viewId: twin.view.id } });
  const child = await start({ stackOn: twin.lane.laneId });
  writeFileSync(join(child.path, 'identical.txt'), 'child\n');
  await f.agent.dispatch({ action: 'checkpoint', laneId: child.laneId, message: 'Child delta' });
  await enqueueLanding(f.work, first.command, first.view);
  await drainLandingBatches(f.work, 'main');
  await drainPostAccept(f.store);
  const source = new NativeSource(f.root);
  assert.equal(source.contains(f.main().head, twin.view.head), false);
  assert.equal(waitingDependencies(f.store, [byIntent.laneId, byView.laneId, child.laneId]).length, 3);
  const before = counts(f);
  await enqueueLanding(f.work, twin.command, twin.view);
  await drainLandingBatches(f.work, 'main');
  assert.equal(f.store.select('landingEntries', twin.command.operationId).alreadyOnMain, f.main().head);
  assert.deepEqual(counts(f), before);
  assert.equal(acceptedInputs(f.store, twin.view.inputs, 'main', f.main().head), true);
  assert.deepEqual(waitingDependencies(f.store, [byView.laneId, child.laneId]), []);
  assert.equal(waitingDependencies(f.store, [byIntent.laneId]).length, 1, 'unlanded sibling still waits');
  assert.equal(stackStatus(f.store, f.store.select('lanes', child.laneId)).status, 'parent-landed');
  await enqueueLanding(f.work, sibling.command, sibling.view);
  await drainLandingBatches(f.work, 'main');
  assert.deepEqual(waitingDependencies(f.store, [byIntent.laneId]), []);
  const childLanding = (await f.agent.dispatch({ action: 'land', laneIds: [child.laneId] })).result;
  assert.equal(childLanding.entries[0].status, 'accepted');
  assert.equal(f.content('identical.txt'), 'child\n');
});

test('completed independent content already on main is recognized by exact files rather than ancestry', async t => {
  const f = await fixture(t);
  const first = await f.candidate('identical.txt', 'same\n', false);
  const twin = await f.candidate('identical.txt', 'same\n', false);
  await enqueueLanding(f.work, first.command, first.view);
  await drainLandingBatches(f.work, 'main');
  await drainPostAccept(f.store);
  await f.agent.dispatch({ action: 'complete', laneId: twin.lane.laneId });
  await enqueueLanding(f.work, twin.command, twin.view);
  const before = counts(f);
  await drainLandingBatches(f.work, 'main');
  const entry = f.store.select('landingEntries', twin.command.operationId);
  assert.equal(entry.status, 'accepted');
  assert.equal(entry.alreadyOnMain, f.main().head);
  assert.deepEqual(counts(f), before);
});

test('identical bytes with a different executable mode still require a checked landing', async t => {
  const f = await fixture(t);
  const first = await f.candidate('same.txt', 'same\n', false);
  const twin = await f.candidate('same.txt', 'same\n', false);
  chmodSync(join(twin.lane.path, 'same.txt'), 0o755);
  const saved = (
    await f.agent.dispatch({ action: 'checkpoint', laneId: twin.lane.laneId, message: 'Executable mode' })
  ).result;
  const composed = (
    await f.agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: twin.lane.intentId,
      inputs: [{ laneId: twin.lane.laneId, head: saved.head }],
      dependencies: [],
    })
  ).result;
  const view = f.store.select('views', composed.viewId);
  await enqueueLanding(f.work, first.command, first.view);
  await drainLandingBatches(f.work, 'main');
  await enqueueLanding(f.work, { ...twin.command, expectedHead: saved.head }, view);
  await drainLandingBatches(f.work, 'main');
  const entry = f.store.select('landingEntries', twin.command.operationId);
  assert.equal(entry.status, 'accepted');
  assert.equal(entry.alreadyOnMain, undefined);
  assert.ok(entry.runId);
  assert.ok(entry.acceptanceId);
  assert.equal(
    new NativeSource(f.root).state(f.main().head).files.find(file => file.path === 'same.txt').mode,
    'executable',
  );
});
