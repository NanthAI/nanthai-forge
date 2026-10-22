// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { submissionOutcome } from '../dist/landing-submission-state.js';
import { submissionOutcome as nativeOutcome, projectSubmission } from '../dist/landing-submission.js';
import { landingObservation } from '../dist/hosted-landing.js';

test('native and hosted landing share the exact S01 observation function and vocabulary', () => {
  assert.equal(nativeOutcome, submissionOutcome);
  for (const [status, reason] of [
    ['queued', 'queued'],
    ['checking', 'checking'],
    ['review-needed', 'waiting-for-review'],
    ['waiting-for-dependency', 'waiting-for-dependency'],
  ]) {
    const observation = landingObservation(status);
    assert.deepEqual(observation, { state: 'pending', pendingReason: reason, cause: null });
    assert.deepEqual(observation, submissionOutcome({ status }));
  }
  for (const [status, cause] of [
    ['conflict', 'conflict'],
    ['failed', 'check-failed'],
    ['runner-unavailable', 'infra'],
    ['interrupted', 'infra'],
    ['cancelled', 'rejected'],
  ])
    assert.deepEqual(landingObservation(status), { state: 'terminal-failed', pendingReason: null, cause });
  assert.equal(landingObservation('failed', 'CHANNEL_CHANGED').cause, 'stale-head');
});

test('native dependency restoration retains S01 immutable submission and attempt identity', () => {
  const lane = { id: randomUUID(), intentId: randomUUID(), head: 'a'.repeat(64) },
    op = randomUUID(),
    attempt = randomUUID();
  const before = projectSubmission(
    op,
    { laneId: lane.id, head: lane.head },
    lane,
    { status: 'checking' },
    attempt,
  );
  const after = projectSubmission(
    op,
    { laneId: lane.id, head: lane.head },
    { ...lane, head: 'b'.repeat(64) },
    { status: 'accepted' },
    attempt,
  );
  assert.equal(after.submissionId, before.submissionId);
  assert.equal(after.attemptId, before.attemptId);
  assert.equal(after.head, before.head);
  assert.equal(after.state, 'superseded');
  assert.equal(after.outcome, 'landed');
  assert.equal(after.complete, false);
});

test('restored native helpers retain exact destination review and batch attempt semantics', async () => {
  const { queuedOutcome, reviewedOutcome, landingAttemptId, submissionLine } =
    await import('../dist/landing-submission.js');
  const moves = [{ viewId: 'view', channel: 'release', status: 'accepted' }];
  const store = {
    page: () => ({ records: moves, nextOffset: null }),
    select: () => ({ viewId: 'view', status: 'passed' }),
  };
  assert.equal(
    queuedOutcome(store, { viewId: 'view', channel: 'release', status: 'awaiting-review', runId: 'run' })
      .status,
    'accepted',
  );
  assert.equal(
    reviewedOutcome(store, { status: 'awaiting-review' }, 'view', 'main').status,
    'awaiting-review',
  );
  assert.equal(landingAttemptId({ id: randomUUID() }), null);
  const entry = { id: randomUUID(), batchId: randomUUID() };
  assert.equal(landingAttemptId(entry), landingAttemptId({ ...entry }));
  assert.notEqual(landingAttemptId(entry), landingAttemptId({ ...entry, batchId: randomUUID() }));
  assert.match(
    submissionLine({
      state: 'pending',
      pendingReason: 'checking',
      cause: null,
      submissionId: '12345678-0000',
      attemptId: '87654321-0000',
    }),
    /pending \(checking\).*12345678.*87654321/,
  );
});
