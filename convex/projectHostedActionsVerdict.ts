// SPDX-License-Identifier: Apache-2.0
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
import { providerVerdict, requiredJobsConclusion } from '../src/hosted-check-verdict';

/** Still unsettled after the jobs reads below: one read of the run's conclusion this long after
 * the last shard result, and one more if the run was still going; the 12 h watchdog stays the backstop. */
export const verdictConfirmMs = [5 * 60_000, 30 * 60_000] as const;
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
) {
  const { run } = loaded;
  const complete = directCallback(run, {
    kind: 'complete',
    status,
    exitCode: status === 'cancelled' ? null : status === 'failed' ? 1 : 0,
    output: null,
    cost: actionsExecutionCost(run, run.plan!.shardCount),
    contractReports: run.contractReports,
  });
  return receiveHostedCheckCallback(
    ctx,
    {
      projectId: loaded.row.projectId,
      callback: complete,
      signature: signHostedCheckCallback(complete, outputSigningKey(run.keyId)),
      loaded,
    },
    outputSigningKey,
  );
}

/** Every shard passed: the pass waits for the provider's conclusion (src/hosted-check-verdict.ts).
 * The run stays active; its output may already be finalized. */
export async function holdForConclusion(ctx: MutationCtx, loaded: LoadedHostedCheck) {
  const { row, run } = loaded;
  run.actions!.verdictPending = true;
  // Not only runs with the pack job: one lost provider event must never cost minutes (Issue 03a749a5).
  const jobs = await jobsRead(ctx, row.projectId, run);
  run.actions!.confirm = await ctx.scheduler.runAfter(
    jobs ? verdictJobsMs[0] : verdictConfirmMs[0],
    makeFunctionReference<'action'>('projectHostedActionsVerdict:confirm'),
    { projectId: row.projectId, runId: run.id, fence: run.fence, attempt: 0, ...jobs },
  );
  await writeHostedCheck(ctx, row._id, run);
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
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const selected = await writableHostedCheck(ctx, input),
      { row, run } = selected;
    if (hostedCheckTerminal(run) || run.fence !== input.fence || run.actions?.verdictPending !== true)
      return null;
    run.actions.confirm = null;
    if (input.completed) {
      await applyConclusion(ctx, selected, input.conclusion);
      return null;
    }
    // Still running: the next jobs read, then the run reads, then only the watchdog.
    const jobsNext = input.jobs ? verdictJobsMs[input.attempt + 1] : undefined;
    const next = input.jobs ? (jobsNext ?? verdictConfirmMs[0]) : verdictConfirmMs[input.attempt + 1];
    const jobs = jobsNext === undefined ? null : await jobsRead(ctx, input.projectId, run);
    if (next !== undefined)
      run.actions.confirm = await ctx.scheduler.runAfter(
        next,
        makeFunctionReference<'action'>('projectHostedActionsVerdict:confirm'),
        {
          projectId: input.projectId,
          runId: input.runId,
          fence: input.fence,
          attempt: input.jobs && !jobs ? 0 : input.attempt + 1,
          ...jobs,
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
      conclusion: string | null = null;
    try {
      const token = await actionsToken(ctx, input.projectId, pending.repository, pending.runnerScope);
      const response = await githubAppRequest(
        `repos/${pending.repository}/actions/runs/${pending.executionId}${input.jobs ? '/jobs?per_page=100' : ''}`,
        token,
      );
      if (input.jobs) {
        // The required jobs only: the optional pack job never decides, nor holds, the verdict.
        conclusion = requiredJobsConclusion(await response.json());
        completed = conclusion !== null;
      } else {
        const body = (await response.json()) as { status?: unknown; conclusion?: unknown };
        completed = body.status === 'completed';
        conclusion = typeof body.conclusion === 'string' ? body.conclusion.slice(0, 40) : null;
      }
    } catch {
      // An unreadable answer is not a conclusion: treat it as still running.
    }
    await ctx.runMutation(makeFunctionReference<'mutation'>('projectHostedActionsVerdict:confirmed'), {
      ...identityInput,
      completed,
      conclusion,
    });
    return null;
  },
});
