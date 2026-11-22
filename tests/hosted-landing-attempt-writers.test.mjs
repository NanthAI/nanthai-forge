// SPDX-License-Identifier: Apache-2.0
// Issue ced8e98f follow-up (receipt a58539d0): two attempt-ledger writers that only the
// typecheck covered. Each test fails when its writer is removed.
// 1. A protected-review park records the holder it waits for (`orderWaits`), like the claim path.
// 2. A cohort platform retry that recomposes on a moved main installs `provider-retry` with the retired run.
import assert from 'node:assert/strict';
import test from 'node:test';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const api = await import(moduleUrl('../convex/projectHostedLandingAttemptHistory.ts'));
const { advanceLandingQueue } = await import(moduleUrl('../convex/projectHostedLandingControl.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const read = (f, submissionId) =>
  f.tx('attempt-history', api.read, { projectId: f.projectId, submissionId }).then(JSON.parse);
const rowOf = (f, submissionId) =>
  [...f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === submissionId);

test('a protected-review park records the approved check it waits for, so the history names the holder', async t => {
  const f = await finishFixture(t);
  const holder = await f.enqueue(f.request({ check: null, message: 'Holds the approved-check turn' }));
  const waiter = await f.enqueue(f.request({ check: null, message: 'Protected review parked behind it' }));
  const waiterRow = rowOf(f, waiter.id);
  const attemptRow = [...f.tables.projectHostedLandingAttempts.values()].find(
    row => row.submissionId === waiter.id,
  );
  // The approved holder owns the publication turn; the waiter is an owner-approved entry whose
  // check is deferred. Its queue lease is real, so the park runs through the controller's advance.
  const queueRow = [...f.tables.projectHostedLandingQueues.values()][0];
  f.patch('projectHostedLandingRequests', rowOf(f, holder.id)._id, { exactReview: true });
  f.patch('projectHostedLandingRequests', waiterRow._id, { earlyReview: true });
  f.patch('projectHostedLandingAttempts', attemptRow._id, {
    value: JSON.stringify({ ...JSON.parse(attemptRow.value), deferredCheck: true }),
  });
  f.patch('projectHostedLandingQueues', queueRow._id, {
    exactReview: holder.id,
    lease: {
      owner: 'synthetic-owner',
      token: 1,
      until: f.now() + 60_000,
      submissionId: waiter.id,
      attemptId: waiterRow.attemptId,
    },
  });
  const claim = {
    projectId: f.projectId,
    channel: waiterRow.channel,
    owner: 'synthetic-owner',
    token: 1,
    submissionId: waiter.id,
    attemptId: waiterRow.attemptId,
  };
  const parked = await f.transaction(
    'park-protected-review',
    { _handler: ctx => advanceLandingQueue(ctx, claim, f.now()) },
    {},
  );
  assert.equal(parked.id, waiter.id, 'the controller advance parked the waiter');
  const waits = rowOf(f, waiter.id).orderWaits;
  assert.equal(waits?.length, 1, 'the park keeps one wait record, as the claim path does');
  assert.equal(waits[0].submissionId, holder.id);
  assert.equal(waits[0].held, 'approved-check');
  assert.equal(rowOf(f, waiter.id).orderWait, holder.id);
  assert.equal(rowOf(f, holder.id).orderWaited, true, 'the holder is marked as waited for');
  const history = await read(f, waiter.id);
  assert.equal(history.holdEdges.length, 1, 'the history lists the hold, not unrecorded');
  assert.equal(history.holdEdges[0].holderSubmissionId, holder.id);
});

test('a cohort platform retry on a moved main installs provider-retry linked to the retired run', async t => {
  const f = await batchesFixture(t, { count: 3, batching: 'default', batchMaxSize: null });
  for (let steps = 0; f.pending().length; steps++) {
    assert(steps < 400, 'bounded queue progress');
    await f.execute(f.pending()[0]);
  }
  const [head] = f.runs();
  assert.equal(f.runs().length, 1, 'one shared cohort check');
  const members = states(f).map(state => ({ id: state.id, attemptId: state.attemptId }));
  assert.equal(members.length, 3, 'every fixture member shares the check');
  const attemptValue = id =>
    [...f.tables.projectHostedLandingAttempts.values()]
      .map(row => JSON.parse(row.value))
      .find(attempt => attempt.id === id);
  for (const member of members)
    assert.equal(
      attemptValue(member.attemptId)?.check?.runId,
      head.id,
      'each member attempt is bound to the shared run before the retry',
    );
  const live = await f.rawChecks.activate(head.id);
  const moved = f.moveMain();
  await f.rawChecks.callback(f.rawChecks.complete(live, 'runner-unavailable'));
  for (let steps = 0; f.pending().length; steps++) {
    assert(steps < 400, 'bounded queue progress');
    await f.execute(f.pending()[0]);
  }
  const retry = f.runs().find(run => run.id !== head.id);
  assert.ok(retry, 'the cohort rechecks on the moved main');
  assert.equal(retry.candidate.base.head, moved.head, 'the retry is composed on the moved main');
  for (const member of members) {
    const attempts = (await read(f, member.id)).attempts;
    const retired = attempts.find(attempt => attempt.id === member.attemptId);
    assert.ok(retired, 'the retired attempt stays in the history');
    assert.equal(retired.replay.outcome, 'censored');
    assert.deepEqual(
      retired.replay.replacementCause,
      { kind: 'provider-retry', link: head.id },
      'a platform retry links the retired run, not check-binding',
    );
  }
});
