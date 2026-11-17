// SPDX-License-Identifier: Apache-2.0
// An Item's Discussion with its hosted reads and writes, loaded on its own chunk when an Item page opens (Item 9a3d6f5f),
// so the Plan list never loads the Markdown renderer.
import type { Id } from '../../../../convex/_generated/dataModel';
import { Discussion } from './Discussion';
import { useDiscussion } from './useDiscussion';

export default function ItemDiscussion({
  projectId,
  itemId,
}: {
  projectId: Id<'hostedProjects'>;
  itemId: string;
}) {
  const { comments, loading, reactions, canWrite, post, react } = useDiscussion(projectId, itemId);
  return (
    <Discussion
      comments={comments}
      reactions={reactions}
      canWrite={canWrite}
      loading={loading}
      onPost={post}
      onReact={react}
    />
  );
}
