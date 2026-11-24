// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';

export const laneOverlapHead = (ctx: QueryCtx, projectId: Id<'hostedProjects'>, laneId: string) =>
  ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();

export const landedAtLaneHead = (row: Doc<'projectHostedOverlapLanes'> | null) =>
  !!row?.landed &&
  row.landed.laneHead === row.head &&
  (row.reopenedAt === undefined || row.reopenedAt <= Date.parse(row.landed.at));

/** A keep-open Lane that already landed this head is settled evidence. An explicit reopen, a later
 * saved head, or a pin makes it running again. During an applied cascade, the marker owns its state. */
export async function runningLaneHead(ctx: QueryCtx, head: Doc<'projectHostedRecordHeads'>) {
  if (head.status !== 'active') return false;
  const overlap = await laneOverlapHead(ctx, head.projectId, head.key);
  if (overlap?.lifecyclePlanId && (await ctx.db.get(overlap.lifecyclePlanId))?.status === 'applied')
    return false;
  return head.pinned || !landedAtLaneHead(overlap);
}

const candidates = 8;

/** A bounded read of only potentially open Lanes. Too many landed placeholders without a running
 * witness leave the decision unknown, never falsely settled. */
export async function openIntentLane(ctx: QueryCtx, projectId: Id<'hostedProjects'>, intentId: string) {
  const page = await ctx.db
    .query('projectHostedRecordHeads')
    .withIndex('by_project_and_kind_and_parent_and_status', q =>
      q.eq('projectId', projectId).eq('kind', 'lane').eq('parent', intentId).eq('status', 'active'),
    )
    .take(candidates + 1);
  for (const head of page.slice(0, candidates)) if (await runningLaneHead(ctx, head)) return head;
  return page.length > candidates ? undefined : null;
}
