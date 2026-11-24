// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// An Item's Discussion with its hosted reads and writes, loaded on its own chunk when an Item page opens (Item 9a3d6f5f),
// so the Plan list never loads the Markdown renderer.
import type { Id } from '../../../../convex/_generated/dataModel';
import type { WhoProject } from '../who-links';
import { Discussion } from './Discussion';
import { useDiscussion } from './useDiscussion';
import { useAnswer, useConversation } from './useConversation';

export function useItemDiscussion({
  projectId,
  itemId,
  project,
}: {
  projectId: Id<'hostedProjects'>;
  itemId: string;
  project?: WhoProject | undefined;
}) {
  const {
    comments,
    loading,
    loadEarlier,
    loadingEarlier,
    failed,
    reactions,
    canWrite,
    post,
    react,
    readAttachment,
  } = useDiscussion(projectId, itemId);
  const conversation = useConversation(projectId, 'item', itemId);
  const answer = useAnswer(projectId);
  return {
    comments,
    discussion: (
      <Discussion
        itemPage
        comments={comments}
        conversation={{ ...conversation, answer }}
        project={project}
        reportProjectId={projectId}
        reactions={reactions}
        canWrite={canWrite}
        loading={loading}
        loadEarlier={loadEarlier}
        loadingEarlier={loadingEarlier}
        commentsFailed={failed}
        onPost={post}
        onReact={react}
        readAttachment={readAttachment}
      />
    ),
  };
}
