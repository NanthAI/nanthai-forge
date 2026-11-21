// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, type ActionCtx } from './server';
import { writableHostedCheck } from './projectHostedCheckStore';
import { convexFetch } from './networkFetch';
import { actionsToken, githubAppRequest } from './githubAppToken';
import { requireStoredRepositoryBinding, runnerTokenScope, type RunnerScope } from './githubBindingAccess';
import { correctCancelledRun } from './projectCancelledRunOwners';
import { cancelledJobUsage, cancelledUsageRepository } from './cancelledRunUsage';
import { hostedCheckTerminal } from '../src/hosted-check';
import { invariant } from '../src/errors';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './server';
import type { LoadedHostedCheck } from './projectHostedCheckStore';

export type CancelledUsageTarget = {
  projectId: Id<'hostedProjects'>;
  runId: string;
  fence: number;
  executionId: string;
  repository: string;
  runnerScope: RunnerScope | null;
};
/** Added to the existing authenticated completed-event response only. A pass
 * takes no new read/call. Completed cancellation keeps its original verdict. */
export async function cancelledUsageTarget(
  ctx: MutationCtx,
  selected: LoadedHostedCheck,
  providerCancelled = false,
): Promise<CancelledUsageTarget | null> {
  const { row, run } = selected;
  if ((run.status !== 'cancelled' && !providerCancelled) || row.cancelledUsage?.corrected || !run.executionId)
    return null;
  const provider = run.configuration;
  const repository = cancelledUsageRepository(provider);
  if (!repository) return null;
  // Accounting authorization failure must not roll back the existing verdict,
  // report collection or cleanup decision. Usage stays pending/unknown instead.
  let runnerScope: RunnerScope | null;
  try {
    runnerScope =
      provider.provider === 'ci-status'
        ? await requireStoredRepositoryBinding(ctx, row.projectId, repository)
        : await runnerTokenScope(ctx, row.projectId, repository);
  } catch {
    return null;
  }
  return {
    projectId: row.projectId,
    runId: run.id,
    fence: run.fence,
    executionId: run.executionId,
    repository,
    runnerScope,
  };
}

/** Complete, finite provider job pages in the existing webhook action. A missing page
 * or interval leaves pending usage unknown, without a timer or retry loop. */
export async function collectCancelledUsage(
  ctx: ActionCtx,
  target: CancelledUsageTarget,
  request: typeof fetch = convexFetch,
) {
  const token = await actionsToken(ctx, target.projectId, target.repository, target.runnerScope, request);
  const jobs: unknown[] = [];
  let total: number | undefined;
  for (let page = 1; ; page++) {
    const response = await githubAppRequest(
      `repos/${target.repository}/actions/runs/${target.executionId}/jobs?filter=latest&per_page=100&page=${page}`,
      token,
      request,
    );
    const body = (await response.json()) as { total_count?: number; jobs?: Record<string, unknown>[] };
    if (
      !Array.isArray(body.jobs) ||
      !Number.isSafeInteger(body.total_count) ||
      body.total_count! < 0 ||
      (total !== undefined && total !== body.total_count)
    )
      return;
    total = body.total_count!;
    // Retain timing/identity only, not step bodies, URLs or runner identities.
    jobs.push(
      ...body.jobs.map(j => ({
        id: j.id,
        run_id: j.run_id,
        run_attempt: j.run_attempt,
        status: j.status,
        conclusion: j.conclusion,
        started_at: j.started_at,
        completed_at: j.completed_at,
      })),
    );
    if (jobs.length >= total) break;
    if (!body.jobs.length) return;
  }
  const usage = cancelledJobUsage({ total_count: total, jobs }, target.executionId);
  if (!usage) return;
  await ctx.runMutation(makeFunctionReference<'mutation'>('projectCancelledRunUsage:complete'), {
    projectId: target.projectId,
    runId: target.runId,
    fence: target.fence,
    executionId: target.executionId,
    usage,
  });
}

/** Atomic by run id: provider receipt, owner counters and closed-day deltas
 * commit together. Replays perform no writes. No queue transition/wake is called. */
export const complete = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    runId: v.string(),
    fence: v.number(),
    executionId: v.string(),
    usage: v.object({ seconds: v.number(), receipt: v.object({ sha256: v.string(), size: v.number() }) }),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const selected = await writableHostedCheck(ctx, input, false),
      { row, run } = selected;
    invariant(
      run.fence === input.fence &&
        run.executionId === input.executionId &&
        Number.isFinite(input.usage.seconds) &&
        input.usage.seconds >= 0,
      'EVIDENCE_CHANGED',
      'Cancelled usage must bind its original provider execution.',
    );
    if (row.cancelledUsage?.corrected) {
      invariant(
        run.cost.status === 'observed' &&
          run.cost.seconds === input.usage.seconds &&
          run.cost.receipt?.sha256 === input.usage.receipt.sha256,
        'EVIDENCE_CHANGED',
        'Replay the original cancelled usage receipt.',
      );
      return null;
    }
    if (row.cancelledUsage?.final) {
      invariant(
        row.cancelledUsage.final.seconds === input.usage.seconds &&
          row.cancelledUsage.final.receipt.sha256 === input.usage.receipt.sha256,
        'EVIDENCE_CHANGED',
        'Replay the original cancelled usage receipt.',
      );
      if (run.status !== 'cancelled') return null;
    }
    if (run.status !== 'cancelled') {
      // The provider can finish before the existing report collector settles Forge.
      // Retain measurements only; its normal terminal write applies the correction.
      if (!hostedCheckTerminal(run)) {
        await ctx.db.patch(row._id, {
          cancelledUsage: {
            submissions: row.cancelledUsage?.submissions ?? [],
            ...row.cancelledUsage,
            final: input.usage,
          },
        });
      }
      return null;
    }
    await correctCancelledRun(ctx, row, run, input.usage);
    return null;
  },
});
