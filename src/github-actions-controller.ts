// SPDX-License-Identifier: Apache-2.0
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { mutate, observe, type ActionsApi, type ActionsJob, type ActionsRun } from './github-actions-api.js';
import { ensureActionsDispatch } from './github-actions-dispatch.js';
import type { ActionsJournal } from './github-actions-export.js';
import type { ModalPlan } from './modal-plan.js';
import { ModalShardLogs } from './modal-shard-logs.js';
import { actionsCost, actionsRate } from './check-cost.js';
import { invariant } from './errors.js';

// Runner "exit code 137", a SIGKILL/OOM error annotation, or the kernel OOM killer.
const oomSignal =
  /Process completed with exit code 137|##\[error\][^\n]*(SIGKILL|out of memory)|Killed process \d+/i;
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
  await ensureActionsDispatch(plan, journal, save, api, cancelled, progress);
  if (!journal.runId)
    return { status: 'cancelled' as const, exitCode: null, billableMinutes: [], cost: cost() };
  const logs = new ModalShardLogs(plan.output, plan.groups.length);
  let cancelSent = false,
    retryPolls = 0,
    settlePolls = 0;
  const oom = new Set<number>(journal.oom);
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
      if (job.status === 'completed' && !journal.logged.includes(job.id)) {
        let text: string;
        try {
          text = await observe(api, () => api.log(job.id, journal.repo), progress);
        } catch {
          text = 'GitHub job logs unavailable; consult retained execution identity.\n';
          progress(`Logs unavailable for job ${job.id}; observed verdict retained.`);
        }
        // Only runner/kernel lines: test names that mention SIGKILL or OOM are not a diagnosis.
        if (job.conclusion === 'failure' && oomSignal.test(text)) oom.add(job.id);
        journal.oom = [...oom];
        const attempt =
          journal.retrySources[shard] !== undefined && journal.retrySources[shard] !== job.id ? 1 : 0;
        logs.register({
          kind: 'execution',
          executionId: String(job.id),
          image: journal.commit!,
          index: shard,
          attempt,
        });
        logs.append(String(job.id), text);
        appendFileSync(join(plan.output, 'stdout.log'), text, { mode: 0o600 });
        journal.logged.push(job.id);
        save();
      }
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
    if (Object.entries(journal.retrySources).some(([index, id]) => latest.get(Number(index))?.id === id)) {
      if (++retryPolls < 12 && !cancelled()) {
        await api.sleep(10_000);
        continue;
      }
      return { status: 'interrupted' as const, exitCode: null, billableMinutes: [], cost: cost() };
    }
    const unfinished = [...latest.entries()].filter(([, job]) =>
      ['cancelled', 'timed_out', 'stale', 'startup_failure'].includes(job.conclusion ?? ''),
    );
    // No retries for observed test failures. Independent unfinished jobs get one replacement.
    const retry = unfinished.filter(([index]) => !journal.retrying.includes(index));
    if (!cancelled() && run.conclusion !== 'cancelled' && retry.length) {
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
      latest.size === plan.groups.length + 1 && [...latest.values()].every(job => job.status === 'completed');
    const failed = [...latest.values()].some(job =>
      ['failure', 'action_required'].includes(job.conclusion ?? ''),
    );
    const interrupted =
      run.conclusion !== 'success' ||
      !complete ||
      [...latest.values()].some(job => job.conclusion !== 'success');
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
      billableMinutes,
      cost: cost(),
      failureSummary: [...latest.values()]
        .filter(job => job.conclusion !== 'success')
        .map(
          job =>
            `${job.name}: ${job.conclusion}; job ${job.id}; inspect retained shard log (exit 137/SIGKILL indicates likely OOM).`,
        )
        .join('\n'),
    };
  }
}
