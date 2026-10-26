// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { replayLanding, syntheticWorkloads } from '../dist/landing-replay.js';

test('every synthetic workload replays deterministically for serial and train reference planners', async () => {
  for (const workload of syntheticWorkloads())
    for (const planner of ['serial', 'train']) {
      const first = await replayLanding(workload, planner);
      assert.deepEqual(await replayLanding(workload, planner), first, `${workload.name}/${planner}`);
      assert.equal(Object.keys(first.outcomes).length, workload.arrivals.length);
      assert.equal(first.total.netEstimatedCostUsd, null);
      assert.ok(Number.isFinite(first.submitToOutcome.p95Ms));
    }
});

test('unchecked eight-arrival replay reports singleton checks, rounded cost and distinct audit cost', async () => {
  const workload = syntheticWorkloads()[0];
  const serial = await replayLanding(workload, 'serial'),
    train = await replayLanding(workload, 'train');
  assert.equal(serial.checkExecutions, 9);
  // This reference planner has no retained solo receipts. The production
  // selector therefore checks these unverified inputs as singletons.
  assert.equal(train.checkExecutions, 9);
  assert.ok(Math.abs(serial.total.knownGrossCostUsd - 1.584) < 1e-12);
  assert.ok(Math.abs(train.total.knownGrossCostUsd - 1.584) < 1e-12);
  assert.equal(train.byCategory.audit.checks, 1);
  assert.equal(serial.submitToOutcome.p95Ms, 2400000);
  assert.equal(train.submitToOutcome.p95Ms, 2400000);
});

test('fault workloads preserve unknown dispatch adoption, invalidated speculation and conflict outcomes', async () => {
  for (const name of ['lost-reply', 'restart-check-reservation']) {
    const workload = syntheticWorkloads().find(row => row.name === name);
    const result = await replayLanding(workload, 'train');
    assert.ok(result.controllerAdoptions > 0);
    assert.equal(result.dispatchRejections, 0);
  }
  const stale = await replayLanding(
    syntheticWorkloads().find(row => row.name === 'stale-main'),
    'train',
  );
  assert.ok(stale.byCategory['invalidated-speculation'].checks > 0);
  const conflict = await replayLanding(
    syntheticWorkloads().find(row => row.name === 'same-paragraph-conflict'),
    'train',
  );
  assert.equal(conflict.outcomes.C, 'conflict');
});

test('synthetic preview controls are reported separately and included once in total physical usage', async () => {
  const workload = syntheticWorkloads().find(row => row.name === 'cross-file-interaction');
  const result = await replayLanding(workload, 'train');
  assert.equal(result.previewExecutions, 1);
  assert.equal(result.byCategory.preview.executions, 1);
  assert.equal(result.byCategory.preview.knownGrossCostUsd, 0);
  assert.equal(
    result.total.executions,
    Object.values(result.byCategory).reduce((n, group) => n + group.executions, 0),
  );
});
