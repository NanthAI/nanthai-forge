// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Id } from '../../../../convex/_generated/dataModel';
import { A } from '../frames';
import { hrefFor, type AppRoute } from '../paths';
import { Discussion } from './Discussion';
import { useAnswer, useConversation, usePostLaneMessage } from './useConversation';

export default function LaneDiscussion({
  projectId,
  laneId,
  intentId,
  route,
}: {
  projectId: Id<'hostedProjects'>;
  laneId: string;
  intentId: string | null;
  route: Extract<AppRoute, { frame: 'project' }>;
}) {
  const conversation = useConversation(projectId, 'lane', laneId);
  const answer = useAnswer(projectId);
  const post = usePostLaneMessage(projectId, laneId);
  return (
    <>
      {intentId ? (
        <p className="quietline">
          <A
            className="lk"
            href={hrefFor({ ...route, place: 'plan', section: '', rest: intentId }) + '#discussion'}
          >
            Open the Item discussion
          </A>
        </p>
      ) : null}
      <Discussion
        title="Thread"
        comments={[]}
        project={route}
        reportProjectId={projectId}
        canWrite={conversation.canWrite}
        onPost={post}
        conversation={{ ...conversation, answer }}
      />
    </>
  );
}
