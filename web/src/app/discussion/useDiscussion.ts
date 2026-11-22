// SPDX-License-Identifier: Apache-2.0
// The hosted reads and writes behind an Item's Discussion (Item 9a3d6f5f). Comments are the Work index's comment pages
// for the Item, newest first: one page of 100 on open, the next only when the reader asks for earlier comments, so an
// open reads the same however long the discussion grows (Item 686ecdde). Reactions are one bounded read.
// Nothing polls and nothing reads on a clock, so an open idle Item makes no calls. A comment keeps one operation id
// until it is sent, so a retry after a lost reply never posts twice. The server records who wrote it from the
// sign-in; the page sends no name.
import { useCallback, useRef } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../../convex/_generated/dataModel';
import { useWorkIndex, useWorkPage } from '../../hosted-work-index';
import type { DiscussionComment, ReactionCount, ReactionKind } from './model';
import type { PostInput } from './Discussion';

const reactionsFor = makeFunctionReference<
  'query',
  { projectId: Id<'hostedProjects'>; itemId: string },
  { counts: ReactionCount[]; complete: boolean }
>('planningReactions:forItem');
const toggleReaction = makeFunctionReference<
  'mutation',
  { projectId: Id<'hostedProjects'>; itemId: string; commentId: string; kind: ReactionKind; on: boolean },
  { on: boolean }
>('planningReactions:toggle');
const workCommand = makeFunctionReference<
  'mutation',
  { projectId: Id<'hostedProjects'>; operationId: string; command: string },
  unknown
>('projectWorkCommand:command');

export function useDiscussion(projectId: Id<'hostedProjects'>, itemId: string) {
  const { workspace } = useWorkIndex(projectId);
  const canWrite = Boolean(workspace?.capabilities.owner);
  const page = useWorkPage<DiscussionComment>(projectId, workspace, 'planningComments', itemId);
  const reactions = useQuery(reactionsFor, canWrite ? { projectId, itemId } : 'skip');
  const send = useMutation(workCommand);
  const flip = useMutation(toggleReaction);
  const draft = useRef<{ key: string; operationId: string } | null>(null);

  const post = useCallback(
    async (input: PostInput) => {
      const key = JSON.stringify(input);
      if (draft.current?.key !== key) draft.current = { key, operationId: crypto.randomUUID() };
      const { operationId } = draft.current;
      await send({
        projectId,
        operationId,
        command: JSON.stringify({
          action: 'comment-planning-item',
          operationId,
          itemId,
          text: input.text,
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
          ...(input.decision ? { decision: true } : {}),
        }),
      });
      draft.current = null;
    },
    [send, projectId, itemId],
  );
  const counts = reactions?.counts;
  const react = useCallback(
    async (commentId: string, kind: ReactionKind) => {
      const mine = counts?.some(entry => entry.commentId === commentId && entry.kind === kind && entry.mine);
      await flip({ projectId, itemId, commentId, kind, on: !mine });
    },
    [flip, counts, projectId, itemId],
  );
  return {
    comments: page.records,
    loading: page.initialLoading,
    loadEarlier: page.more,
    loadingEarlier: page.loadingMore,
    failed: Boolean(page.failed),
    reactions: counts ?? [],
    canWrite,
    post,
    react,
  };
}
