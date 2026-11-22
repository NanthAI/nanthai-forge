// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { readableProject, sourcePins } from './projectObjectDownloads';
import { projectBackupDocument } from './schema';
import { invariant } from '../src/errors';
import { report } from './errors';
/** Private viewer context. The public action returns rendered pages, never this archive plan. */
export const checkpoint = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    backupId: v.id('projectBackups'),
    recheck: v.boolean(),
    digests: v.array(v.string()),
    /** The visitor key a signed-out read carries from the site (convex/visitorBudget.ts). */
    client: v.optional(v.string()),
  },
  returns: v.object({
    backup: projectBackupDocument,
    pins: v.union(v.null(), v.array(v.object({ sha256: v.string(), size: v.number() }))),
  }),
  handler: async (ctx, input) => {
    try {
      const project = await readableProject(ctx, input.projectId, !input.recheck, input.client);
      const backup = await ctx.db.get(input.backupId);
      invariant(
        backup && backup.projectId === input.projectId && backup.status === 'stored',
        'PROJECT_UNAVAILABLE',
        'Select a stored checkpoint from this project.',
      );
      return {
        backup,
        pins: input.recheck ? null : await sourcePins(ctx, project, input.backupId, input.digests),
      };
    } catch (error) {
      // Called with runMutation: only a ConvexError keeps PROJECT_UNAVAILABLE and RATE_LIMITED for the reader.
      return report(error);
    }
  },
});
