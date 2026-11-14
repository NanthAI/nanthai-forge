// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  submissionTimings,
  operationTiming,
  executedErrorCodes,
} from '../scripts/bench-t3code/operation-timing.mjs';
test('failed-operation collection retains exact receipt phases and outer command wall separately', () => {
  const output = JSON.stringify({
    action: 'finish',
    result: {
      submission: {
        operationId: 'op-a',
        phase: 'terminal-failed',
        timing: {
          submittedAt: '2026-01-01T00:00:01Z',
          selectedAt: '2026-01-01T00:00:03Z',
          settledAt: '2026-01-01T00:00:08Z',
        },
      },
      wouldConflict: { operationId: 'other', timing: { selectedAt: 'wrong' } },
    },
  });
  const evidence = submissionTimings(output);
  assert.equal(evidence.length, 1);
  const value = operationTiming('op-a', {}, [
    {
      operations: [{ action: 'finish', operationId: 'op-a' }],
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:00:10Z',
      submissionTimings: evidence,
    },
  ]);
  assert.equal(value.timing.selectedAt, '2026-01-01T00:00:03Z');
  assert.equal(value.commandTiming[0].wallMs, 10000);
  assert.equal(value.timing.checkReservedAt, undefined);
});
test('failure timing never borrows an unrelated operation or invents missing CI/predecessor clocks', () => {
  const value = operationTiming('op-a', null, [
    { submissionTimings: [{ operationId: 'op-b', timing: { checkReservedAt: 'wrong' } }] },
  ]);
  assert.deepEqual(value, { timing: {}, commandTiming: [] });
  const value2 = operationTiming('op-a', { settledAt: 'observed' }, [
    { submissionTimings: [{ operationId: 'op-a', timing: { settledAt: 'old' } }] },
  ]);
  assert.equal(value2.timing.settledAt, 'observed');
});

test('relay code evidence ignores speculative advice without dropping sibling terminal errors', () => {
  const advisory = {
    type: 'submission',
    phase: 'queued',
    wouldConflict: { code: 'COMPOSITION_CONFLICT', predecessor: { groupId: 'synthetic' } },
  };
  assert.deepEqual(executedErrorCodes(JSON.stringify(advisory)), []);
  assert.deepEqual(
    executedErrorCodes(JSON.stringify(advisory) + '\n' + JSON.stringify({ error: { code: 'CHECK_FAILED' } })),
    ['CHECK_FAILED'],
  );
});

test('Forge settlement restores failed receipt clocks without adding an observer call', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { forgeArm } = await import('../scripts/bench-t3code/forge-arm.mjs');
  const root = mkdtempSync(join(tmpdir(), 'failed-timing-')),
    log = join(root, 'calls.jsonl');
  try {
    writeFileSync(
      log,
      JSON.stringify({
        task: 'synthetic',
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:00:08Z',
        operations: [{ action: 'finish', operationId: 'failed-op' }],
        submissionTimings: [
          {
            operationId: 'failed-op',
            phase: 'terminal-failed',
            timing: { submittedAt: '2026-01-01T00:00:01Z', settledAt: '2026-01-01T00:00:07Z' },
          },
        ],
      }) + '\n',
    );
    const arm = forgeArm({}, { ws: root, callLog: log });
    let calls = 0;
    arm.observe = async () => {
      calls++;
      return { phase: 'terminal-failed', timing: {}, error: { code: 'COMPOSITION_CONFLICT' } };
    };
    const result = await arm.landing('synthetic', 'lane', { deadlineMs: 0 });
    assert.equal(calls, 1);
    assert.equal(result.operations[0].timing.settledAt, '2026-01-01T00:00:07Z');
    assert.equal(result.operations[0].commandTiming[0].wallMs, 8000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed timing does not borrow clocks from another attempt of the same operation', () => {
  const rows = [
    { submissionTimings: [{ operationId: 'op', attemptId: 'old', timing: { checkReservedAt: 'wrong' } }] },
  ];
  assert.deepEqual(operationTiming('op', {}, rows, 'current').timing, {});
});
