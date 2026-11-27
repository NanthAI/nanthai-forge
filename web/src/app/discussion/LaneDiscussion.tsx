// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Id } from '../../../../convex/_generated/dataModel';
import { useMemo } from 'react';
import { useArchivePaginatedQuery } from '../../archive-pagination';
import { workIndex } from '../../hosted-work-index';
import { A } from '../frames';
import { hrefFor, type AppRoute } from '../paths';
import { Discussion } from './Discussion';
import { useAnswer, useConversation, usePostLaneMessage } from './useConversation';
import type { DiscussionComment } from './model';

export default function LaneDiscussion({
  projectId,
  laneId,
  itemId,
  route,
}: {
  projectId: Id<'hostedProjects'>;
  laneId: string;
  itemId: string | null;
  route: Extract<AppRoute, { frame: 'project' }>;
}) {
  const conversation = useConversation(projectId, 'lane', laneId);
  const answer = useAnswer(projectId);
  const post = usePostLaneMessage(projectId, laneId);
  // One existing, indexed Item-comment page, only for the team while the Thread is open.
  const page = useArchivePaginatedQuery(
    workIndex.records,
    itemId && conversation.canWrite
      ? {
          projectId,
          collection: 'planningComments',
          parentId: itemId,
          memberCommentsOnly: true,
          newestFirst: true,
        }
      : 'skip',
    { initialNumItems: 20, followLiveCursors: true },
  );
  const comments = useMemo(
    () => page.results.map(row => JSON.parse(row.value) as DiscussionComment),
    [page.results],
  );
  return (
    <>
      {itemId ? (
        <p className="quietline">
          <A
            className="lk"
            href={hrefFor({ ...route, place: 'plan', section: '', rest: itemId }) + '#discussion'}
          >
            Open the Item discussion
          </A>
        </p>
      ) : null}
      <Discussion
        title="Thread"
        comments={comments}
        reviewLaneId={laneId}
        loading={Boolean(itemId && conversation.canWrite && page.status === 'LoadingFirstPage')}
        commentsFailed={page.status === 'Error'}
        loadingEarlier={page.status === 'LoadingMore'}
        loadEarlier={page.status === 'CanLoadMore' ? () => page.loadMore(20) : undefined}
        project={route}
        reportProjectId={projectId}
        canWrite={conversation.canWrite}
        onPost={post}
        conversation={{ ...conversation, answer }}
      />
    </>
  );
}
