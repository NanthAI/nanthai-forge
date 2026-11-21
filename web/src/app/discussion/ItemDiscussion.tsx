// SPDX-License-Identifier: Apache-2.0
// An Item's Discussion with its hosted reads and writes, loaded on its own chunk when an Item page opens (Item 9a3d6f5f),
// so the Plan list never loads the Markdown renderer.
import type { Id } from '../../../../convex/_generated/dataModel';
import type { WhoProject } from '../who-links';
import { Discussion } from './Discussion';
import { useDiscussion } from './useDiscussion';
import { useAnswer, useConversation } from './useConversation';

export default function ItemDiscussion({
  projectId,
  itemId,
  project,
}: {
  projectId: Id<'hostedProjects'>;
  itemId: string;
  project?: WhoProject | undefined;
}) {
  const { comments, loading, reactions, canWrite, post, react } = useDiscussion(projectId, itemId);
  const conversation = useConversation(projectId, 'item', itemId);
  const answer = useAnswer(projectId);
  return (
    <Discussion
      comments={comments}
      conversation={{ ...conversation, answer }}
      project={project}
      reactions={reactions}
      canWrite={canWrite}
      loading={loading}
      onPost={post}
      onReact={react}
    />
  );
}
