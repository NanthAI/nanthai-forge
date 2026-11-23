// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The Code place's history (Items 90e5bc9c, 3968a655): what landed on main, newest first, one receipt per row.
// Metadata only. Referenced messages use one bounded body read per returned receipt, with no source reads.
import { v } from 'convex/values';
import { query } from './cliServer';
import { internalQuery } from './server';
import { accessibleProject } from './projectAuthority';
import { isPublicProject } from './publicVisibility';
import { report } from './errors';
import { invariant } from '../src/errors';
import { findStoredObject, isRegisteredState } from './projectObjectFind';
import { isStored, objectDocument } from './projectObjectFields';
import { CODE_HISTORY_PAGE, CODE_HISTORY_READ_BYTES } from '../src/code-history';
import { codeFileHistory, codeHistoryReceipt, readCodeHistoryRow } from './projectCodeFileHistory';

/** One page of landings on main by main's own sequence, newest first. At most 25 receipts and 256 KB of receipt reads
 * per page, plus at most 25 one-KiB referenced messages.
 * the cursor resumes exactly. Re-runs only when a landing is accepted (a new receipt row); idle costs nothing. */
export const history = query({
  args: {
    projectId: v.id('hostedProjects'),
    cursor: v.union(v.string(), v.null()),
    receiptId: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      // Signed-out visitors read the same rows through the cached public route (publicCode.ts), never this query.
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read what landed.');
      await accessibleProject(ctx, input.projectId, user.subject);
      if (input.receiptId !== undefined)
        return JSON.stringify({
          schema: 1,
          landings: await codeHistoryReceipt(ctx, input.projectId, input.receiptId, false),
          nextCursor: null,
        });
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
        landings: await Promise.all(page.page.map(row => readCodeHistoryRow(ctx, row))),
        nextCursor: page.isDone ? null : page.continueCursor,
      });
    } catch (error) {
      return report(error);
    }
  },
});

export const fileHistory = query({
  args: { projectId: v.id('hostedProjects'), path: v.string(), before: v.union(v.number(), v.null()) },
  returns: v.string(),
  handler: async (ctx, { projectId, path, before }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read what landed.');
      await accessibleProject(ctx, projectId, user.subject);
      return JSON.stringify(await codeFileHistory(ctx, projectId, path, before, false));
    } catch (error) {
      return report(error);
    }
  },
});

/** Select the exact registered State for signed-in Code or its retained checkpoint fallback.
 * Unreadable projects answer like missing ones. Visitors can only select public checkpoints. */
export const checkpoint = internalQuery({
  args: { projectId: v.id('hostedProjects'), state: v.optional(v.string()) },
  returns: v.object({
    backupId: v.union(v.id('projectBackups'), v.null()),
    canonical: v.union(objectDocument, v.null()),
  }),
  handler: async (ctx, { projectId, state }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      const project = user
        ? await accessibleProject(ctx, projectId, user.subject)
        : await ctx.db.get(projectId);
      invariant(
        isPublicProject(project) || (user && project),
        'PROJECT_UNAVAILABLE',
        'This Forge project is unavailable with the current account.',
      );
      const backupId = project!.work?.backupId ?? null;
      if (!state || !user || project!.sourceAuthority?.mode !== 'server')
        return { backupId, canonical: null };
      const row = await findStoredObject(ctx, projectId, state);
      if (!row || row.removed || !isStored(row)) return { backupId, canonical: null };
      return { backupId, canonical: (await isRegisteredState(ctx, row)) ? row : null };
    } catch (error) {
      // Called with runQuery: only a ConvexError keeps PROJECT_UNAVAILABLE for the caller.
      return report(error);
    }
  },
});
