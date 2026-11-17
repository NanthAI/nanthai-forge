// SPDX-License-Identifier: Apache-2.0
// Reactions on planning comments (Item 9a3d6f5f). One bounded read per open Item returns counts and the viewer's own
// marks, never who else reacted; a toggle is one mutation. Who may react follows who may comment (the project's
// planning writers), so reactions widen with comments, never ahead of them. A reaction is a person's: agent (device)
// credentials are refused, as for stars, and a reaction must name a comment that exists on that Item.
import { v } from 'convex/values';
import { isDeviceIdentity, mutation, query, type MutationCtx } from './cliServer';
import type { Doc } from './_generated/dataModel';
import { accessibleProject, activeProject } from './projectAuthority';
import { invariant } from '../src/errors';
import { reactionKind, reactionKinds } from './planningReactionFields';
import { recordHead } from './projectHostedRecords';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';

/** An Item's reactions are read in one page. Owner-only writers make far fewer; past this the counts say so. */
const REACTION_READ_LIMIT = 2000;
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const count = v.object({ commentId: v.string(), kind: reactionKind, count: v.number(), mine: v.boolean() });

export const forItem = query({
  args: { projectId: v.id('hostedProjects'), itemId: v.string() },
  returns: v.object({ counts: v.array(count), complete: v.boolean() }),
  handler: async (ctx, { projectId, itemId }) => {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read this project.');
    await accessibleProject(ctx, projectId, user.subject);
    const rows = await ctx.db
      .query('planningReactions')
      .withIndex('by_project_and_item', q => q.eq('projectId', projectId).eq('itemId', itemId))
      .take(REACTION_READ_LIMIT + 1);
    const counts = new Map<
      string,
      { commentId: string; kind: (typeof reactionKinds)[number]; count: number; mine: boolean }
    >();
    for (const row of rows.slice(0, REACTION_READ_LIMIT)) {
      const key = `${row.commentId}:${row.kind}`;
      const entry = counts.get(key) ?? { commentId: row.commentId, kind: row.kind, count: 0, mine: false };
      entry.count++;
      if (row.actor === user.subject) entry.mine = true;
      counts.set(key, entry);
    }
    return { counts: [...counts.values()], complete: rows.length <= REACTION_READ_LIMIT };
  },
});

/** Whether this comment is on this Item: one head read from the record store, or one index row from the Work index. */
async function commentOnItem(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  itemId: string,
  commentId: string,
) {
  if (project.workStore === 'records') {
    const head = await recordHead(ctx, project._id, 'comment', commentId);
    return head?.status === 'comment' && head.parent === itemId;
  }
  const generation = await selectedGeneration(ctx, project);
  if (!generation) return false;
  const row = await record(ctx, recordPartition(generation), 'planningComments', commentId);
  return row?.parent === itemId;
}

/** Adds the viewer's reaction of this kind to the comment, or takes it off when it is there. Retrying a lost reply
 * converges: the reply says whether the reaction is now on. */
export const toggle = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    itemId: v.string(),
    commentId: v.string(),
    kind: reactionKind,
    on: v.boolean(),
  },
  returns: v.object({ on: v.boolean() }),
  handler: async (ctx, { projectId, itemId, commentId, kind, on }) => {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to use your Forge project.');
    invariant(
      !isDeviceIdentity(user),
      'AUTH_SCOPE_DENIED',
      'A reaction is a person’s: agents cannot react. Open the Item in a browser, signed in, to react.',
    );
    const project = await activeProject(ctx, projectId, user.subject);
    invariant(
      project.owner === user.subject,
      'PROJECT_UNAVAILABLE',
      'Project planning is available to its current owner.',
    );
    invariant(uuid.test(itemId) && uuid.test(commentId), 'BAD_ARGUMENT', 'Name the comment by its id.');
    // Taking a reaction off needs no comment check, so one left on a comment that is gone can still be removed.
    if (on)
      invariant(
        await commentOnItem(ctx, project, itemId, commentId),
        'NOT_FOUND',
        'React to a comment on this Item.',
      );
    const mine = await ctx.db
      .query('planningReactions')
      .withIndex('by_project_and_comment_and_actor', q =>
        q.eq('projectId', projectId).eq('commentId', commentId).eq('actor', user.subject),
      )
      .take(reactionKinds.length + 1);
    const found = mine.find(row => row.kind === kind);
    // `on` is the state asked for, so a retried toggle never flips twice.
    if (on && !found)
      await ctx.db.insert('planningReactions', { projectId, itemId, commentId, actor: user.subject, kind });
    if (!on && found) await ctx.db.delete(found._id);
    return { on };
  },
});
