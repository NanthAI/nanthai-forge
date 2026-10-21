// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { modalUsageCost, MODAL_COST_SAFETY_MARGIN } from '../dist/modal-cost.js';
import { modalMonthCost } from '../dist/check-backend.js';
import { modalRunCost, runnerMonthCosts } from '../dist/check-cost.js';
import { backtest } from '../scripts/modal-cost-backtest.mjs';

const fixture = JSON.parse(readFileSync(new URL('./modal-cost-receipts.json', import.meta.url)));
function estimate(executions, margin = MODAL_COST_SAFETY_MARGIN) {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-B',
        '-c',
        "import json,sys;sys.path.insert(0,'scripts/modal-check');from cost import compute_estimate;print(json.dumps(compute_estimate(**json.load(sys.stdin))))",
      ],
      { input: JSON.stringify({ executions, safety_margin: margin }), encoding: 'utf8' },
    ),
  );
}

test('model uses reserved resources, worker time, fractional seconds and one margin across bridge and reports', () => {
  const executions = [
    { id: 'first', started: 0, ended: 7200, seconds: 30.5, cpu: 2, memory: 4096 },
    { id: 'retry', started: 7200, stopped: 7300, seconds: 10, cpu: 2, memory: 16384 },
    { id: 'cancelled', started: 0, stopped: 20, seconds: 20, cpu: 2, memory: 8192 },
  ];
  const result = estimate([...executions, executions[0]]);
  assert.equal(result.costUsage.length, 3);
  assert.deepEqual(
    result.costUsage.map(item => item.cpuCoreSeconds),
    [61, 20, 40],
  );
  assert.deepEqual(
    result.costUsage.map(item => item.memoryGiBSeconds),
    [122, 160, 160],
  );
  const raw = 121 * 0.00003942 + 442 * 0.00000667;
  assert.ok(Math.abs(result.estimatedCostUsd - raw * MODAL_COST_SAFETY_MARGIN) < 1e-12);
  const backend = { requested: 'modal', actual: 'modal', ...result };
  const run = { id: 'run', startedAt: '2026-10-01', backend };
  assert.ok(Math.abs(modalRunCost(backend).estimatedCostUsd - result.estimatedCostUsd) < 1e-12);
  assert.ok(
    Math.abs(modalMonthCost([run, run], new Date('2026-10-20')).estimatedCostUsd - result.estimatedCostUsd) <
      1e-12,
  );
  assert.ok(
    Math.abs(runnerMonthCosts([run, run]).months[0].estimatedCostUsd - result.estimatedCostUsd) < 1e-12,
  );
  assert.match(modalRunCost(backend).basis, /estimate \(conservative\)/);
  assert.ok(result.costUsage.every(item => item.safetyMargin === MODAL_COST_SAFETY_MARGIN));
});

test('missing cancelled runtime uses bounded controller time and keeps legacy margin unchanged', () => {
  const result = estimate([{ id: 'cancelled', started: 0, stopped: 86400 }], 1);
  assert.equal(result.costUsage[0].seconds, 900);
  assert.equal(result.costUsage[0].basis, 'controller-time');
  assert.equal(modalUsageCost({ cpuCoreSeconds: 1800, memoryGiBSeconds: 3600 }), result.estimatedCostUsd);
});

test('anonymised October receipts cannot establish usage or a calibrated historical total', () => {
  const executions = fixture.executions;
  const old = estimate(executions, 1).estimatedCostUsd;
  const run = { id: 'old', startedAt: '2026-10-19', backend: { actual: 'modal', estimatedCostUsd: old } };
  const report = backtest([run], () => ({ executions }), '2026-10-19');
  assert.equal(report.oldEstimateUsd, old);
  assert.equal(report.recomputedEstimateUsd, null);
  assert.equal(report.missingWorkerRuntimeExecutions, 3);
  assert.equal(modalRunCost(run.backend).estimatedCostUsd, old);
  const measured = executions.map(item => ({ ...item, seconds: item.ended - item.started }));
  const complete = backtest([run], () => ({ executions: measured }), '2026-10-19');
  assert.ok(Math.abs(complete.recomputedEstimateUsd - old * MODAL_COST_SAFETY_MARGIN) < 1e-12);
});

test('back-test counts missing journals and impossible controller lifetimes without guessing spend', () => {
  const run = id => ({ id, startedAt: '2026-10-19', backend: { estimatedCostUsd: 1 } });
  const report = backtest(
    [run('missing'), run('delayed')],
    id =>
      id === 'missing'
        ? undefined
        : {
            executions: [{ id: 'delayed', started: 0, ended: 3600 }],
          },
    '2026-10-19',
  );
  assert.equal(report.missingJournals, 1);
  assert.equal(report.controllerOverLifetimeSeconds, 2700);
  assert.equal(report.recomputedEstimateUsd, null);
});
