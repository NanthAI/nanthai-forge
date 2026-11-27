// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './server';
import { isPlanningRef } from '../src/planning-id';

export const handBackWork = v.object({
  title: v.optional(v.string()),
  saves: v.optional(v.number()),
  files: v.optional(v.number()),
  lastSaveAt: v.optional(v.number()),
});

const readHandBackLane = (ctx: QueryCtx, projectId: Id<'hostedProjects'>, laneId: string) =>
  ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();

export function handBackLanes(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  const lanes = new Map<string, ReturnType<typeof readHandBackLane>>();
  return (laneId: string) => {
    let lane = lanes.get(laneId);
    if (!lane) {
      lane = readHandBackLane(ctx, projectId, laneId);
      lanes.set(laneId, lane);
    }
    return lane;
  };
}

type Lane = Doc<'projectHostedOverlapLanes'>;

export function currentHandBack(lane: Lane | null, head: string, actor: string, sessionId?: string) {
  return Boolean(
    lane?.open &&
    lane.head === head &&
    lane.superseded?.laneHead !== head &&
    (!lane.holderActor || (sessionId && lane.holderActor === actor && lane.session?.sessionId === sessionId)),
  );
}

/** Current saved work with the recorded save time at the hand-back. */
export function handBackWorkOf(lane: Lane | null, lastSaveAt?: number) {
  const title = lane?.intent.trim();
  // The overlap projection can also include paths from an unpublished background save.
  const files = lane?.settled ? undefined : lane?.pathSummary.pathCount;
  return {
    ...(title && !isPlanningRef(title) ? { title } : {}),
    ...(lane?.saves !== undefined ? { saves: lane.saves } : {}),
    ...(files !== undefined && (files > 0 || lane?.saves !== undefined) ? { files } : {}),
    ...(lastSaveAt !== undefined ? { lastSaveAt } : {}),
  };
}
