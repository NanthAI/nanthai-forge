// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testReports } from './check-test-report.js';
import { compactCheckText } from './check-compact-output.js';
import { mutate, observe, type ActionsApi, type ActionsJob, type ActionsRun } from './github-actions-api.js';
import { ensureActionsDispatch } from './github-actions-dispatch.js';
import type { ActionsJournal } from './github-actions-export.js';
import type { ModalPlan } from './modal-plan.js';
import { ModalShardLogs, shardLogName } from './modal-shard-logs.js';
import { actionsJobLogEvidence } from './github-actions-job-evidence.js';
import { actionsCost, actionsRate } from './check-cost.js';
import { invariant } from './errors.js';
import { PENDING_ACTIONS_INFRA } from './github-actions-infra.js';
import { failedTestFiles } from './check-failure-files.js';

// Only an observed exit 137 or kill signal supports a likely-OOM summary.
const oomSignal = /Process completed with (?:exit code 137\b|signal SIGKILL\b)/i;
// GitHub's timing API reports `jobs` as a count and per-job durations in `job_runs`.
type Cost = {
  billable?: Record<string, { jobs?: number; job_runs?: { job_id: number; duration_ms: number }[] }>;
};
export async function controlActions(
  plan: ModalPlan,
  journal: ActionsJournal,
  save: () => void,
  api: ActionsApi,
  cancelled: () => boolean,
  progress: (message: string) => void,
  executionAllowed = true,
) {
  const cost = () =>
    actionsCost(
      journal.runsOn ?? 'ubuntu-latest',
      journal.rateUsdPerMinute === undefined
        ? actionsRate(journal.runsOn ?? 'ubuntu-latest')
        : journal.rateUsdPerMinute,
      journal.jobUsage ?? [],
    );
  const base = `repos/${journal.repo}/actions`;
  if (cancelled() && !journal.dispatching && !journal.runId)
    return { status: 'cancelled' as const, exitCode: null, billableMinutes: [], cost: cost() };
  await ensureActionsDispatch(plan, journal, save, api, cancelled, progress, executionAllowed);
  if (!journal.runId)
    return { status: 'cancelled' as const, exitCode: null, billableMinutes: [], cost: cost() };
  const logs = new ModalShardLogs(plan.output, plan.groups.length);
  let cancelSent = false,
    retryPolls = 0,
    settlePolls = 0;
  const oom = new Set<number>(journal.oom);
  const collectLog = async (job: ActionsJob, shard: number) => {
    const attempt =
      journal.retrySources[shard] !== undefined && journal.retrySources[shard] !== job.id ? 1 : 0;
    if (journal.logged.includes(job.id)) {
      try {
        return readFileSync(
          join(
            plan.output,
            'shards',
            shardLogName(shard === plan.groups.length ? 'static' : shard, attempt + 1).replace(
              /\.log$/,
              '.evidence',
            ),
          ),
          'utf8',
        );
      } catch {
        return '';
      }
    }
    let text: string;
    try {
      text = await observe(api, () => api.log(job.id, journal.repo), progress);
    } catch {
      text = 'GitHub job logs unavailable; consult retained execution identity.\n';
      progress(`Logs unavailable for job ${job.id}; observed verdict retained.`);
    }
    if (job.conclusion === 'failure' && oomSignal.test(text)) oom.add(job.id);
    journal.oom = [...oom];
    logs.register({
      kind: 'execution',
      executionId: String(job.id),
      image: journal.commit!,
      index: shard,
      attempt,
    });
    logs.append(String(job.id), text.endsWith('\n') ? text : `${text}\n`);
    logs.complete(String(job.id), job.conclusion === 'failure');

    journal.logged.push(job.id);
    save();
    return compactCheckText(text);
  };
  for (;;) {
    const run = await observe(api, () => api.request<ActionsRun>(`${base}/runs/${journal.runId}`), progress);
    invariant(run.head_sha === journal.commit, 'EVIDENCE_CHANGED', 'Actions execution source changed.');
    if (cancelled() && run.status !== 'completed' && !cancelSent) {
      await mutate(api, () => api.request(`${base}/runs/${journal.runId}/cancel`, 'POST'), progress);
      cancelSent = true;
      progress('Cancellation requested for retained Actions run.');
    }
    const jobs = await observe(
      api,
      () => api.pages<ActionsJob>(`${base}/runs/${journal.runId}/jobs?filter=all&per_page=100`, 'jobs'),
      progress,
    );
    const usage = new Map((journal.jobUsage ?? []).map(job => [job.id, job]));
    for (const job of jobs) {
      if (job.name !== 'forge-static' && !/^forge-shard-\d+$/.test(job.name)) continue;
      const previous = usage.get(job.id);
      usage.set(job.id, {
        id: job.id,
        retry: Object.entries(journal.retrySources).some(
          ([shard, source]) =>
            source !== job.id &&
            job.name === (Number(shard) === plan.groups.length ? 'forge-static' : `forge-shard-${shard}`),
        ),
        status: job.status,
        started_at: job.started_at ?? previous?.started_at ?? null,
        completed_at: job.completed_at ?? previous?.completed_at ?? null,
      });
    }
    journal.jobUsage = [...usage.values()];
    save();
    const latest = new Map<number, ActionsJob>();
    for (const job of jobs) {
      const index =
        job.name === 'forge-static' ? plan.groups.length : /^forge-shard-(\d+)$/.exec(job.name)?.[1];
      if (index === undefined) continue;
      const shard = Number(index);
      invariant(shard <= plan.groups.length, 'EVIDENCE_CHANGED', 'Actions returned unselected shard.');
      if (!latest.has(shard) || latest.get(shard)!.id < job.id) latest.set(shard, job);
      const state = `${job.status}/${job.conclusion ?? ''}`;
      if (journal.states[job.id] !== state) {
        progress(`Shard ${job.name}: ${state}`);
        journal.states[job.id] = state;
        save();
      }
      if (job.status === 'completed' && !journal.logged.includes(job.id)) await collectLog(job, shard);
    }
    if (run.status !== 'completed') {
      await api.sleep(10_000);
      continue;
    }
    // GitHub can report the run completed before its job list catches up (seen during the
    // 2026-10-19 Actions status-update delay). Unsettled jobs are not a verdict: observe again.
    const unsettled =
      latest.size < plan.groups.length + 1 || [...latest.values()].some(job => job.status !== 'completed');
    if (
      unsettled &&
      !cancelled() &&
      !['cancelled', 'startup_failure'].includes(run.conclusion ?? '') &&
      ++settlePolls <= 30
    ) {
      if (settlePolls === 1) progress('Actions run completed; waiting for its job list to settle.');
      await api.sleep(10_000);
      continue;
    }
    if (
      Object.entries(journal.retrySources).some(([index, id]) => {
        const replacement = latest.get(Number(index));
        return !replacement || replacement.id === id;
      })
    ) {
      if (++retryPolls < 12 && !cancelled()) {
        await api.sleep(10_000);
        continue;
      }
      const cancelledNow = cancelled();
      return {
        status: cancelledNow ? ('cancelled' as const) : ('interrupted' as const),
        ...(!cancelledNow
          ? {
              error: {
                code: PENDING_ACTIONS_INFRA,
                message:
                  'pending-infra: retained shard replacement requires discovery; no rerun is repeated.',
              },
            }
          : {}),
        exitCode: null,
        billableMinutes: [],
        cost: cost(),
      };
    }
    const unfinished = [...latest.entries()].filter(([, job]) =>
      ['cancelled', 'timed_out', 'stale', 'startup_failure'].includes(job.conclusion ?? ''),
    );
    // No retries for observed test failures. Independent unfinished jobs get one replacement.
    const retry = unfinished.filter(([index]) => !journal.retrying.includes(index));
    if (executionAllowed && !cancelled() && run.conclusion !== 'cancelled' && retry.length) {
      for (const [index, job] of retry.slice(0, 1)) {
        journal.retrying.push(index);
        journal.retrySources[index] = job.id;
        save();
        await mutate(api, () => api.request(`${base}/jobs/${job.id}/rerun`, 'POST'), progress);
        progress(`Retry unfinished shard ${job.name} once.`);
      }
      await api.sleep(10_000);
      continue;
    }
    const recovered = new Set<number>();
    const stuckFailures = new Set<number>();
    const summaries: string[] = [];
    for (const [shard, job] of latest) {
      if (job.status === 'completed') continue;
      const evidence = actionsJobLogEvidence(await collectLog(job, shard), plan.groups[shard] ?? []);
      if (evidence.status === 'failed') stuckFailures.add(job.id);
      const corroborated =
        evidence.status === 'passed' &&
        run.conclusion === 'success' &&
        (job.conclusion === null || job.conclusion === 'success');
      if (corroborated) recovered.add(job.id);
      const message = `${job.name}: job status stuck on GitHub (${job.status}); ${
        evidence.status === 'passed' || evidence.failed
          ? `log shows ${evidence.passed} passed, ${evidence.failed} failed (${evidence.source})`
          : evidence.status === 'failed'
            ? 'log reports a failure'
            : 'log missing or incomplete'
      }; run concluded ${run.conclusion ?? 'unknown'}; ${corroborated ? 'using log and run evidence' : 'no passing evidence'}.`;
      (journal.stuckJobs ??= {})[job.id] = { ...evidence, runConclusion: run.conclusion, message };
      summaries.push(message);
      progress(message);
      save();
    }
    if (latest.size < plan.groups.length + 1)
      summaries.push('Actions job list remains incomplete; missing jobs have no passing evidence.');
    // A lost rerun response never licenses another rerun; adoption observes new jobs.
    let timing: Cost = {};
    try {
      timing = await observe(api, () => api.request<Cost>(`${base}/runs/${journal.runId}/timing`), progress);
    } catch {
      progress('Actions timing API unavailable; retaining job timestamp estimates when available.');
    }
    const billableMinutes = Object.values(timing.billable ?? {}).flatMap(value =>
      (Array.isArray(value.job_runs) ? value.job_runs : []).map(job => ({
        jobId: job.job_id,
        minutes: Math.ceil(job.duration_ms / 60_000),
      })),
    );
    const complete =
      latest.size === plan.groups.length + 1 &&
      [...latest.values()].every(job => job.status === 'completed' || recovered.has(job.id));
    const failed =
      stuckFailures.size > 0 ||
      ['failure', 'action_required'].includes(run.conclusion ?? '') ||
      [...latest.values()].some(job => ['failure', 'action_required'].includes(job.conclusion ?? ''));
    const interrupted =
      run.conclusion !== 'success' ||
      !complete ||
      [...latest.values()].some(job => job.conclusion !== 'success' && !recovered.has(job.id));
    journal.terminal = true;
    save();
    return {
      status: cancelled()
        ? ('cancelled' as const)
        : failed
          ? ('failed' as const)
          : interrupted
            ? ('interrupted' as const)
            : ('passed' as const),
      exitCode: failed
        ? [...latest.values()].some(job => job.conclusion === 'failure' && oom.has(job.id))
          ? 137
          : 1
        : interrupted
          ? null
          : 0,
      executions: await Promise.all(
        [...latest].map(async ([index, job]) => ({
          executionId: String(job.id),
          index,
          attempt:
            journal.retrySources[index] !== undefined && journal.retrySources[index] !== job.id ? 1 : 0,
          exitCode: job.conclusion === 'success' || recovered.has(job.id) ? 0 : 1,
          ...(index < plan.groups.length
            ? { tests: testReports((await collectLog(job, index)).split('\n')) }
            : {}),
        })),
      ),
      billableMinutes,
      cost: cost(),
      jobStatusSummary: summaries.join('\n'),
      failureSummary: [...latest.values()]
        .filter(job => job.conclusion !== 'success' && !recovered.has(job.id))
        .map(job => {
          const shard =
            job.name === 'forge-static' ? plan.groups.length : Number(job.name.slice('forge-shard-'.length));
          const attempt =
            journal.retrySources[shard] !== undefined && journal.retrySources[shard] !== job.id ? 2 : 1;
          let text = '';
          try {
            text = readFileSync(
              join(
                plan.output,
                'shards',
                shardLogName(shard === plan.groups.length ? 'static' : shard, attempt).replace(
                  /\.log$/,
                  '.evidence',
                ),
              ),
              'utf8',
            );
          } catch {
            /* Logs may be unavailable; retain the observed job verdict. */
          }
          const files = failedTestFiles(text);
          return `${job.name}: ${job.conclusion}; job ${job.id}; ${oom.has(job.id) ? 'exit 137/SIGKILL (likely OOM); ' : ''}${files.length ? `failing tests: ${files.join(', ')}` : `inspect provider log https://github.com/${journal.repo}/actions/runs/${journal.runId}`}.`;
        })
        .join('\n')
        .slice(0, 4096),
    };
  }
}
