// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { activeProject } from './projectAuthority';
import { isStored } from './projectObjectFields';
import { invariant } from '../src/errors';

// Only the action that has streamed and verified complete logical bytes calls
// this mutation. Binding is immutable; equivalent raw/recipe races keep the winner.
export const bind = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    digest: v.string(),
    size: v.number(),
    recipeDigest: v.string(),
    recipeSize: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    await activeProject(ctx, input.projectId, input.actor);
    const recipe = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q =>
        q.eq('projectId', input.projectId).eq('digest', input.recipeDigest),
      )
      .unique();
    invariant(
      recipe && !recipe.removed && isStored(recipe) && recipe.size === input.recipeSize,
      'INVALID_WORK_BACKUP',
      'Verified object recipe is unavailable.',
    );
    let row = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q => q.eq('projectId', input.projectId).eq('digest', input.digest))
      .unique();
    invariant(
      !row || (row.size === input.size && !row.removed),
      'INVALID_WORK_BACKUP',
      'Content differs from its original binding.',
    );
    if (row && isStored(row)) return null;
    if (!row) {
      const id = await ctx.db.insert('projectObjects', {
        projectId: input.projectId,
        digest: input.digest,
        size: input.size,
        nonce: crypto.randomUUID(),
        removed: false,
      });
      row = (await ctx.db.get(id))!;
    }
    await ctx.db.patch(row._id, { recipe: { digest: input.recipeDigest, size: input.recipeSize } });
    return null;
  },
});

/** An existing immutable logical binding is the original completion receipt,
 * not a new storage-health claim. Current ownership is checked on every retry. */
export const stored = internalQuery({
  args: { projectId: v.id('hostedProjects'), actor: v.string(), digest: v.string(), size: v.number() },
  returns: v.boolean(),
  handler: async (ctx, input) => {
    await activeProject(ctx, input.projectId, input.actor);
    const row = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q => q.eq('projectId', input.projectId).eq('digest', input.digest))
      .unique();
    invariant(
      !row || (row.size === input.size && !row.removed),
      'INVALID_WORK_BACKUP',
      'Content differs from its original binding.',
    );
    return !!(row?.storageId || row?.recipe);
  },
});
