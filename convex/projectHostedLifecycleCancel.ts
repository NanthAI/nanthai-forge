// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, type MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { composeRow, composeStateSchema } from './projectHostedComposeStore';
import { cancelHostedLanding } from './projectHostedLandingCancel';
import { hostedWriteProject } from './projectHostedRecords';
import { digest } from '../src/portable-hash';
import { canonicalPayload } from '../src/hosted-source-operation';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { invariant } from '../src/errors';

type Plan = Doc<'projectHostedLifecyclePlans'>;
const selections = (ctx: MutationCtx, plan: Plan, laneId: string) =>
  ctx.db
    .query('projectHostedComposeSelections')
    .withIndex('by_project_and_kind_and_key', q =>
      q.eq('projectId', plan.projectId).eq('kind', 'inputs').eq('key', laneId),
    );
type Target = { laneId: string; cursor: string | null };
const schedule = (ctx: MutationCtx, plan: Plan, targets: Target[]) =>
  ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedLifecycleCancel:advance'), {
    planId: plan._id,
    targets,
  });
/** Existing canonical selections provide the reverse Lane lookup, including old
 * submissions. No backfill, source download or project/history scan is needed. */
async function cancelLanePage(
  ctx: MutationCtx,
  plan: Plan,
  target: Target,
  budget: { selections: number; cancellations: number },
): Promise<Target | null> {
  const { laneId, cursor } = target;
  const page = await selections(ctx, plan, laneId).paginate({
    cursor,
    numItems: budget.selections,
    maximumRowsRead: budget.selections,
    maximumBytesRead: 64 * 1024,
  });
  budget.selections -= page.page.length;
  for (const selection of page.page) {
    const compose = await composeRow(ctx, selection);
    invariant(compose, 'SOURCE_UNAVAILABLE', 'The selected Lane composition is unavailable.');
    const { candidateId } = composeStateSchema.parse(JSON.parse(compose.value));
    for (const phase of ['queued', 'checking', 'ready'] as const) {
      const rows = await ctx.db
        .query('projectHostedLandingRequests')
        .withIndex('by_project_and_candidate_and_phase_and_sequence', q =>
          q
            .eq('projectId', plan.projectId)
            .eq('candidateId', candidateId)
            .eq('phase', phase)
            .lte('sequence', plan.landingSequence!),
        )
        .take(budget.cancellations + 1);
      for (const row of rows) {
        // Bound each transaction to two cancellations, then resume this same
        // indexed window. Removed live phases make replay harmless and finite.
        if (!budget.cancellations) return target;
        const h = digest(
          canonicalPayload({
            domain: 'abandon-landing',
            operationId: plan.operationId,
            submissionId: row.submissionId,
          }),
        );
        const operationId = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
        const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
        await cancelHostedLanding(ctx, {
          projectId: plan.projectId,
          actor: plan.actor,
          abandonOperationId: plan.operationId,
          reason: `Saved lane ${laneId} was abandoned by lifecycle ${plan.operationId}; its pending ${(state.batchId ?? state.batchOriginId) ? 'batch landing was cancelled and peers requeued' : 'landing was cancelled'}. Reopen the saved work and finish again to propose it.`,
          request: { operationId, authorityEpoch: plan.authorityEpoch, submissionId: row.submissionId },
        });
        budget.cancellations--;
      }
    }
  }
  return page.isDone ? null : { laneId, cursor: page.continueCursor };
}

/** One shared budget for the whole lifecycle page, not a scheduled call per
 * child. Empty Lanes finish inline; active work yields one finite continuation. */
export async function cancelAbandonedLanesLandings(ctx: MutationCtx, plan: Plan, targets: Target[]) {
  // Old applied plans have no pinned queue and must not trigger retroactive work.
  if (plan.landingSequence === undefined) return;
  const budget = { selections: 10, cancellations: 2 };
  const pending: Target[] = [];
  for (const target of targets) {
    if (!budget.selections || !budget.cancellations) pending.push(target);
    else {
      const next = await cancelLanePage(ctx, plan, target, budget);
      if (next) pending.push(next);
    }
  }
  if (pending.length) await schedule(ctx, plan, pending);
}
export const cancelAbandonedLaneLandings = (
  ctx: MutationCtx,
  plan: Plan,
  laneId: string,
  cursor: string | null,
) => cancelAbandonedLanesLandings(ctx, plan, [{ laneId, cursor }]);

export const advance = internalMutation({
  args: {
    planId: v.id('projectHostedLifecyclePlans'),
    targets: v.array(v.object({ laneId: v.string(), cursor: v.union(v.string(), v.null()) })),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const plan = await ctx.db.get(input.planId);
    invariant(plan, 'NOT_FOUND', 'The abandonment operation is unavailable.');
    if (plan.status !== 'applied' || JSON.parse(plan.request).action !== 'abandon') return null;
    await hostedWriteProject(ctx, plan.projectId, plan.actor, plan.authorityEpoch);
    invariant(input.targets.length <= 20, 'BAD_ARGUMENT', 'Use one lifecycle page.');
    await cancelAbandonedLanesLandings(ctx, plan, input.targets);
    return null;
  },
});
