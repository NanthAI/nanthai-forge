// SPDX-License-Identifier: Apache-2.0
import { retainMembership } from './projectActorNames';
import { createInvitation } from './projectInvitationCreate';
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { query, internalMutation } from './cliServer';
import { activeOwnedProject, ownedProject } from './projectAuthority';
import { invariant } from '../src/errors';
import { report } from './errors';
import { syncPersonOrder } from './accountProjectOrder';
import { hasWriteRole } from './projectRole';

export const set = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    reader: v.string(),
    present: v.boolean(),
    operationId: v.string(),
  },
  returns: v.null(),
  handler: setReader,
});

export const list = query({
  args: { projectId: v.id('hostedProjects'), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ reader: v.string() })),
  handler: async (ctx, { projectId, paginationOpts }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to manage project readers.');
      await ownedProject(ctx, projectId, user.subject);
      const result = await ctx.db
        .query('projectReaders')
        .withIndex('by_project_and_reader', q => q.eq('projectId', projectId))
        .paginate(paginationOpts);
      return { ...result, page: result.page.map(row => ({ reader: row.reader })) };
    } catch (error) {
      return report(error);
    }
  },
});

/** Current reader grants are discoverable on Home, including projects without contributions. */
export const shared = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ id: v.id('hostedProjects'), name: v.string() })),
  handler: async (ctx, { paginationOpts }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return { page: [], isDone: true, continueCursor: '' };
    const grants = await ctx.db
      .query('projectReaders')
      .withIndex('by_reader', q => q.eq('reader', user.subject))
      .order('desc')
      .paginate(paginationOpts);
    const page = [];
    for (const grant of grants.page) {
      const project = await ctx.db.get(grant.projectId);
      if (project && !project.removal && project.owner !== user.subject)
        page.push({ id: project._id, name: project.name });
    }
    return { ...grants, page };
  },
});

export async function setReader(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    owner: string;
    reader: string;
    present: boolean;
    operationId: string;
  },
): Promise<null> {
  try {
    const project = await activeOwnedProject(ctx, input.projectId, input.owner);
    invariant(
      /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId),
      'BAD_ARGUMENT',
      'Use an original reader operation UUID.',
    );
    const original = await ctx.db
      .query('projectReaderOperations')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', input.projectId).eq('operationId', input.operationId),
      )
      .unique();
    if (original) {
      invariant(
        original.owner === input.owner &&
          original.reader === input.reader &&
          original.present === input.present,
        'WORK_OPERATION_CHANGED',
        'Retry this reader operation with its original values.',
      );
      return null;
    }
    // Reader grants never replace or downgrade existing write access, direct or through a linked team.
    invariant(
      !input.present || (input.reader !== input.owner && !(await hasWriteRole(ctx, project, input.reader))),
      'BAD_ARGUMENT',
      'This account already has write access; a reader grant cannot make it read-only.',
    );
    const grant = await ctx.db
      .query('projectReaders')
      .withIndex('by_project_and_reader', q => q.eq('projectId', input.projectId).eq('reader', input.reader))
      .unique();
    if (input.present && !grant) {
      const account = await ctx.db
        .query('forgeAccounts')
        .withIndex('by_owner', q => q.eq('owner', input.reader))
        .unique();
      invariant(account, 'BAD_ARGUMENT', 'Invite this person by their Forge handle.');
      await createInvitation(ctx, {
        projectId: input.projectId,
        owner: input.owner,
        operationId: input.operationId,
        person: `@${account.handle}`,
        role: 'read',
      });
    }
    if (!input.present && grant) {
      await retainMembership(ctx, input.projectId, input.reader, input.owner);
      await ctx.db.delete(grant._id);
      await syncPersonOrder(ctx, input.projectId, input.reader);
    }
    await ctx.db.insert('projectReaderOperations', input);
    return null;
  } catch (error) {
    return report(error);
  }
}
