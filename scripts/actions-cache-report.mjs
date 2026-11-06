// SPDX-License-Identifier: Apache-2.0
// Dependency-cache hit rate and check wall time from completed Forge check runs.
//   node scripts/actions-cache-report.mjs OWNER/REPO [runs=40] [--pool-since ISO_TIME]
// Reads the GitHub API through the owner's gh login (one list call plus one call per run).
// A job missed the cache when its `npm ci` step ran; a hit skips it. Wall time is created to updated.
// `breakdown` splits the successful runs' wall time into queue, plan job, slowest shard and tail,
// with shard balance and runner minutes. It uses only the jobs API (run logs are deleted within
// about an hour), so a before/after pair can be taken any time after a run ends.
// `--pool-since` adds the shard pool A/B measurement (FORGE_ACTIONS_POOL_MODE=ab): successful
// multi-shard runs since that time, labelled by run id like the planner does, paired in time
// order, with bootstrap intervals (docs/agents/perf-claims.md).
import { execFileSync } from 'node:child_process';
import { poolArm } from './shard-pool.mjs';
import { bootstrapInterval } from './bootstrap-interval.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const seconds = step => (Date.parse(step.completedAt) - Date.parse(step.startedAt)) / 1000;
const percentile = (values, share) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] : null;
};

const spanSeconds = item =>
  item?.startedAt && item?.completedAt
    ? (Date.parse(item.completedAt) - Date.parse(item.startedAt)) / 1000
    : null;
const spread = values => ({ p50: percentile(values, 0.5), p90: percentile(values, 0.9) });
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Where the wall time of successful runs goes: queue, plan job, slowest test shard, tail, with
 * shard balance (slowest over mean) and runner minutes. A run without timestamps is skipped. */
export function summarizeWallBreakdown(runs) {
  const rows = [];
  for (const run of runs) {
    if (run.conclusion !== undefined && run.conclusion !== 'success') continue;
    const jobs = run.jobs.filter(job => job.conclusion !== 'skipped' && spanSeconds(job) !== null);
    const plan = jobs.find(job => job.name === 'hosted-plan');
    const shards = jobs.filter(job => /^forge-hosted-\d+$/.test(job.name));
    if (!plan || !shards.length) continue;
    const shardSeconds = shards.map(spanSeconds);
    const wall = (Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 1000;
    const start = Math.min(...jobs.map(job => Date.parse(job.startedAt)));
    const end = Math.max(...jobs.map(job => Date.parse(job.completedAt)));
    const staticJob = jobs.find(job => job.name === 'forge-hosted-static');
    rows.push({
      wall,
      queue: (start - Date.parse(run.createdAt)) / 1000,
      plan: spanSeconds(plan),
      slowest: Math.max(...shardSeconds),
      fastest: Math.min(...shardSeconds),
      balance: Math.max(...shardSeconds) / mean(shardSeconds),
      shards: shards.length,
      static: staticJob ? spanSeconds(staticJob) : null,
      // Everything a shard does outside its one run step: job setup, checkout, setup-node, cache restore, artifact.
      setup: mean(
        shards.map(
          job =>
            spanSeconds(job) -
            job.steps
              .filter(step => /hosted-actions-job\.mjs run/.test(step.name))
              .reduce((sum, step) => sum + (spanSeconds(step) ?? 0), 0),
        ),
      ),
      tail: (Date.parse(run.updatedAt) - end) / 1000,
      runnerMinutes: jobs.reduce((sum, job) => sum + spanSeconds(job), 0) / 60,
    });
  }
  const column = key => rows.map(row => row[key]).filter(value => value !== null);
  return {
    successRuns: rows.length,
    wallSeconds: spread(column('wall')),
    queueSeconds: spread(column('queue')),
    planJobSeconds: spread(column('plan')),
    slowestShardSeconds: spread(column('slowest')),
    fastestShardSeconds: spread(column('fastest')),
    slowestOverMeanShard: spread(column('balance')),
    shardCount: spread(column('shards')),
    staticJobSeconds: spread(column('static')),
    shardSetupSeconds: spread(column('setup')),
    tailSeconds: spread(column('tail')),
    runnerMinutes: spread(column('runnerMinutes')),
  };
}

/** Shard pool A/B pairs. A = static plan, B = pool, decided by the run id in the run name
 * (`forge-check/RUN_ID`) exactly as the planner's `ab` mode does. Each B run pairs with the
 * nearest unpaired A run before it, or the next A after it, so pairs share load and time of day.
 * Runs without a run id, test shards or success are listed as voided, never dropped silently. */
export function poolPairs(runs, since) {
  const rows = [],
    voided = [];
  for (const run of [...runs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    if (Date.parse(run.createdAt) < Date.parse(since)) continue;
    const runId = /^forge-check\/([0-9a-f-]{36})$/i.exec(run.displayTitle ?? '')?.[1];
    const [summary] = runId ? [summarizeWallBreakdown([run])] : [];
    if (!runId || !summary?.successRuns || summary.shardCount.p50 < 2) {
      voided.push({
        id: run.databaseId ?? null,
        reason: !runId ? 'no run id' : 'not a successful multi-shard check',
      });
      continue;
    }
    rows.push({
      id: run.databaseId ?? null,
      arm: poolArm('ab', runId) ? 'B' : 'A',
      wall: summary.wallSeconds.p50,
      slowest: summary.slowestShardSeconds.p50,
      runnerMinutes: summary.runnerMinutes.p50,
    });
  }
  const pairs = [],
    open = { A: [], B: [] };
  for (const row of rows) {
    const other = open[row.arm === 'A' ? 'B' : 'A'];
    if (other.length) {
      const match = other.shift();
      pairs.push(row.arm === 'B' ? [match, row] : [row, match]);
    } else open[row.arm].push(row);
  }
  const interval = key => (pairs.length ? bootstrapInterval(pairs.map(([a, b]) => [a[key], b[key]])) : null);
  return {
    since,
    pairs: pairs.map(([a, b]) => ({
      a: a.id,
      b: b.id,
      wall: [a.wall, b.wall],
      runnerMinutes: [a.runnerMinutes, b.runnerMinutes],
    })),
    unpaired: [...open.A, ...open.B].map(row => ({ id: row.id, arm: row.arm })),
    voided,
    wallSeconds: interval('wall'),
    slowestShardSeconds: interval('slowest'),
    runnerMinutes: interval('runnerMinutes'),
    armWallSeconds: {
      A: spread(rows.filter(row => row.arm === 'A').map(row => row.wall)),
      B: spread(rows.filter(row => row.arm === 'B').map(row => row.wall)),
    },
  };
}

/** `runs`: [{createdAt, updatedAt, conclusion?, jobs: [{name, conclusion, startedAt?, completedAt?, steps: [{name, conclusion, startedAt, completedAt}]}]}] */
export function summarizeCacheRuns(runs) {
  let jobs = 0,
    misses = 0;
  const restores = [],
    walls = [];
  for (const run of runs) {
    walls.push((Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 60000);
    for (const job of run.jobs) {
      if (job.conclusion === 'skipped' || !/^(?:hosted-plan|forge-hosted-)/.test(job.name)) continue;
      const restore = job.steps.find(step => /actions\/cache\/restore/.test(step.name));
      if (!restore) continue;
      jobs++;
      if (job.steps.some(step => /npm ci/.test(step.name) && step.conclusion !== 'skipped')) misses++;
      restores.push(seconds(restore));
    }
  }
  return {
    runs: runs.length,
    jobs,
    misses,
    hitRate: jobs ? (jobs - misses) / jobs : null,
    restoreSecondsMedian: percentile(restores, 0.5),
    wallMinutesMedian: percentile(walls, 0.5),
    wallMinutesP90: percentile(walls, 0.9),
    breakdown: summarizeWallBreakdown(runs),
  };
}

const gh = (...args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20 }));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf('--pool-since');
  const since = flag > 0 ? process.argv[flag + 1] : undefined;
  if (flag > 0) process.argv.splice(flag, 2);
  if (since !== undefined && Number.isNaN(Date.parse(since)))
    throw new Error('--pool-since needs an ISO time.');
  const [repository, count = '40'] = process.argv.slice(2);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? ''))
    throw new Error('Usage: actions-cache-report OWNER/REPO [runs]');
  const listed = gh(
    'run',
    'list',
    '-R',
    repository,
    '--workflow',
    'forge-check.yml',
    '--limit',
    count,
    '--json',
    'databaseId,status,conclusion,createdAt,updatedAt,displayTitle',
  );
  const runs = listed
    .filter(run => run.status === 'completed')
    .map(run => ({
      ...run,
      jobs: gh('run', 'view', String(run.databaseId), '-R', repository, '--json', 'jobs').jobs,
    }));
  console.log(
    JSON.stringify(
      { ...summarizeCacheRuns(runs), ...(since ? { pool: poolPairs(runs, since) } : {}) },
      null,
      2,
    ),
  );
}
