// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWallBreakdown } from '../scripts/actions-cache-report.mjs';

const at = seconds => new Date(Date.UTC(2026, 10, 6, 10, 0, 0) + seconds * 1000).toISOString();
const job = (name, start, end, run = [start, end], conclusion = 'success') => ({
  name,
  conclusion,
  startedAt: at(start),
  completedAt: at(end),
  steps: [
    { name: 'Run actions/checkout@v4', conclusion: 'success', startedAt: at(start), completedAt: at(run[0]) },
    {
      name: 'Run node control/scripts/hosted-actions-job.mjs run',
      conclusion: 'success',
      startedAt: at(run[0]),
      completedAt: at(run[1]),
    },
  ],
});
const run = (created, updated, jobs, conclusion = 'success') => ({
  createdAt: at(created),
  updatedAt: at(updated),
  conclusion,
  jobs,
});

test('the wall breakdown splits a successful check into queue, plan, slowest shard and tail', () => {
  const summary = summarizeWallBreakdown([
    run(0, 500, [
      job('hosted-plan', 4, 34),
      job('forge-hosted-0', 36, 336, [46, 334]),
      job('forge-hosted-1', 36, 486, [46, 484]),
      job('forge-hosted-static', 36, 266, [46, 264]),
      job('hosted-pack', 34, 40, [34, 40], 'skipped'),
    ]),
    // Failed and cancelled runs would skew the shard times; the breakdown skips them.
    run(0, 90, [job('hosted-plan', 4, 34), job('forge-hosted-0', 36, 80)], 'failure'),
  ]);
  assert.equal(summary.successRuns, 1);
  assert.equal(summary.wallSeconds.p50, 500);
  assert.equal(summary.queueSeconds.p50, 4);
  assert.equal(summary.planJobSeconds.p50, 30);
  assert.equal(summary.slowestShardSeconds.p50, 450);
  assert.equal(summary.fastestShardSeconds.p50, 300);
  assert.equal(summary.shardCount.p50, 2);
  assert.equal(summary.slowestOverMeanShard.p50, 450 / 375);
  assert.equal(summary.staticJobSeconds.p50, 230);
  // Slowest job ends at 486 and the run at 500: 14 s of tail.
  assert.equal(summary.tailSeconds.p50, 14);
  // Shard time outside the run step: (10 + 2) / 2 + (10 + 2) / 2 = 12 s.
  assert.equal(summary.shardSetupSeconds.p50, 12);
  assert.equal(summary.runnerMinutes.p50, (30 + 300 + 450 + 230) / 60);
});

test('runs without a plan job, shards or timestamps are skipped, and an empty list reports no data', () => {
  const summary = summarizeWallBreakdown([
    run(0, 100, [{ name: 'hosted-plan', conclusion: 'success', steps: [] }]),
    run(0, 100, [job('forge-hosted-0', 1, 50)]),
  ]);
  assert.equal(summary.successRuns, 0);
  assert.equal(summary.wallSeconds.p50, null);
  assert.equal(summarizeWallBreakdown([]).slowestShardSeconds.p90, null);
});
