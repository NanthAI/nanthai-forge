// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/** The reactions a planning comment can get (Item 9a3d6f5f): GitHub's eight, by name. Stars are for projects only. */
export const reactionKinds = ['+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes'] as const;
export const reactionKind = v.union(...reactionKinds.map(kind => v.literal(kind)));

/** One person's reaction of one kind on one comment; removing it deletes the row. Kept beside the Work journal, not in
 * it: a reaction is a toggle, not discussion history. */
export const planningReactionTables = {
  planningReactions: defineTable({
    projectId: v.id('hostedProjects'),
    itemId: v.string(),
    commentId: v.string(),
    actor: v.string(),
    kind: reactionKind,
  })
    .index('by_project_and_item', ['projectId', 'itemId'])
    .index('by_project_and_comment_and_actor', ['projectId', 'commentId', 'actor']),
};
