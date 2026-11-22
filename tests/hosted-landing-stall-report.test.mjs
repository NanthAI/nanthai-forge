// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { landingStallReport, landSummary } from '../dist/hosted-land-summary.js';

const stall = {
  code: 'LANDING_STALLED',
  step: 'composing',
  missingOwner: 'source worker and compose controller',
  lastProgressAt: '2026-11-20T04:05:00.000Z',
  alarmAt: '2026-11-20T04:20:00.000Z',
  message: 'Landing made no progress for 15 minutes while composing.',
};
const sourceFailure = {
  step: 1,
  code: 'SOURCE_JOB_FENCED',
  stage: 'small-save',
  exception: 'ForgeError',
  attempts: 2,
  maxAttempts: 6,
  retryAt: '2026-11-20T04:21:00.000Z',
};
const pending = observation => ({
  result: {
    phase: 'finish',
    submission: {
      phase: 'composing',
      observation: { state: 'pending', pendingReason: 'composing', ...observation },
    },
    ...(observation.stall ? { sourceFailure } : {}),
  },
});

test('incident replay e62d834b (friction c7f3afac): a stalled landing wait names the stall, the failed source step and the replay', () => {
  const report = landingStallReport(
    { submission: { observation: { stall } }, sourceFailure },
    { root: '/repo', action: 'land', command: { laneId: 'lane-1', message: 'm' }, operationId: 'op-1' },
  );
  assert(report, 'a stalled landing is reported, not silent');
  assert.equal(report.lines[0], `STALLED LANDING_STALLED: ${stall.message}`);
  assert.match(report.lines[1], /^Source step 1 failed: SOURCE_JOB_FENCED at small-save \(attempt 2 of 6\)/);
  assert(report.lines[1].endsWith('Next try from 2026-11-20T04:21:00.000Z.'));
  assert.match(report.lines[2], /land '\{"laneId":"lane-1","message":"m","operationId":"op-1"\}'$/);
  assert.match(report.lines[3], /sync '\{"laneId":"lane-1"\}'$/, 'a far-behind Lane is told to sync');
  assert.equal(report.stall.sourceFailure.code, 'SOURCE_JOB_FENCED');
  assert.match(report.stall.replayCommand, /"operationId":"op-1"/);
  assert.equal(landingStallReport({ submission: { observation: {} } }), undefined, 'no stall, no report');
});

test('incident replay e62d834b (friction c7f3afac): a pending land reply carries the stall and its source failure', () => {
  const lines = landSummary(pending({ stall }));
  assert(lines.includes(`STALLED LANDING_STALLED: ${stall.message}`), lines.join('\n'));
  assert(
    lines.some(line => line.startsWith('Source step 1 failed: SOURCE_JOB_FENCED')),
    lines.join('\n'),
  );
  assert(!landSummary(pending({})).some(line => line.startsWith('STALLED')), 'a healthy wait adds nothing');
});

test('Issue 9a04d916: a failed compose without a recorded retry time reports an unknown schedule and preserves the original replay', () => {
  const { retryAt, ...failure } = { ...sourceFailure, code: 'SOURCE_WORKER_STEP_FAILED' };
  const reply = pending({ stall });
  reply.result.sourceFailure = failure;
  const report = landingStallReport(reply.result, {
    root: '/repo with spaces',
    action: 'finish',
    command: {
      laneId: '386a0edf-a9d9-47d2-b412-59051075b45f',
      message: 'Keep the original capture',
      accept: true,
    },
    operationId: '77054f3e-87a7-4030-97c3-487c8434650e',
  });
  const failureLine =
    'Source step 1 failed: SOURCE_WORKER_STEP_FAILED at small-save (attempt 2 of 6). Retry schedule unknown.';
  assert.equal(report.lines[1], failureLine);
  assert(landSummary(reply).includes(failureLine));
  assert.deepEqual(report.stall.sourceFailure, failure);
  assert.equal(
    report.stall.replayCommand,
    `nforge agent '/repo with spaces' finish '{"laneId":"386a0edf-a9d9-47d2-b412-59051075b45f","message":"Keep the original capture","accept":true,"operationId":"77054f3e-87a7-4030-97c3-487c8434650e"}'`,
  );
  assert(report.lines[2].endsWith(report.stall.replayCommand));
});
