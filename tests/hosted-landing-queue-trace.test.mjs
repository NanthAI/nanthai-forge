// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCell } from '../scripts/bench-t3code/queue-trace.mjs';
const at = seconds => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
function inputs() {
  const cell = {
    N: 1,
    rep: 1,
    series: 'synthetic',
    taskTimes: [{ task: 't1', seconds: 20 }],
    sourcePins: { cliState: 'a'.repeat(64), secret: 'synthetic-private-narrative' },
    perCell: { timeToMainMedianSeconds: 20, wallSeconds: 30, ciBilledMinutes: 1 },
  };
  const result = {
    startedAt: at(0),
    records: [
      {
        task: 't1',
        worker: 0,
        dispatchedAt: at(10),
        timeToMainSeconds: 20,
        changes: { files: [{ path: 'src/a.ts', source: 'synthetic-private-narrative' }] },
        landing: { receiptId: 'receipt', operations: [{ operationId: 'op', phase: 'landed' }] },
        agent: { sessionId: 'synthetic-private-narrative' },
      },
    ],
    ci: {
      jobRecords: [{ runId: 'provider', startedAt: at(15), completedAt: at(29), conclusion: 'success' }],
    },
  };
  const history = {
    receipts: [
      {
        receiptId: 'receipt',
        submissionId: 'submission',
        submittedAt: at(12),
        committedAt: at(30),
        recomposeCount: 0,
      },
    ],
    histories: [
      {
        submissionId: 'submission',
        pages: [
          {
            page: [
              {
                number: 0,
                candidate: { id: 'candidate' },
                check: { runId: 'run' },
                main: { receiptId: 'base' },
                progress: {
                  phase: 'landed',
                  timing: { composeStartedAt: at(11), composedAt: at(12), settledAt: at(30) },
                },
              },
            ],
          },
        ],
      },
    ],
    runs: [
      {
        runId: 'run',
        value: {
          status: 'passed',
          at: at(14),
          endedAt: at(29),
          executionId: 'provider',
          execution: { seconds: 14 },
          gate: { mode: 'full' },
        },
      },
    ],
  };
  const calls = [
    {
      task: 't1',
      verb: 'agent land --save',
      operationIds: ['op'],
      startedAt: at(11),
      endedAt: at(31),
      code: 0,
    },
  ];
  return { cell, result, history, calls };
}
test('queue trace normalization retains measured durations and caller recovery timing without narrative or source bytes', () => {
  const { cell, result, history, calls } = inputs();
  const trace = normalizeCell(cell, result, history, 'b'.repeat(64), calls);
  assert(trace.coverage.complete);
  assert.equal(trace.tasks[0].arriveAt, 11);
  assert.deepEqual(trace.tasks[0].reactions, [{ start: 11, end: 31, outcome: 'completed' }]);
  assert.equal(trace.checks[0].wallSeconds, 15);
  assert.equal(trace.checks[0].runnerSeconds, 14);
  assert.equal(trace.checks[0].billedMinutes, 1);
  assert.deepEqual(trace.tasks[0].paths, ['src/a.ts']);
  assert(!JSON.stringify(trace).includes('synthetic-private-narrative'));
});
test('missing or invalid check timings stay unqualified instead of becoming zero after JSON serialization', () => {
  const { cell, result, history, calls } = inputs();
  history.runs[0].value.endedAt = null;
  const trace = normalizeCell(cell, result, history, 'b'.repeat(64), calls);
  assert.equal(trace.coverage.complete, false);
  assert(trace.coverage.missing.includes('check-1:timing-or-cost'));
  assert.equal(trace.checks[0].wallSeconds, null);
});
