// SPDX-License-Identifier: Apache-2.0
// The Code place's history (Items 90e5bc9c, 3968a655): what landed on main, newest first, one receipt per row.
// Metadata only, from the receipts already stored at acceptance: no source bytes, no per-row reads beyond the page.
import { v } from 'convex/values';
import { query } from './cliServer';
import { internalQuery } from './server';
import { accessibleProject } from './projectAuthority';
import { report } from './errors';
import { invariant } from '../src/errors';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import { codeHistoryRow, CODE_HISTORY_PAGE, CODE_HISTORY_READ_BYTES } from '../src/code-history';

/** One page of landings on main by main's own sequence, newest first. At most 25 receipts and 256 KB read per page;
 * the cursor resumes exactly. Re-runs only when a landing is accepted (a new receipt row); idle costs nothing. */
export const history = query({
  args: { projectId: v.id('hostedProjects'), cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      // Public projects open to signed-out readers with the public reads Item (6a60e89a); the view needs no change.
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read what landed.');
      await accessibleProject(ctx, input.projectId, user.subject);
      const page = await ctx.db
        .query('projectHostedAcceptances')
        .withIndex('by_project_and_sequence', q => q.eq('projectId', input.projectId))
        .order('desc')
        .paginate({
          cursor: input.cursor,
          numItems: CODE_HISTORY_PAGE,
          maximumRowsRead: CODE_HISTORY_PAGE,
          maximumBytesRead: CODE_HISTORY_READ_BYTES,
        });
      return JSON.stringify({
        schema: 1,
        landings: page.page.map(row =>
          codeHistoryRow(JSON.parse(row.value) as HostedAcceptance, row.sequence),
        ),
        nextCursor: page.isDone ? null : page.continueCursor,
      });
    } catch (error) {
      return report(error);
    }
  },
});

/** The stored checkpoint the project's source reads verify against. The caller's checkpoint mutation authorizes. */
export const checkpoint = internalQuery({
  args: { projectId: v.id('hostedProjects') },
  returns: v.union(v.id('projectBackups'), v.null()),
  handler: async (ctx, { projectId }) => (await ctx.db.get(projectId))?.work?.backupId ?? null,
});
