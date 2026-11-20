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
