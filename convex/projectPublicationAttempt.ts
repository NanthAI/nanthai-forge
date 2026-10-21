// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { activeOwnedProject } from './projectAuthority';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Serialize expensive validation by original operation, across action workers.
 * A dead worker's claim expires with the platform's ten-minute action budget. */
export const claim = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    operationId: v.string(),
    request: v.string(),
    attemptId: v.string(),
  },
  returns: v.object({ claimed: v.boolean(), receipt: v.union(v.id('projectBackups'), v.null()) }),
  handler: async (ctx, input) => {
    try {
      await activeOwnedProject(ctx, input.projectId, input.owner);
      const receipt = await ctx.db
        .query('projectBackups')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .unique();
      invariant(
        !receipt || receipt.request === input.request,
        'WORK_OPERATION_CHANGED',
        'Retry the original publication pins.',
      );
      if (receipt) return { claimed: false, receipt: receipt._id };
      const attempt = await ctx.db
        .query('projectPublicationAttempts')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .unique();
      invariant(
        !attempt || attempt.request === input.request,
        'WORK_OPERATION_CHANGED',
        'Retry the original publication pins.',
      );
      if (attempt && attempt.expiresAt > Date.now()) return { claimed: false, receipt: null };
      const fields = { ...input, expiresAt: Date.now() + 600_000 };
      if (attempt) await ctx.db.patch(attempt._id, fields);
      else await ctx.db.insert('projectPublicationAttempts', fields);
      return { claimed: true, receipt: null };
    } catch (error) {
      return report(error);
    }
  },
});
export const release = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    operationId: v.string(),
    attemptId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      await activeOwnedProject(ctx, input.projectId, input.owner);
      const attempt = await ctx.db
        .query('projectPublicationAttempts')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .unique();
      if (attempt?.attemptId === input.attemptId) await ctx.db.patch(attempt._id, { expiresAt: 0 });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
