// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { z } from 'zod';
import type { hostedLaneSchema } from '../src/hosted-lane';
import { mergeOverlapChanges, advanceOverlapMain, type OverlapChange } from '../src/hosted-overlap';
import { trackHostedPresence } from './projectHostedPresence';

export async function trackHostedOverlapLane(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  lane: z.infer<typeof hostedLaneSchema>,
  metadata?: {
    changes?: OverlapChange[];
    complete?: boolean;
    baseSequence?: number;
    intent?: string;
    /** The starting agent session's slug (c29d0780); later writes keep the stored one. */
    agent?: string;
    /** A sync moved the base to a newer main; the Lane's saved paths still describe its own work. */
    rebased?: boolean;
  },
) {
  const old = await ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', lane.id))
    .unique();
  const sameBase = old?.baseHead === lane.base.head;
  const keepChanges = sameBase || metadata?.rebased === true;
  const sameHead = old?.head === lane.head;
  const unchangedBase = lane.head === lane.base.head;
  const projection = unchangedBase
    ? { changes: '[]', complete: true }
    : mergeOverlapChanges(
        keepChanges && old ? JSON.parse(old.changes) : [],
        metadata?.changes ?? [],
        (keepChanges && old ? old.complete : false) &&
          (sameHead || metadata?.changes !== undefined) &&
          metadata?.complete !== false,
      );
  const agent = metadata?.agent ?? old?.agent;
  const open = ['active', 'paused', 'ready'].includes(lane.state);
  // Superseded lasts while the Lane stays open at the head it was set on; a save or reopen ends it.
  const superseded = old?.open && open && old.superseded?.laneHead === lane.head ? old.superseded : undefined;
  const value = {
    projectId,
    laneId: lane.id,
    intentId: lane.intentId,
    actor: lane.actor,
    ...(agent ? { agent } : {}),
    intent: (metadata?.intent ?? old?.intent ?? lane.intentId).slice(0, 160),
    head: lane.head,
    baseHead: lane.base.head,
    ...(lane.resolution ? { resolutionLeft: lane.resolution.left } : {}),
    baseReceiptId: lane.base.receiptId,
    baseSequence: metadata?.baseSequence ?? (sameBase ? (old?.baseSequence ?? null) : null),
    recordVersion: lane.version,
    open,
    ...(superseded ? { superseded } : {}),
    lastActivityAt: Number.isFinite(Date.parse(lane.at)) ? Date.parse(lane.at) : Date.now(),
    // Landing evidence belongs to the head that landed and survives later records of the Lane.
    ...(old?.landed ? { landed: old.landed } : {}),
    ...projection,
  };
  const at = Date.parse(lane.at);
  const presenceRow = await trackHostedPresence(
    ctx,
    projectId,
    lane.id,
    old ? { ...old, pointer: old.presenceRow, goal: old.intent } : null,
    value.open && !superseded
      ? {
          intentId: value.intentId,
          actor: value.actor,
          ...(value.agent ? { agent: value.agent } : {}),
          goal: value.intent,
          changes: value.changes,
          at: Number.isFinite(at) ? at : Date.now(),
        }
      : null,
  );
  const stored = { ...value, ...(presenceRow ? { presenceRow } : {}) };
  if (old) await ctx.db.replace(old._id, stored);
  else await ctx.db.insert('projectHostedOverlapLanes', stored);
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
  // A staged close hides the Lane from presence now; a later record write of a still-open Lane restores it.
  if (row?.presenceRow) await ctx.db.delete(row.presenceRow.id);
  if (row) await ctx.db.patch(row._id, { lifecyclePlanId, presenceRow: undefined });
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
  if (row?.presenceRow) await ctx.db.delete(row.presenceRow.id);
  if (row)
    await ctx.db.patch(row._id, {
      open: false,
      recordVersion,
      lifecyclePlanId: undefined,
      presenceRow: undefined,
    });
}
