// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { actionsCost, actionsRate, modalRunCost } from '../dist/check-cost.js';
import { trainAccounting } from '../dist/train-accounting.js';
const T = seconds => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const cost = (id, seconds = 61, retry = false) =>
  actionsCost('blacksmith-4vcpu-ubuntu-2404', actionsRate('blacksmith-4vcpu-ubuntu-2404'), [
    { id, status: 'completed', started_at: T(10), completed_at: T(10 + seconds), retry },
  ]);
const run = (id, usage, extra = {}) => ({
  id,
  startedAt: T(10),
  queuedAt: T(5),
  endedAt: T(71),
  backend: { actual: 'github-actions', requested: 'github-actions', cost: usage },
  ...extra,
});
const batch = (id, status, runIds, entries = ['a', 'b']) => ({
  id,
  status,
  entryIds: entries,
  prefixes: runIds.map((runId, i) => ({
    runId,
    entryIds: i === runIds.length - 1 ? entries : entries.slice(0, i + 1),
  })),
});

test('a shared execution counts once across submissions, adoption and completed observations', () => {
  const unknown = actionsCost('blacksmith-4vcpu-ubuntu-2404', 0.008, [{ id: 1, status: 'running' }]);
  const runs = [run('early', unknown), run('shared', cost(1)), run('adopted', cost(1))];
  const result = trainAccounting(runs, {
    batches: [batch('b', 'completed', ['shared'])],
    entries: ['a', 'b'].map(id => ({ id, status: 'accepted', arrivedAt: T(0), acceptanceId: 'move' })),
    moves: [{ id: 'move', status: 'accepted', at: T(80) }],
  });
  assert.equal(result.total.executions, 1);
  assert.equal(result.total.knownGrossCostUsd, 0.016);
  assert.equal(result.total.unknownCostExecutions, 0);
  assert.equal(result.categories.landing.executions, 1);
  assert.equal(result.categories.landing.executingSeconds, 61);
  assert.equal(result.categories.landing.billedMinutes, 2);
  assert.equal(result.categories.landing.allowanceUnits, 4);
  assert.equal(result.submissions.length, 2);
  assert.ok(result.submissions.every(row => row.queueWaitMs === 5000 && row.endToEndMs === 80000));
});

test('retry and superseded speculation are exclusive physical costs, with diagnosis and audit separate', () => {
  const result = trainAccounting(
    [
      run('probe', cost(1)),
      run('full', cost(2)),
      run('retry', cost(3, 61, true)),
      run('invalidated', cost(4)),
      run('adopted-invalidated', cost(4)),
      run('audit', cost(5), { mainCheck: { channel: 'main' } }),
    ],
    {
      batches: [
        batch('b', 'completed', ['probe', 'full']),
        batch('c', 'completed', ['retry']),
        batch('d', 'superseded', ['invalidated']),
      ],
    },
  );
  assert.equal(result.total.executions, 5);
  for (const category of ['diagnosis', 'landing', 'retry', 'invalidated-speculation', 'audit'])
    assert.equal(result.categories[category].executions, 1);
  assert.equal(result.total.netEstimatedCostUsd, null);
  assert.equal(result.total.remainingSharedAllowance, 'unknown');
});

test('unknown rate, timing and legacy identity never become zero-cost or known net', () => {
  const usage = actionsCost('unknown-label', null, [
    { id: 9, status: 'completed', started_at: T(1), completed_at: T(70) },
  ]);
  const result = trainAccounting([
    run('unknown', usage),
    { id: 'legacy', startedAt: T(0), backend: { actual: 'github-actions' } },
  ]);
  assert.equal(result.total.unknownCostExecutions, 2);
  assert.equal(result.total.unidentifiedRuns, 1);
  assert.equal(result.categories.other.billedMinutes, 2);
  assert.equal(result.categories.other.unknownMinutesExecutions, 1);
  assert.equal(result.total.netEstimatedCostUsd, null);
});

test('wait time follows recorded submission outcome, not a completed check or newer head', () => {
  const runs = [run('check', cost(1))];
  const context = {
    batches: [batch('b', 'completed', ['check'], ['pending', 'failed', 'cancelled', 'accepted'])],
    entries: ['pending', 'failed', 'cancelled', 'accepted'].map(id => ({
      id,
      viewId: id,
      status: id === 'pending' ? 'awaiting-review' : id,
      arrivedAt: T(0),
      firstSelectedAt: T(3),
      terminalAt: id === 'failed' ? T(95) : undefined,
      runId: 'check',
      acceptanceId: id === 'accepted' ? 'move' : undefined,
    })),
    moves: [{ id: 'move', status: 'accepted', at: T(90) }],
  };
  const result = trainAccounting(runs, context, new Date(T(100)));
  assert.equal(result.submissions[0].endToEndMs, null);
  assert.equal(result.submissions[0].pendingAgeMs, 100000);
  assert.equal(result.submissions[1].endToEndMs, 95000);
  assert.equal(result.submissions[1].queueWaitMs, 3000);
  assert.equal(result.submissions[1].queueBasis, 'submission-state');
  assert.equal(
    result.submissions[2].endToEndMs,
    null,
    'cancelled job end is not submission cancellation time',
  );
  assert.equal(result.submissions[3].endToEndMs, 90000);
  assert.equal(result.latency.endToEnd.observed, 2);
});

test('Modal attempt metadata classifies replacement usage without counting shared executions twice', () => {
  const usage = modalRunCost({
    actual: 'modal',
    costUsage: [0, 1].map(attempt => ({
      executionId: `sandbox-${attempt}`,
      attempt,
      seconds: 10,
      cpuCoreSeconds: 20,
      memoryGiBSeconds: 40,
      basis: 'worker-runtime',
    })),
  });
  const result = trainAccounting([run('r', usage), run('adopt', usage)], {
    batches: [batch('b', 'completed', ['r'])],
  });
  assert.equal(result.total.executions, 2);
  assert.equal(result.categories.landing.executions, 1);
  assert.equal(result.categories.retry.executions, 1);
  assert.equal(result.categories.retry.executingSeconds, 10);
});

test('legacy failed checks do not invent submission terminal timestamps', () => {
  const result = trainAccounting([run('check', cost(1))], {
    entries: [{ id: 'legacy', status: 'failed', arrivedAt: T(0), runId: 'check' }],
  });
  assert.equal(result.submissions[0].endToEndMs, null);
});

test('retained Modal usage stays charged when a legacy run eventually used local fallback', () => {
  const backend = {
    actual: 'local',
    requested: 'modal',
    costUsage: [
      {
        executionId: 'fallback-sandbox',
        seconds: 10,
        cpuCoreSeconds: 20,
        memoryGiBSeconds: 40,
        basis: 'worker-runtime',
        attempt: 0,
      },
    ],
  };
  const result = trainAccounting([{ id: 'fallback', startedAt: T(0), backend }]);
  assert.equal(result.total.executions, 1);
  assert.equal(result.total.unknownCostExecutions, 0);
  assert.equal(result.total.knownGrossCostUsd, 20 * 0.00003942 + 40 * 0.00000667);
});
