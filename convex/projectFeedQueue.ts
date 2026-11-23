// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { liveLaneFinish } from './projectHostedLaneFinish';
import { feedEventId, feedEventView } from '../src/feed-event';
import { queueStatusPage, type QueueStatusKey } from '../src/hosted-queue-status';
import { feedLaneOwner } from './projectFeedStore';

/** One opt-in Lane's live queue entry, using its existing directory page and clock. */
export async function feedQueueEvent(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  mine?: string,
) {
  if (mine && (await feedLaneOwner(ctx, projectId, laneId)) !== mine) return null;
  const selected = await liveLaneFinish(
    ctx,
    { projectId, laneId, headWrittenAt: '' },
    { queuedConflicts: true },
  );
  if (selected?.phase !== 'queued') return null;
  const { state } = selected;
  const [directory, page] = await Promise.all([
    ctx.db
      .query('projectHostedLandingQueues')
      .withIndex('by_project_and_channel', q => q.eq('projectId', projectId).eq('channel', 'main'))
      .unique(),
    ctx.db
      .query('projectHostedLandingQueueStatus')
      .withIndex('by_project_and_page', q =>
        q.eq('projectId', projectId).eq('page', queueStatusPage(state.sequence)),
      )
      .unique(),
  ]);
  if (!page || !directory?.status) return null;
  const key = (JSON.parse(page.value) as QueueStatusKey[]).find(entry => entry.id === state.id);
  if (key?.phase !== 'queued' || !key.position) return null;
  const event = {
    kind: 'queue.moved' as const,
    projectId,
    laneId,
    operationId: state.operationId,
    submissionId: state.id,
    position: key.position,
  };
  return feedEventView({ ...event, id: feedEventId(event), at: Date.parse(directory.status.lastProgressAt) });
}
