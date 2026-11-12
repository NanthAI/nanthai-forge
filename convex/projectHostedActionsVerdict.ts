// SPDX-License-Identifier: Apache-2.0
import { prepareReportCollection } from './projectHostedReportCollection';
import { objectReportTransport } from './projectHostedCheckReports';
import { collectResultBatch } from './projectHostedActionsBatch';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, internalMutation, type MutationCtx } from './server';
import { writableHostedCheck, writeHostedCheck, type LoadedHostedCheck } from './projectHostedCheckStore';
import { settleDirectActions } from './projectHostedActionsDirect';
import { receiveHostedCheckCallback } from './projectHostedCheckCallbacks';
import { outputSigningKey } from './projectHostedOutputApi';
import { actionsToken, githubAppRequest } from './githubAppToken';
import { runnerTokenScope, type RunnerScope } from './githubBindingAccess';
import { directCallback, actionsExecutionCost } from '../src/hosted-actions-direct';
import { signHostedCheckCallback } from '../src/hosted-check-evidence';
import { hostedCheckTerminal, type HostedCheckRun } from '../src/hosted-check';
import {
  delayedProviderVerdict,
  providerVerdictReadsMs,
  type ProviderJob,
} from '../src/ci-provider-recovery';
import {
  providerVerdict,
  requiredJobsConclusion,
  OPTIONAL_PACK_JOB,
  OPTIONAL_PROOF_JOB,
} from '../src/hosted-check-verdict';

/** Fixed offsets from the last shard: run at +5 min, jobs/steps at +30 min, then
 * run at +1/+2/+4 h. The existing execution watchdog remains the final backstop. */
export const verdictConfirmMs = providerVerdictReadsMs;
/** Every held pass: reads of the required jobs' conclusions this long after the last shard result
 * (the job that posted it completes a few seconds later), then the reads above. The run's signed
 * `workflow_run` event usually settles it first and cancels the read, so the common path adds no
 * call; a lost or late event costs seconds, not the 5 min run read (Issue 03a749a5). The jobs read
 * also never waits for the optional pack job (friction 0064c3b2). */
export const verdictJobsMs = [10_000, 30_000] as const;
const identity = { projectId: v.id('hostedProjects'), runId: v.string() };
/** What a jobs read needs, resolved in the scheduling transaction (no pendingConfirm call). */
const jobsTarget = v.object({
  repository: v.string(),
  executionId: v.string(),
  runnerScope: v.union(v.null(), v.object({ repoId: v.number(), installationId: v.number() })),
});
async function jobsRead(
  ctx: MutationCtx,
  projectId: LoadedHostedCheck['row']['projectId'],
  run: HostedCheckRun,
) {
  if (run.configuration.provider !== 'github-actions' || !run.executionId) return null;
  const { repository } = run.configuration;
  return {
    jobs: true as const,
    target: {
      repository,
      executionId: run.executionId,
      runnerScope: await runnerTokenScope(ctx, projectId, repository),
    },
  };
}

/** The one `complete` callback for a run whose every shard reported. */
export async function completeFromResults(
  ctx: MutationCtx,
  loaded: LoadedHostedCheck,
  status: 'passed' | 'failed' | 'cancelled',
  deferWrite = false,
) {
  const { run } = loaded;
  const complete = directCallback(run, {
    kind: 'complete',
    status,
    exitCode: status === 'cancelled' ? null : status === 'failed' ? 1 : 0,
    output: null,
    cost: actionsExecutionCost(run, run.plan!.shardCount),
    ...(run.reportPointer
      ? { reportDigest: run.reportPointer.digest }
      : run.contractReports
        ? { contractReports: run.contractReports }
        : {}),
  });
  return receiveHostedCheckCallback(
    ctx,
    {
      projectId: loaded.row.projectId,
      callback: complete,
      signature: signHostedCheckCallback(complete, outputSigningKey(run.keyId)),
      loaded,
      ...(deferWrite ? { deferWrite: true } : {}),
      ...(status === 'passed' ? { providerAttested: true } : {}),
    },
    outputSigningKey,
  );
}

/** Every shard passed: the pass waits for the provider's conclusion (src/hosted-check-verdict.ts).
 * The run stays active; its output may already be finalized. */
export async function holdForConclusion(ctx: MutationCtx, loaded: LoadedHostedCheck, deferWrite = false) {
  const { row, run } = loaded;
  if (run.actions!.confirm) {
    await ctx.scheduler.cancel(run.actions!.confirm as never);
    run.actions!.confirm = null;
  }
  run.actions!.verdictPending = true;
  const since = Date.now();
  // Not only runs with the pack job: one lost provider event must never cost minutes (Issue 03a749a5).
  const jobs = await jobsRead(ctx, row.projectId, run);
  run.actions!.confirm = await ctx.scheduler.runAfter(
    jobs ? verdictJobsMs[0] : verdictConfirmMs[0],
    makeFunctionReference<'action'>('projectHostedActionsVerdict:confirm'),
    { projectId: row.projectId, runId: run.id, fence: run.fence, attempt: 0, since, ...jobs },
  );
  if (!deferWrite) await writeHostedCheck(ctx, row._id, run);
  return run;
}

/** The provider's conclusion for a run held by `holdForConclusion`; anything but success never passes. */
export async function applyConclusion(
  ctx: MutationCtx,
  selected: LoadedHostedCheck,
  conclusion: string | null,
): Promise<HostedCheckRun> {
  const { run } = selected;
  if (run.actions?.confirm) {
    await ctx.scheduler.cancel(run.actions.confirm as never);
    run.actions.confirm = null;
  }
  const verdict = run.cancelRequested ? ({ status: 'cancelled' } as const) : providerVerdict(conclusion);
  if (verdict.status === 'passed') return completeFromResults(ctx, selected, 'passed');
  return settleDirectActions(
    ctx,
    selected,
    verdict.status,
    'reason' in verdict ? verdict.reason : 'Cancelled.',
  );
}

/** The same report collection and attested completion as a provider success. */
async function prepareDelayedPass(ctx: MutationCtx, selected: LoadedHostedCheck) {
  if (objectReportTransport(selected.run))
    return prepareReportCollection(ctx, selected, 'success', applyConclusion);
  await completeFromResults(ctx, selected, 'passed');
  return null;
}

export const pendingConfirm = internalMutation({
  args: { ...identity, fence: v.number() },
  returns: v.any(),
  handler: async (ctx, input) => {
    const { run } = await writableHostedCheck(ctx, input);
    if (
      hostedCheckTerminal(run) ||
      run.fence !== input.fence ||
      run.actions?.verdictPending !== true ||
      !run.executionId ||
      run.configuration.provider !== 'github-actions'
    )
      return null;
    return {
      repository: run.configuration.repository,
      executionId: run.executionId,
      runnerScope: await runnerTokenScope(ctx, input.projectId, run.configuration.repository),
    };
  },
});
export const confirmed = internalMutation({
  args: {
    ...identity,
    fence: v.number(),
    attempt: v.number(),
    completed: v.boolean(),
    conclusion: v.union(v.string(), v.null()),
    jobs: v.optional(v.literal(true)),
    since: v.optional(v.number()),
    lagged: v.optional(v.literal(true)),
    stepVerdict: v.optional(v.union(v.literal('passed'), v.literal('failed'), v.literal('provider-delayed'))),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, input) => {
    const selected = await writableHostedCheck(ctx, input),
      { row, run } = selected;
    if (run.fence !== input.fence) return null;
    const scheduledFunctionId = run.actions?.confirm;
    // The scheduled action is executing; never cancel it from its completion.
    if (run.actions) run.actions.confirm = null;
    if (!hostedCheckTerminal(run) && input.stepVerdict === 'failed') {
      await settleDirectActions(
        ctx,
        selected,
        'failed',
        'The CI provider recorded a failed job or step while its run status was delayed.',
      );
      return null;
    }
    const signedShardsPassed =
      !!run.plan &&
      run.counts.completed === run.plan.shardCount &&
      run.counts.passed === run.plan.shardCount &&
      run.counts.failed === 0;
    if (
      !hostedCheckTerminal(run) &&
      input.stepVerdict === 'passed' &&
      input.lagged &&
      input.since !== undefined &&
      Date.now() - input.since >= verdictConfirmMs[1] &&
      run.actions?.verdictPending &&
      signedShardsPassed
    ) {
      run.failureReason = `provider-delayed: GitHub run status lagged; all signed shards passed and the provider job list confirmed every step completed without failure at the +30 minute read.`;
      if (objectReportTransport(run) && !run.reportPointer) await writeHostedCheck(ctx, row._id, run);
      const reports = await prepareDelayedPass(ctx, selected);
      return reports ? JSON.stringify(reports) : null;
    }
    // Collector recovery is independent of provider completion: a real jobs read
    // must recover a stopped owner even while the provider is still running.
    if (objectReportTransport(run)?.collection && !run.reportPointer) {
      const reports = await prepareReportCollection(
        ctx,
        selected,
        input.completed ? input.conclusion : undefined,
        applyConclusion,
        {
          scheduledFunctionId: scheduledFunctionId as
            | import('./_generated/dataModel').Id<'_scheduled_functions'>
            | undefined,
        },
      );
      if (reports.collect || input.completed || hostedCheckTerminal(run) || !run.actions?.verdictPending)
        return JSON.stringify(reports);
      // A live owner remains protected; retain the existing confirmation fallback below.
    }

    if (
      input.completed &&
      objectReportTransport(run) &&
      (run.actions?.verdictPending ||
        (hostedCheckTerminal(run) && run.reportPointer) ||
        objectReportTransport(run)?.collection)
    )
      return JSON.stringify(
        await prepareReportCollection(ctx, selected, input.conclusion, applyConclusion, {
          scheduledFunctionId: scheduledFunctionId as
            | import('./_generated/dataModel').Id<'_scheduled_functions'>
            | undefined,
        }),
      );
    if (hostedCheckTerminal(run) || run.actions?.verdictPending !== true) return null;
    run.actions.confirm = null;
    if (input.completed) {
      await applyConclusion(ctx, selected, input.conclusion);
      return null;
    }
    // Fixed offsets from the last shard, never a poll or an unbounded retry.
    const since = input.since ?? Date.now();
    const earlyJobs = input.jobs && !input.lagged;
    const jobsNext = earlyJobs ? verdictJobsMs[input.attempt + 1] : undefined;
    const attempt = earlyJobs ? (jobsNext === undefined ? 0 : input.attempt + 1) : input.attempt + 1;
    const next = jobsNext ?? verdictConfirmMs[attempt];
    // Replace the existing +30 min run read with its job-list read; no extra provider read.
    const jobs = jobsNext !== undefined || attempt === 1 ? await jobsRead(ctx, input.projectId, run) : null;
    if (!earlyJobs && input.attempt >= 1)
      run.failureReason = `provider-delayed: waiting on GitHub since ${new Date(since).toISOString()}; its provider record has not settled. ${next === undefined ? 'The execution watchdog is the backstop.' : 'The next fixed provider read is at +' + next / 60_000 + ' minutes.'}`;
    if (next !== undefined)
      run.actions.confirm = await ctx.scheduler.runAfter(
        Math.max(0, since + next - Date.now()),
        makeFunctionReference<'action'>('projectHostedActionsVerdict:confirm'),
        {
          projectId: input.projectId,
          runId: input.runId,
          fence: input.fence,
          attempt,
          since,
          ...jobs,
          ...(attempt === 1 && jobsNext === undefined ? { lagged: true as const } : {}),
        },
      );
    await writeHostedCheck(ctx, row._id, run);
    return null;
  },
});
/** One GitHub read of the run, only when its completed event did not arrive in time. */
export const confirm = internalAction({
  args: {
    ...identity,
    fence: v.number(),
    attempt: v.number(),
    jobs: v.optional(v.literal(true)),
    target: v.optional(jobsTarget),
    since: v.optional(v.number()),
    lagged: v.optional(v.literal(true)),
  },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    const { target, ...identityInput } = input;
    // A jobs read carries its target; `confirmed` still rechecks that the run is pending.
    const pending =
      target ??
      ((await ctx.runMutation(
        makeFunctionReference<'mutation'>('projectHostedActionsVerdict:pendingConfirm'),
        {
          projectId: input.projectId,
          runId: input.runId,
          fence: input.fence,
        },
      )) as { repository: string; executionId: string; runnerScope?: RunnerScope | null } | null);
    if (!pending) return null;
    let completed = false,
      conclusion: string | null = null,
      stepVerdict: 'passed' | 'failed' | 'provider-delayed' | undefined;
    try {
      const token = await actionsToken(ctx, input.projectId, pending.repository, pending.runnerScope);
      const response = await githubAppRequest(
        `repos/${pending.repository}/actions/runs/${pending.executionId}${input.jobs ? '/jobs?per_page=100' : ''}`,
        token,
      );
      if (input.jobs) {
        // The required jobs only: the optional pack job never decides, nor holds, the verdict.
        const body = (await response.json()) as { total_count?: number; jobs?: ProviderJob[] };
        conclusion = requiredJobsConclusion(body);
        const jobs = body.jobs ?? [];
        const required = jobs.filter(job => {
          const name = (job as ProviderJob & { name?: string }).name;
          return name !== OPTIONAL_PACK_JOB && name !== OPTIONAL_PROOF_JOB;
        });
        if (
          delayedProviderVerdict({ signedShardsPassed: false, complete: false, jobs: required }) === 'failed'
        )
          stepVerdict = 'failed';
        else if (
          input.lagged &&
          input.since !== undefined &&
          Date.now() - input.since >= verdictConfirmMs[1]
        ) {
          const steps = delayedProviderVerdict({
            signedShardsPassed: true,
            complete: Array.isArray(body.jobs) && body.total_count === jobs.length,
            jobs,
          });
          // Optional jobs cannot fail a check; their failure only rules out this
          // stronger whole-job-list shortcut while required statuses still lag.
          stepVerdict = steps === 'passed' ? 'passed' : 'provider-delayed';
        }
        completed = conclusion !== null;
      } else {
        const body = (await response.json()) as { status?: unknown; conclusion?: unknown };
        completed = body.status === 'completed';
        conclusion = typeof body.conclusion === 'string' ? body.conclusion.slice(0, 40) : null;
        if (['failure', 'failed', 'timed_out', 'action_required'].includes(conclusion ?? ''))
          completed = true;
      }
    } catch {
      // An unreadable answer is not a conclusion: treat it as still running.
    }
    const reports = await ctx.runMutation(
      makeFunctionReference<'mutation'>('projectHostedActionsVerdict:confirmed'),
      {
        ...identityInput,
        completed,
        conclusion,
        ...(stepVerdict ? { stepVerdict } : {}),
      },
    );
    if (reports) {
      const prepared = JSON.parse(reports);
      await collectResultBatch(
        ctx,
        {
          projectId: input.projectId,
          runId: input.runId,
          fence: input.fence,
          executionId: prepared.run.executionId,
        },
        stepVerdict === 'passed' ? 'success' : completed ? conclusion : undefined,
        prepared,
      );
    }
    return null;
  },
});
