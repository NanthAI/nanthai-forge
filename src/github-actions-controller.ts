// SPDX-License-Identifier: Apache-2.0
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { mutate, observe, type ActionsApi, type ActionsJob, type ActionsRun } from './github-actions-api.js';
import type { ActionsJournal } from './github-actions-export.js';
import type { ModalPlan } from './modal-plan.js';
import { ModalShardLogs } from './modal-shard-logs.js';
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
  const base = `repos/${journal.repo}/actions`,
    branch = `forge-check/${plan.runId}`;
  if (cancelled() && !journal.dispatching && !journal.runId)
    return { status: 'cancelled' as const, exitCode: null, billableMinutes: [] };
  if (!journal.runId) {
    if (!journal.dispatching) {
      journal.dispatching = true;
      save();
      // Intent is durable before dispatch. Unknown outcomes are found by runId, never dispatched again.
      await mutate(
        api,
        () =>
          api.request(`${base}/workflows/forge-check.yml/dispatches`, 'POST', {
            ref: branch,
            inputs: { runId: plan.runId, plan: JSON.stringify(plan.groups.map((_, index) => index)) },
          }),
        progress,
      );
    }
    for (let attempt = 0; attempt < 12 && !journal.runId; attempt++) {
      const runs = await observe(
        api,
        () =>
          api.pages<ActionsRun>(
            `${base}/runs?branch=${encodeURIComponent(branch)}&event=workflow_dispatch&per_page=100`,
            'workflow_runs',
          ),
        progress,
      );
      const matches = runs.filter(
        run => run.head_sha === journal.commit && run.display_title === `forge-check/${plan.runId}`,
      );
      invariant(
        matches.length <= 1,
        'EVIDENCE_CHANGED',
        'Multiple Actions runs match the retained dispatch.',
      );
      if (matches[0]) {
        journal.runId = matches[0].id;
        save();
      } else await api.sleep(Math.min(60_000, 5_000 * (attempt + 1)));
    }
    invariant(
      journal.runId,
      'GITHUB_ACTIONS_UNKNOWN',
      'Actions dispatch outcome unknown; retained dispatch must be reconciled.',
    );
  }
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
      return { status: 'interrupted' as const, exitCode: null, billableMinutes: [] };
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
      progress('Actions timing unavailable; no billable-minute estimate recorded.');
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
