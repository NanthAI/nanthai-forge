// SPDX-License-Identifier: Apache-2.0
// Dependency-cache hit rate and check wall time from completed Forge check runs.
//   node scripts/actions-cache-report.mjs OWNER/REPO [runs=40]
// Reads the GitHub API through the owner's gh login (one list call plus one call per run).
// A job missed the cache when its `npm ci` step ran; a hit skips it. Wall time is created to updated.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const seconds = step => (Date.parse(step.completedAt) - Date.parse(step.startedAt)) / 1000;
const percentile = (values, share) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] : null;
};

/** `runs`: [{createdAt, updatedAt, jobs: [{name, conclusion, steps: [{name, conclusion, startedAt, completedAt}]}]}] */
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
  };
}

const gh = (...args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20 }));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
    'databaseId,status,createdAt,updatedAt',
  );
  const runs = listed
    .filter(run => run.status === 'completed')
    .map(run => ({
      ...run,
      jobs: gh('run', 'view', String(run.databaseId), '-R', repository, '--json', 'jobs').jobs,
    }));
  console.log(JSON.stringify(summarizeCacheRuns(runs), null, 2));
}
