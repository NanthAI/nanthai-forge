// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { z } from 'zod';
import type { hostedLaneSchema } from '../src/hosted-lane';
import { mergeOverlapChanges, advanceOverlapMain, type OverlapChange } from '../src/hosted-overlap';

export async function trackHostedOverlapLane(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  lane: z.infer<typeof hostedLaneSchema>,
  metadata?: { changes?: OverlapChange[]; complete?: boolean; baseSequence?: number; intent?: string },
) {
  const old = await ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', lane.id))
    .unique();
  const sameBase = old?.baseHead === lane.base.head;
  const sameHead = old?.head === lane.head;
  const unchangedBase = lane.head === lane.base.head;
  const projection = unchangedBase
    ? { changes: '[]', complete: true }
    : mergeOverlapChanges(
        sameBase && old ? JSON.parse(old.changes) : [],
        metadata?.changes ?? [],
        (sameBase && old ? old.complete : false) &&
          (sameHead || metadata?.changes !== undefined) &&
          metadata?.complete !== false,
      );
  const value = {
    projectId,
    laneId: lane.id,
    intentId: lane.intentId,
    actor: lane.actor,
    intent: (metadata?.intent ?? old?.intent ?? lane.intentId).slice(0, 160),
    head: lane.head,
    baseHead: lane.base.head,
    baseReceiptId: lane.base.receiptId,
    baseSequence: metadata?.baseSequence ?? (sameBase ? (old?.baseSequence ?? null) : null),
    recordVersion: lane.version,
    open: ['active', 'paused', 'ready'].includes(lane.state),
    ...projection,
  };
  if (old) await ctx.db.replace(old._id, value);
  else await ctx.db.insert('projectHostedOverlapLanes', value);
}

export async function trackHostedOverlapMain(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  sequence: number,
  paths: string[] | null,
) {
  const old = await ctx.db
    .query('projectHostedOverlapMain')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  const value = { projectId, ...advanceOverlapMain(old, sequence, paths) };
  if (old) await ctx.db.replace(old._id, value);
  else await ctx.db.insert('projectHostedOverlapMain', value);
}

/** Staged cascade visibility follows its existing atomic applied marker. */
export async function markHostedOverlapLifecycle(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  lifecyclePlanId: Id<'projectHostedLifecyclePlans'>,
) {
  const row = await ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();
  if (row) await ctx.db.patch(row._id, { lifecyclePlanId });
}

/** Retire the advisory open entry when its existing lifecycle overlay is promoted. */
export async function materializeHostedOverlapLifecycle(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  recordVersion: number,
) {
  const row = await ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();
  if (row) await ctx.db.patch(row._id, { open: false, recordVersion, lifecyclePlanId: undefined });
}
