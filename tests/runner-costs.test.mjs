// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actionsCost,
  actionsRate,
  localCost,
  retainedRunCost,
  runnerMonthCosts,
} from '../dist/check-cost.js';
import { editedPolicy, policyPreset } from '../dist/autonomy-policy.js';
import { receiptSchema, createRunReceipt } from '../dist/work-run-receipt.js';
const job = (id, seconds, patch = {}) => ({
  id,
  status: 'completed',
  started_at: '2026-10-01T12:00:00Z',
  completed_at: new Date(Date.parse('2026-10-01T12:00:00Z') + seconds * 1000).toISOString(),
  ...patch,
});

test('Blacksmith cost uses job timestamps, per-job rounding, CPU multiplier and retained retries', () => {
  const label = 'blacksmith-4vcpu-ubuntu-2404';
  const jobs = [41, 183, 128, 170, 146].map((seconds, index) => job(index + 1, seconds));
  const cost = actionsCost(label, actionsRate(label), [...jobs, jobs[0]]);
  assert.equal(cost.billedMinutes, 14);
  assert.equal(cost.billedSeconds, 840);
  assert.ok(Math.abs(cost.estimatedCostUsd - 0.112) < 1e-12);
  assert.match(cost.basis, /3,000 free 2-vCPU minutes/);
  assert.match(cost.basis, /GitHub API billable minutes can be zero/);
  assert.equal(actionsCost(label, actionsRate(label), [...jobs, job(100, 61)]).billedMinutes, 16);
  assert.equal(actionsRate('blacksmith-2vcpu-ubuntu-2404'), 0.004);
});

test('Actions rates can be overridden by label and missing timing/rates remain unknown', () => {
  assert.equal(actionsRate('ubuntu-latest'), 0.006);
  assert.equal(actionsCost('ubuntu-latest', 0.006, [job(1, 61)]).estimatedCostUsd, 0.012);
  const policy = editedPolicy(policyPreset('trusted'), {
    checks: {
      runner: 'github-actions',
      repo: 'synthetic/runner',
      runsOn: 'custom',
      ratesUsdPerMinute: { custom: 0.003 },
    },
  });
  assert.equal(
    actionsCost('custom', policy.checks.ratesUsdPerMinute.custom, [job(1, 61)]).estimatedCostUsd,
    0.006,
  );
  assert.equal(actionsCost('custom', actionsRate('custom'), [job(1, 61)]).estimatedCostUsd, null);
  for (const patch of [
    { started_at: null },
    { completed_at: 'invalid' },
    { status: 'in_progress' },
    { completed_at: '2020-01-01' },
  ]) {
    assert.equal(actionsCost('ubuntu-latest', 0.006, [job(1, 61, patch)]).billedMinutes, null);
  }
  assert.equal(actionsCost('ubuntu-latest', 0.006, []).estimatedCostUsd, null);
});

test('monthly status separates months/runners, deduplicates executions and counts unknown/legacy inputs', () => {
  const cost = actionsCost('blacksmith-2vcpu-ubuntu-2404', 0.004, [job(1, 61)]);
  const run = (id, month, backend) => ({ id, startedAt: `${month}-01T00:00:00Z`, backend });
  const summary = runnerMonthCosts([
    run('a', '2026-10', { actual: 'github-actions', cost }),
    run('adopt', '2026-10', { actual: 'github-actions', cost }),
    run('local', '2026-09', { actual: 'local', cost: localCost('local') }),
    run('legacy', '2026-10', { actual: 'modal', estimatedCostUsd: 1 }),
    run('unknown', '2026-10', { actual: 'github-actions' }),
  ]);
  const actions = summary.months.find(row => row.label);
  assert.equal(actions.estimatedCostUsd, 0.008);
  assert.equal(actions.recordedRuns, 2);
  assert.equal(actions.billedMinutes, 2);
  assert.equal(summary.months.find(row => row.runner === 'modal').legacyRuns, 1);
  assert.equal(summary.months.find(row => row.runner === 'modal').unknownRuns, 1);
  assert.equal(summary.months.find(row => row.runner === 'local').estimatedCostUsd, 0);
  assert.equal(summary.months.find(row => row.runner === 'github-actions' && !row.label).unknownRuns, 1);
  assert.match(summary.basis, /not billed spend/);
});

test('legacy Modal receipts remain readable and retain saved totals without re-estimation', () => {
  const original = {
    status: 'passed',
    backend: { requested: 'modal', actual: 'modal', estimatedCostUsd: 1 },
    endedAt: '2026-10-01T00:00:00Z',
    details: 'Legacy synthetic receipt',
  };
  assert.deepEqual(receiptSchema.parse(original), original);
  assert.equal(createRunReceipt(original).backend.cost.estimatedCostUsd, null);
  assert.equal(retainedRunCost(original.backend).estimatedCostUsd, 1);
  assert.equal(retainedRunCost(original.backend).billedSeconds, null);
});

test('monthly history completes an adopted job observation without double counting it or deducting allowance', () => {
  const early = actionsCost('blacksmith-4vcpu-ubuntu-2404', 0.008, [
    job(73, 61, { status: 'in_progress', completed_at: null }),
  ]);
  const complete = actionsCost('blacksmith-4vcpu-ubuntu-2404', 0.008, [job(73, 61)]);
  const summary = runnerMonthCosts(
    [early, complete].map((cost, index) => ({
      id: `run-${index}`,
      startedAt: '2026-10-01',
      backend: { actual: 'github-actions', cost },
    })),
  );
  assert.equal(summary.months[0].estimatedCostUsd, 0.016);
  assert.equal(summary.months[0].billedMinutes, 2);
  assert.equal(summary.months[0].unknownRuns, 1);
  assert.equal(summary.months[0].netEstimatedCostUsd, null);
});
