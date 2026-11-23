// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { feedEventId, type FeedAttentionReason, type StoredFeedEvent } from '../src/feed-event';
const FEED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export type FeedWrite = StoredFeedEvent & { projectId: Id<'hostedProjects'>; actor: string };

export async function feedLaneOwner(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
) {
  const lane = await ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();
  return lane?.holderActor ?? lane?.actor;
}

export async function recordFeedAttention(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  noteId: string,
  reason: FeedAttentionReason,
  holder?: string,
) {
  const actor = holder ?? (await feedLaneOwner(ctx, projectId, laneId));
  if (actor) await recordFeedEvent(ctx, { projectId, laneId, actor, kind: 'lane.attention', noteId, reason });
}

/** Called only for new source transitions, inside their existing transaction. */
export async function recordFeedEvent(ctx: MutationCtx, ...events: FeedWrite[]) {
  const projectId = events[0]?.projectId;
  if (!projectId) return;
  const at = Date.now();
  const expired = await ctx.db
    .query('projectFeedEvents')
    .withIndex('by_project_and_at_and_id', q => q.eq('projectId', projectId).lt('at', at - FEED_RETENTION_MS))
    .take(2 * events.length);
  for (const row of expired) await ctx.db.delete(row._id);
  for (const event of events)
    await ctx.db.insert('projectFeedEvents', {
      ...event,
      id: feedEventId(event),
      at,
      commitTs: ctx.db.vars.commitTs,
    });
}
