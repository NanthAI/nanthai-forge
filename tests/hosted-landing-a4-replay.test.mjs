// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { landingApi } from './hosted-finish-fixture.mjs';
import { driver } from './hosted-landing-fixture.mjs';
import { assertQueueProgress } from './queue-sim/invariants.mjs';

const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const batchRows = f => [...f.tables.projectHostedLandingBatches.values()].map(row => JSON.parse(row.value));
const rowsById = f =>
  new Map([...f.tables.projectHostedLandingRequests.values()].map(row => [row.submissionId, row]));
const queueRow = f => [...f.tables.projectHostedLandingQueues.values()][0];

const withdraw = (f, submissionId) =>
  f.tx('a4Cancel', landingApi.cancel, {
    projectId: f.projectId,
    request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId }),
  });

async function drainWithoutAlarms(f) {
  for (let step = 0; ; step++) {
    const task = f.pending().find(task => !task.name.startsWith('projectHostedLandingStall:'));
    if (!task) return;
    assert(step < 200, 'ordinary queue events drain without the stall alarm');
    await f.execute(task);
  }
}

async function claimNext(f, submissionId) {
  const task = f.pending().find(task => task.name === 'projectHostedLandingDriver:drive');
  assert(task);
  await f.advanceToTask(task);
  f.patch('_scheduled_functions', task._id, { state: { kind: 'inProgress' } });
  const claim = await f.tx('a4Claim', driver.claim, task.args[0]);
  assert.equal(claim?.submissionId, submissionId);
  return async () => {
    await f.tx('a4Advance', driver.advance, claim);
    f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
  };
}

async function deliverCheckWake(f, runId) {
  const task = f
    .pending()
    .find(task => task.name === 'projectHostedLandingDriver:checkWake' && task.args[0].runId === runId);
  assert(task);
  await f.execute(task);
}

test('a4 overlap: a progress wake cannot pull a checking solo head into a cohort', async t => {
  const shared = 'export const a = 0;\n// gap\nexport const b = 0;\n';
  const f = await batchesFixture(t, {
    count: 1,
    memberPaths: ['member-0', 'member-1', 'member-2', 'src/shared.ts', 'src/shared.ts'],
    baselineFiles: [['src/shared.ts', shared]],
    memberContents: [
      'head',
      'first descendant',
      'second descendant',
      shared.replace('a = 0', 'a = 1'),
      shared.replace('b = 0', 'b = 1'),
    ],
  });
  await drainWithoutAlarms(f);
  const [head] = states(f);
  assert.equal(head.phase, 'checking');
  assert.equal(head.batchId, undefined);
  const headRun = await f.rawChecks.activate(rowsById(f).get(head.id).runId, 2);
  await drainWithoutAlarms(f);
  for (const index of [1, 2]) {
    await f.add(index);
    await drainWithoutAlarms(f);
  }
  const before = states(f);
  assert(before.every(state => state.phase === 'checking'));
  assert.deepEqual(
    batchRows(f).map(batch => batch.predecessor?.submissionId),
    [before[0].id, before[1].id],
  );
  const attemptRuns = before.map(state => rowsById(f).get(state.id).runId);
  f.advanceClock(61_000);
  const selected = await f.add(3);
  const peer = await f.add(4);
  const advance = await claimNext(f, selected.id);
  await f.rawChecks.callback(f.rawChecks.shard(headRun, 0));
  await deliverCheckWake(f, headRun.id);
  const woken = rowsById(f).get(head.id);
  assert.equal(woken.runnable, true, 'progress wakes the solo between claim and advance');
  const projectedBatchable = woken.batchable;
  // An in-flight row written before the fix may still carry the old index flag.
  f.patch('projectHostedLandingRequests', woken._id, { batchable: true });
  await advance();

  assert.deepEqual(
    states(f)
      .slice(0, 3)
      .map(state => ({
        submissionId: state.id,
        phase: state.phase,
        attemptId: state.attemptId,
        batchId: state.batchId,
        selectedAt: state.timing?.selectedAt,
        runId: rowsById(f).get(state.id).runId,
      })),
    before.map((state, index) => ({
      submissionId: state.id,
      phase: 'checking',
      attemptId: state.attemptId,
      batchId: state.batchId,
      selectedAt: state.timing?.selectedAt,
      runId: attemptRuns[index],
    })),
    'the solo and both speculative descendants retain their original checks and positions',
  );
  assert.equal(projectedBatchable, false, 'the normal checking write clears batchability');
  assert.deepEqual(
    batchRows(f).map(batch => batch.phase),
    ['checking', 'checking', 'composing'],
  );
  const successor = batchRows(f).at(-1);
  assert.equal(successor.predecessor?.submissionId, before[2].id);
  assert.deepEqual(
    successor.members.map(member => member.submissionId),
    [selected.id, peer.id],
  );
});

test('a4 overlap: a parked fallback and its queued siblings cannot strand older work', async t => {
  const shared = Array.from({ length: 5 }, (_, index) => `export const v${index} = 0;`).join('\n\n') + '\n';
  const f = await batchesFixture(t, {
    count: 1,
    memberPaths: Array(5).fill('src/shared.ts'),
    baselineFiles: [['src/shared.ts', shared]],
    memberContents: Array.from({ length: 5 }, (_, index) => shared.replace(`v${index} = 0`, `v${index} = 1`)),
  });
  const [older] = states(f);
  const olderRow = rowsById(f).get(older.id);
  // Keep the older entry visible to landing order while the younger cohort starts.
  f.patch('projectHostedLandingRequests', olderRow._id, { runnable: false });
  const first = await f.add(1);
  const siblings = [await f.add(2), await f.add(3)];
  const cancelled = await f.add(4);
  await drainWithoutAlarms(f);
  const [cohort] = batchRows(f);
  assert.equal(cohort.phase, 'checking');
  assert.deepEqual(
    cohort.members.map(member => member.submissionId),
    [first.id, ...siblings.map(s => s.id), cancelled.id],
  );
  await withdraw(f, cancelled.id);
  await drainWithoutAlarms(f);
  assert.equal(batchRows(f)[0].phase, 'fallback');
  const active = rowsById(f).get(first.id);
  assert.equal(active.phase, 'checking');
  assert.notEqual(active.runId, cohort.runId);
  await f.rawChecks.pass(await f.rawChecks.activate(active.runId));
  await deliverCheckWake(f, active.runId);
  const advance = await claimNext(f, first.id);
  f.patch('projectHostedLandingRequests', olderRow._id, { runnable: true });
  await advance();
  await drainWithoutAlarms(f);
  const parked = rowsById(f).get(first.id);
  assert.equal(parked.phase, 'ready');
  assert.equal(parked.runnable, false);
  assert.equal(parked.orderWait, older.id);
  for (const sibling of siblings) {
    const row = rowsById(f).get(sibling.id);
    assert.equal(row.phase, 'queued');
    assert.equal(row.runnable, false);
    assert.equal(states(f).find(state => state.id === sibling.id).batchNeedsSoloCompose, true);
  }

  const externalRuns = new Set(
    f
      .runs()
      .filter(run => ['queued', 'running'].includes(run.status))
      .map(run => run.id),
  );
  await assertQueueProgress(f, { alarmOwns: false, externalRuns });
  assert.equal(rowsById(f).get(older.id).phase, 'checking');

  const survivors = [older, first, ...siblings];
  for (let wave = 0; survivors.some(entry => rowsById(f).get(entry.id).phase !== 'landed'); wave++) {
    assert(wave < survivors.length + 1, 'the released siblings finish one at a time');
    await f.passChecks();
    await drainWithoutAlarms(f);
  }
  const receipts = [...f.tables.projectHostedAcceptances.values()].map(row => JSON.parse(row.value));
  assert.deepEqual(
    receipts.map(receipt => receipt.submissionId),
    survivors.map(entry => entry.id),
  );
  assert.equal(new Set(receipts.map(receipt => receipt.check.runId)).size, survivors.length);
  assert.equal(batchRows(f)[0].phase, 'landed');
  assert.equal(f.pending().length, 0, 'the settled queue has no idle wakes or alarms');
});

test('a4 split: withdrawing a solo preserves the sibling cohort as a speculative predecessor', async t => {
  const f = await batchesFixture(t, { count: 3 });
  await drainWithoutAlarms(f);
  const [original] = batchRows(f);
  await f.fail(original.runId, 'tests/shared.test.mjs');
  await drainWithoutAlarms(f);
  const [split, child] = batchRows(f);
  assert.equal(split.phase, 'split');
  assert.equal(child.phase, 'checking');
  assert.equal(child.parentId, split.id);
  assert.equal(child.members.length, 2);
  const childIds = child.members.map(member => member.submissionId);
  const solo = states(f).find(state => state.batchOriginId === split.id && !state.batchId);
  assert.equal(solo?.phase, 'checking');

  await withdraw(f, solo.id);
  assert(
    childIds.every(id => queueRow(f).train.includes(id)),
    'the live child keeps its train slots',
  );
  assert.equal(batchRows(f)[0].phase, 'split', 'the split parent keeps its recorded outcome');
  const successor = await f.add(3);
  await drainWithoutAlarms(f);
  const stacked = batchRows(f).find(batch =>
    batch.members.some(member => member.submissionId === successor.id),
  );
  assert.equal(stacked?.predecessor?.submissionId, childIds.at(-1));
  assert(
    childIds.every(id => rowsById(f).get(id).runId === child.runId),
    'the child keeps its exact check',
  );

  await f.passChecks();
  await drainWithoutAlarms(f);
  assert.equal(states(f).find(state => state.id === solo.id).error.code, 'LANDING_CANCELLED');
  assert.deepEqual(
    states(f)
      .filter(state => state.phase === 'landed')
      .map(state => state.id),
    [...childIds, successor.id],
  );
  assert.equal(f.pending().length, 0);
});
