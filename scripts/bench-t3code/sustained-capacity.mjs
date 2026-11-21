// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { runCommand } from './sustained-setup.mjs';

const minute = 60_000;
const pollMs = 30_000;
const dogfood = 'NanthAI/nanthai-forge';
const reserveMinutes = 16 * 10;
const bounded = (command, args, options) => runCommand(command, args, { timeoutMs: 12_000, ...options });
const isWaiting = job => ['queued', 'pending', 'waiting', 'requested'].includes(job.status);
const isActive = job => job.status === 'in_progress';
const waitMs = (job, now) => now - Date.parse(job.created_at);

const api = async (path, exec) => JSON.parse((await exec('gh', ['api', path])).stdout);
async function activeRuns(repo, status, exec) {
  const path = `repos/${repo}/actions/runs?status=${status}&per_page=100`;
  let runs;
  // GitHub counts the filtered inventory separately from its paginated rows.
  // Re-read once; when the count still lags, reconcile against current run rows.
  for (let attempt = 0; attempt < 2; attempt++) {
    const pages = JSON.parse((await exec('gh', ['api', '--paginate', '--slurp', path])).stdout);
    runs = pages.flatMap(page => page.workflow_runs);
    if (pages[0]?.total_count === runs.length) return runs;
  }
  const recent = await api(`repos/${repo}/actions/runs?per_page=100`, exec);
  const reconciled = new Map(runs.map(run => [run.id, run]));
  for (const run of recent.workflow_runs) {
    if (run.status === status) reconciled.set(run.id, run);
    else reconciled.delete(run.id);
  }
  return [...reconciled.values()];
}
const listJobs = async (repo, runId, exec) => {
  const page = await api(`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, exec);
  if (page.total_count > page.jobs.length) throw Error('Actions job snapshot was truncated');
  return page.jobs;
};

/** Read all non-archived visible org repos before a runner slot is taken. */
export async function sampleOrg(exec = runCommand) {
  const repos = JSON.parse(
    (await exec('gh', ['api', '--paginate', '--slurp', 'orgs/NanthAI/repos?per_page=100'])).stdout,
  ).flat();
  const jobs = await Promise.all(
    repos
      .filter(repo => !repo.archived)
      .map(async repo => {
        const runs = await activeRuns(repo.full_name, 'in_progress', exec);
        return (await Promise.all(runs.map(run => listJobs(repo.full_name, run.id, exec)))).flat();
      }),
  );
  return { atMs: Date.now(), repositories: repos.length, activeJobs: jobs.flat().filter(isActive).length };
}

export async function readBenchJobs(repo, exec = runCommand) {
  const runs = JSON.parse(
    (
      await exec('gh', [
        'api',
        '--paginate',
        '--slurp',
        `repos/${repo}/actions/workflows/forge-check.yml/runs?per_page=100`,
      ])
    ).stdout,
  ).flatMap(page => page.workflow_runs);
  return Promise.all(
    runs.map(async run => ({
      id: run.id,
      checkId: /^forge-check\/([a-f0-9-]+)$/.exec(run.display_title ?? run.name)?.[1],
      head: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
      createdAtMs: Date.parse(run.created_at),
      jobs: await listJobs(repo, run.id, exec),
    })),
  );
}

const billed = (job, now) => {
  if (job.conclusion === 'skipped' || !job.started_at) return 0;
  return Math.max(
    0,
    Math.ceil(
      ((job.completed_at ? Date.parse(job.completed_at) : now) - Date.parse(job.started_at)) / minute,
    ),
  );
};

export function completedBenchMinutes(runs, now = Date.now()) {
  return runs.flatMap(run => run.jobs).reduce((total, job) => total + billed(job, now), 0);
}

/** A finite monitor stays live during the arm and its drain. The workflow's concurrency
 * groups enforce the instantaneous cap. Reserve ten minutes at full capacity for
 * the next sample and verified shutdown. */
export async function watchSustained({
  repo,
  priorMinutes,
  runnerHead,
  signal,
  abort,
  emit,
  ready,
  exec = bounded,
  now = Date.now,
}) {
  const completed = new Map();
  let previousDogfoodRuns = new Set();
  const startedAtMs = now();
  while (!signal.aborted) {
    try {
      const allBenchRuns = JSON.parse(
        (
          await exec('gh', [
            'api',
            '--paginate',
            '--slurp',
            `repos/${repo}/actions/workflows/forge-check.yml/runs?per_page=100`,
          ])
        ).stdout,
      ).flatMap(page => page.workflow_runs);
      const [bench, dogfoodRuns, current] = await Promise.all([
        Promise.all(
          allBenchRuns.map(async run => {
            if (completed.has(run.id)) return completed.get(run.id);
            const jobs = await listJobs(repo, run.id, exec);
            if (run.status === 'completed') completed.set(run.id, jobs);
            return jobs;
          }),
        ),
        Promise.all(['queued', 'in_progress'].map(status => activeRuns(dogfood, status, exec))),
        runnerHead ? api(`repos/${repo}/branches/main`, exec) : null,
      ]);
      const workflows = new Map(dogfoodRuns.flat().map(run => [run.id, run]));
      const observedRunIds = new Set([...workflows.keys(), ...previousDogfoodRuns]);
      const dogfoodJobs = (
        await Promise.all([...observedRunIds].map(id => listJobs(dogfood, id, exec)))
      ).flat();
      previousDogfoodRuns = new Set(workflows.keys());
      const atMs = now();
      const benchJobs = bench.flat();
      const activeBench = benchJobs.filter(isActive).length;
      const runnerMinutes = priorMinutes + benchJobs.reduce((sum, job) => sum + billed(job, atMs), 0);
      const dogfoodWait = Math.max(
        0,
        ...dogfoodJobs.filter(isWaiting).map(job => waitMs(job, atMs)),
        ...dogfoodJobs
          .filter(job => job.conclusion !== 'skipped' && Date.parse(job.started_at) >= startedAtMs)
          .map(job => waitMs(job, Date.parse(job.started_at))),
        ...[...workflows.values()].filter(run => run.status === 'queued').map(run => waitMs(run, atMs)),
      );
      if (!Number.isFinite(dogfoodWait)) throw Error('Dogfood runner wait timestamp missing');
      emit({ event: 'capacity', atMs, activeBench, runnerMinutes, dogfoodWait, runs: allBenchRuns.length });
      if (runnerHead && current.commit.sha !== runnerHead) return abort('Scratch runner workflow moved');
      if (activeBench > 16) return abort('16-job cap exceeded');
      if (runnerMinutes >= 4000 - reserveMinutes) return abort('4,000-minute budget reserve reached');
      if (dogfoodWait > 10 * minute) return abort('Dogfood check waited more than 10 minutes for a runner');
      ready?.();
      await delay(pollMs, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) return abort(`Runner monitor failed: ${error.message}`);
    }
  }
}

/** Disable dispatch, then observe terminal provider runs. Cancel independent runs together.
 * Force cancellation is reserved for runs that did not settle after a normal cancel. */
export async function stopSustainedActions(repo, emit, { exec = bounded, sleep = delay } = {}) {
  const workflow = `repos/${repo}/actions/workflows/forge-check.yml`;
  const requested = new Set();
  let disabled = false;
  for (;;) {
    if (!disabled) {
      try {
        await exec('gh', ['api', '--method', 'PUT', workflow + '/disable']);
        disabled = (await api(workflow, exec)).state === 'disabled_manually';
      } catch (error) {
        emit({ event: 'stop-actions-error', step: 'disable', reason: error.message });
      }
    }
    try {
      const runs = await readBenchJobs(repo, exec);
      const active = runs.filter(run => run.status !== 'completed');
      if (disabled && active.length === 0) {
        emit({ event: 'provider-drained', minutes: completedBenchMinutes(runs), runCount: runs.length });
        return;
      }
      await Promise.all(
        active.map(async run => {
          const action = requested.has(run.id) ? 'force-cancel' : 'cancel';
          requested.add(run.id);
          try {
            await exec('gh', ['api', '--method', 'POST', `repos/${repo}/actions/runs/${run.id}/${action}`]);
          } catch (error) {
            emit({ event: 'stop-actions-error', step: action, runId: run.id, reason: error.message });
          }
        }),
      );
    } catch (error) {
      emit({ event: 'stop-actions-error', step: 'read active runs', reason: error.message });
    }
    await sleep(pollMs);
  }
}

/** Reconcile all admitted work on this dedicated scratch project, including unknown
 * submit outcomes. The caller drains initiated client calls before the first read. */
export async function stopSustainedForge({ read, cancel, emit, sleep = delay }) {
  const cancelIds = new Map();
  for (;;) {
    try {
      const queue = await read('queue', { limit: 20 });
      if (queue.total === 0 && queue.preparing === 0) {
        emit({ event: 'forge-drained' });
        return;
      }
      await Promise.all(
        queue.entries.map(async ({ submissionId }) => {
          if (!submissionId) return;
          if (!cancelIds.has(submissionId)) cancelIds.set(submissionId, randomUUID());
          const operationId = cancelIds.get(submissionId);
          const result = await cancel(submissionId, operationId);
          emit({ event: 'cancel-submission', submissionId, operationId, exitCode: result.code });
        }),
      );
    } catch (error) {
      emit({ event: 'stop-forge-error', reason: error.message });
    }
    await sleep(10_000);
  }
}
