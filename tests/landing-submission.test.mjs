// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { projectSubmission, submissionOutcome, landingAttemptId } from '../dist/landing-submission.js';
import { pendingStatus } from '../dist/pending-status.js';

const head = 'a'.repeat(64),
  next = 'b'.repeat(64);

test('queued, checking, review and dependency observations are pending rather than failures', () => {
  for (const [result, pendingReason] of [
    [{ status: 'queued' }, 'queued'],
    [{ status: 'waiting', queueStatus: 'queued' }, 'queued'],
    [{ status: 'waiting', queueStatus: 'checking' }, 'checking'],
    [{ status: 'running' }, 'checking'],
    [{ status: 'review-needed' }, 'waiting-for-review'],
    [{ status: 'awaiting-review' }, 'waiting-for-review'],
    [{ status: 'waiting', dependencies: [{ laneId: 'parent' }] }, 'waiting-for-dependency'],
  ]) {
    assert.deepEqual(submissionOutcome(result), { state: 'pending', pendingReason, cause: null });
  }
});

test('terminal failure classes preserve source, check, infrastructure, stale-head and rejection evidence', () => {
  for (const [result, cause] of [
    [{ status: 'conflict' }, 'conflict'],
    [{ status: 'failed', checkStatus: 'failed' }, 'check-failed'],
    [{ status: 'failed', checkStatus: 'runner-unavailable' }, 'infra'],
    [{ status: 'interrupted', code: 'EVIDENCE_CHANGED' }, 'infra'],
    [{ status: 'retry-exhausted', code: 'CHANNEL_CHANGED' }, 'stale-head'],
    [{ status: 'failed', code: 'LANE_STALE' }, 'stale-head'],
    [{ status: 'failed', code: 'COMPOSITION_STALE' }, 'stale-head'],
    [{ status: 'cancelled' }, 'rejected'],
    [{ status: 'failed', code: 'FORBIDDEN' }, 'rejected'],
  ])
    assert.deepEqual(submissionOutcome(result), { state: 'terminal-failed', pendingReason: null, cause });
});

test('new saves supersede every old-head outcome while preserving immutable submission and attempt pins', () => {
  const lane = { id: randomUUID(), intentId: randomUUID(), head },
    operationId = randomUUID(),
    attemptId = randomUUID();
  for (const status of ['queued', 'failed', 'accepted']) {
    const before = projectSubmission(operationId, { laneId: lane.id, head }, lane, { status }, attemptId);
    const after = projectSubmission(
      operationId,
      { laneId: lane.id, head },
      { ...lane, head: next },
      { status },
      attemptId,
    );
    assert.equal(after.submissionId, before.submissionId);
    assert.equal(after.attemptId, before.attemptId);
    assert.equal(after.head, head);
    assert.equal(after.state, 'superseded');
    assert.equal(after.outcome, before.state);
    assert.equal(after.terminal, true);
    assert.equal(after.complete, false);
  }
});

test('batch adoption retains attempt identity; requeue on a new base gets another attempt', () => {
  const id = randomUUID(),
    batchId = randomUUID();
  assert.equal(landingAttemptId({ id }), null);
  assert.equal(landingAttemptId({ id, batchId }), landingAttemptId({ id, batchId }));
  assert.notEqual(landingAttemptId({ id, batchId }), landingAttemptId({ id, batchId: randomUUID() }));
});

test('legacy queued Work records project the same contract without new stored fields', () => {
  const lane = { id: randomUUID(), intentId: randomUUID(), head, state: 'ready', name: 'Synthetic' };
  const view = { id: randomUUID(), inputs: [{ laneId: lane.id, head }] };
  const data = {
    revision: 1,
    lanes: [lane],
    views: [view],
    runs: [],
    channelMoves: [],
    landingEntries: [{ id: randomUUID(), viewId: view.id, status: 'queued' }],
  };
  const result = pendingStatus(data).lanes[0].submission;
  assert.equal(result.state, 'pending');
  assert.equal(result.pendingReason, 'queued');
  assert.equal(result.terminal, false);
  assert.equal(result.complete, false);
  data.lanes[0] = { ...lane, head: next };
  assert.equal(pendingStatus(data).lanes[0].submission.state, 'superseded');
});

test('review settlement observes the submitted destination Channel', () => {
  const lane = { id: randomUUID(), intentId: randomUUID(), head, state: 'ready', name: 'Synthetic' };
  const view = { id: randomUUID(), inputs: [{ laneId: lane.id, head }] };
  const move = { id: randomUUID(), channel: 'release', viewId: view.id, status: 'accepted', head };
  const data = {
    revision: 1,
    lanes: [lane],
    views: [view],
    runs: [],
    channelMoves: [move],
    landingEntries: [{ id: randomUUID(), viewId: view.id, channel: 'release', status: 'awaiting-review' }],
  };
  assert.equal(pendingStatus(data).lanes[0].submission.state, 'landed');
  data.channelMoves = [{ ...move, channel: 'other' }];
  assert.equal(pendingStatus(data).lanes[0].submission.pendingReason, 'waiting-for-review');
});
