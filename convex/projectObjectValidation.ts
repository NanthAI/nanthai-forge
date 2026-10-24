// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalQuery } from './_generated/server';
import { activeOwnedProject } from './projectAuthority';
import { isStored } from './projectObjectFields';
import { report } from './errors';
/** First-host completion scans the new project's content index once rather than
 * resolving every retained hash separately. Every page rechecks current access. */
export const page = internalQuery({
  args: { projectId: v.id('hostedProjects'), actor: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    pins: v.array(v.object({ digest: v.string(), size: v.number(), stored: v.boolean() })),
    isDone: v.boolean(),
    cursor: v.string(),
  }),
  handler: async (ctx, { projectId, actor, cursor }) => {
    try {
      await activeOwnedProject(ctx, projectId, actor);
      const page = await ctx.db
        .query('projectObjects')
        .withIndex('by_project_and_digest', q => q.eq('projectId', projectId))
        .paginate({ cursor, numItems: 100 });
      return {
        pins: page.page.map(row => ({
          digest: row.digest,
          size: row.size,
          stored: isStored(row) && !row.removed,
        })),
        isDone: page.isDone,
        cursor: page.continueCursor,
      };
    } catch (error) {
      return report(error);
    }
  },
});
