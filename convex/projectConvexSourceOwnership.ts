// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalQuery } from './server';

/** Legacy progress refs have no project namespace. Never infer ownership from
 * cursor contents or a supplied storage id; require an existing live binding.
 * Unregistered pre-cutover continuations need migration before they can resume. */
export const owns = internalQuery({
  args: { projectId: v.id('hostedProjects'), ref: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { projectId, ref }) => {
    const storageId = ctx.db.system.normalizeId('_storage', ref);
    if (!storageId) return false;
    const row = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_storage_and_removed', q =>
        q.eq('projectId', projectId).eq('storageId', storageId).eq('removed', false),
      )
      .first();
    return row !== null;
  },
});
