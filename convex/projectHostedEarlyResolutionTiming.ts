// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { EarlyResolution } from '../src/early-resolution';
import { earlyPredecessor } from './projectHostedEarlyResolution';

/** A late resolve must not reattach an event link to an already accepted predecessor. */
export async function recordEarlyResolutionTiming(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  early: EarlyResolution,
  laneId: string,
) {
  if (!early.resolvedAt) return;
  const parent = await earlyPredecessor(ctx, projectId, early.predecessor);
  if (!parent.landed) return; // Its settlement will clear the still-live dependent.
  // A late resolve rewrites its stack projection after the parent's settlement.
  // Do not reattach an event link to a predecessor that already ended.
  const dependent = await ctx.db
    .query('projectHostedStackDependents')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();
  if (dependent?.predecessorId === early.predecessor.submissionId)
    await ctx.db.patch(dependent._id, { predecessorId: undefined });
}
