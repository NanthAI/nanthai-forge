// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { LANDING_STALL_MS } from '../dist/landing-stall.js';
import { HOSTED_TRAIN_HOLD_MS } from '../dist/hosted-landing-batch.js';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const batches = f => [...f.tables.projectHostedLandingBatches.values()].map(r => JSON.parse(r.value));
const queueOf = f => [...f.tables.projectHostedLandingQueues.values()][0];
const stateOf = (f, id) => states(f).find(s => s.id === id);
const queueWakes = f => f.pending().filter(t => t.name === 'projectHostedLandingDriver:drive');
async function untilStep(f) {
  for (let tick = 0; f.pending()[0]?.name !== 'projectConvexSource:step'; tick++) {
    assert(tick < 100, 'the source step is reached');
    await f.execute(f.pending()[0]);
  }
}

test('trusted landings pass without a batch by default: each eligible entry checks alone', async t => {
  const f = await batchesFixture(t, { count: 3, batching: false });
  for (let tick = 0; states(f).some(s => s.phase !== 'landed'); tick++) {
    assert(tick < 300, JSON.stringify({ task: f.pending()[0]?.name, phases: states(f).map(s => s.phase) }));
    assert(!(queueOf(f)?.train?.length > 1), 'no multi-entry train forms');
    if (f.runs().some(run => run.status === 'queued')) await f.passChecks();
    await f.execute(f.pending()[0]);
  }
  assert.equal(f.tables.projectHostedLandingBatches.size, 0, 'no batch row');
  assert(states(f).every(s => !s.batchId && !s.batchOriginId));
  // Deferred checks still start at the head of the queue on current main: one
  // check per entry, none discarded by a main race.
  assert.equal(f.runs().length, 3);
  assert(f.runs().every(run => run.status === 'passed'));
  assert(f.runs().every(run => run.gate?.mode !== 'full' || !/batch/i.test(run.gate.reason ?? '')));
});

test('incident replay 2026-10-30: a batch whose compose stays dead cannot block a later entry past the train hold', async t => {
  const f = await batchesFixture(t, { count: 2 });
  await untilStep(f);
  const failedAt = Date.now();
  await assert.rejects(f.execute(f.pending()[0], 'step-fetch-failed'), /fetch failed/);
  const [batch] = batches(f);
  assert.equal(batch.phase, 'composing');
  const members = batch.members.map(m => m.submissionId);
  assert.deepEqual(new Set(queueOf(f).train), new Set(members));

  // Today's shape: a later batchable entry arrives behind the dead train.
  const later = await f.add(2);
  assert.equal(stateOf(f, later.id).phase, 'queued');
  let driverTicks = 0,
    landedAt = null;
  for (let tick = 0; stateOf(f, later.id).phase !== 'landed'; tick++) {
    assert(tick < 200, JSON.stringify({ task: f.pending()[0]?.name, later: stateOf(f, later.id).phase }));
    const task = f.pending()[0];
    assert(task, 'the queue keeps a wake while a later entry waits');
    if (Date.now() < failedAt + HOSTED_TRAIN_HOLD_MS && stateOf(f, later.id).phase === 'queued')
      assert.deepEqual(new Set(queueOf(f).train), new Set(members), 'a live hold keeps the train');
    if (task.name === 'projectConvexSource:step') {
      // The batch compose never recovers: every retry dies the same way.
      await assert.rejects(f.execute(task, 'step-fetch-failed'), /fetch failed/);
      continue;
    }
    if (task.name === 'projectHostedLandingDriver:drive') driverTicks++;
    if (f.runs().some(run => run.status === 'queued')) await f.passChecks();
    await f.execute(task);
    if (stateOf(f, later.id).phase === 'landed') landedAt = Date.now();
  }
  assert(landedAt - failedAt >= HOSTED_TRAIN_HOLD_MS, 'a live compose kept its place for the hold');
  assert(landedAt - failedAt < LANDING_STALL_MS, 'the later entry lands before the 15-minute stall alarm');
  assert.equal(batches(f)[0].phase, 'composing', 'the dead batch is still dead; it did not unblock itself');
  for (const id of members) assert.notEqual(stateOf(f, id).phase, 'landed');
  assert(!queueOf(f).train?.some(id => members.includes(id)), 'the expired train was dropped');
  assert(driverTicks <= 8, `${driverTicks} landing driver ticks`);
  t.diagnostic(JSON.stringify({ landedAfterMs: landedAt - failedAt, driverTicks }));
});

test('a train whose member is checking holds later entries past the hold, then they land in order', async t => {
  const f = await batchesFixture(t, { count: 2 });
  while (!f.runs().length) await f.execute(f.pending()[0]);
  const [batch] = batches(f);
  assert.equal(batch.phase, 'checking');
  const later = await f.add(2);
  // The shared check runs well past the hold; nothing else may start a check on the
  // same main (that would be a main race, not a recovery).
  while (queueWakes(f).length) await f.execute(queueWakes(f)[0]);
  f.advanceClock(HOSTED_TRAIN_HOLD_MS * 2);
  // A new arrival after the hold wakes the queue; the checking train still holds.
  const last = await f.add(3);
  while (queueWakes(f).length) await f.execute(queueWakes(f)[0]);
  assert.equal(f.runs().length, 1, 'no second check while the shared check runs');
  for (const id of [later.id, last.id]) assert.equal(stateOf(f, id).phase, 'queued');
  assert(!queueWakes(f).length, 'no hold wake while a member is checking');
  await f.passChecks();
  for (let tick = 0; states(f).some(s => s.phase !== 'landed'); tick++) {
    assert(tick < 300, JSON.stringify({ task: f.pending()[0]?.name, phases: states(f).map(s => s.phase) }));
    if (f.runs().some(run => run.status === 'queued')) await f.passChecks();
    await f.execute(f.pending()[0]);
  }
  assert(f.runs().length <= 3, `${f.runs().length} checks: one shared, then the later entries`);
  // A passed batch still publishing is live too: no later entry checks on its old main.
  const sharedBase = f.runs()[0].candidate.base.head;
  assert(
    f
      .runs()
      .slice(1)
      .every(run => run.candidate.base.head !== sharedBase),
  );
});
