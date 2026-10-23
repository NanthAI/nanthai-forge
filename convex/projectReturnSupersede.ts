// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation } from './cliServer';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { activeOwnedProject } from './projectAuthority';
import { workProject } from './projectWorkHead';
import { invariant } from '../src/errors';
import { report } from './errors';

export async function requireActiveReturn(
  ctx: MutationCtx | QueryCtx,
  projectId: Id<'hostedProjects'>,
  operationId: string,
) {
  const retired = await ctx.db
    .query('projectReturnSupersessions')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();
  invariant(
    !retired,
    'SOURCE_RETURN_SUPERSEDED',
    'This source return was explicitly superseded. Resume the replacement push.',
  );
}
/** The tombstone and the final return receipt race in the same database transaction.
 * No checkpoint, source object, Work record or staging data is deleted. */
export const supersede = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    pushOperationId: v.string(),
    expectedBackupId: v.id('projectBackups'),
    revision: v.number(),
    replacementId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to supersede your retained push.');
      const project = await workProject(ctx, await activeOwnedProject(ctx, input.projectId, user.subject));
      invariant(
        [input.operationId, input.pushOperationId, input.replacementId].every(id =>
          /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id),
        ) &&
          Number.isSafeInteger(input.revision) &&
          input.revision >= 0,
        'BAD_ARGUMENT',
        'Use the original push and return UUIDs, replacement UUID and hosted revision.',
      );
      const prior = await ctx.db
        .query('projectReturnSupersessions')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .unique();
      if (prior) {
        invariant(
          Object.entries(input).every(([key, value]) => prior[key as keyof typeof prior] === value),
          'WORK_OPERATION_CHANGED',
          'Resume the original supersede request.',
        );
        return null;
      }
      const committed = await ctx.db
        .query('projectWorkEvents')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .unique();
      invariant(
        !committed,
        'SOURCE_RETURN_COMMITTED',
        'The retained source return committed. Reconcile its original receipt.',
      );
      invariant(
        project.work?.backupId === input.expectedBackupId && project.work.revision === input.revision,
        'WORK_STALE',
        'Hosted source or Work moved since this push began. The retained push remains available.',
      );
      await ctx.db.insert('projectReturnSupersessions', input);
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
