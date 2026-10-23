// SPDX-License-Identifier: Apache-2.0
import { retainMembership } from './projectActorNames';
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query, internalMutation } from './cliServer';
import { activeOwnedProject, ownedProject } from './projectAuthority';
import { invariant } from '../src/errors';
import { report } from './errors';

export const set = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    reader: v.string(),
    present: v.boolean(),
    operationId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      await activeOwnedProject(ctx, input.projectId, input.owner);
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
      // Reader grants never replace or downgrade an owner's existing contributor grants.
      const contributor = await ctx.db
        .query('projectContributors')
        .withIndex('by_project_and_contributor', q =>
          q.eq('projectId', input.projectId).eq('contributor', input.reader),
        )
        .unique();
      invariant(
        !input.present || (!contributor && input.reader !== input.owner),
        'BAD_ARGUMENT',
        'This account already has write access; a reader grant cannot make it read-only.',
      );
      const grant = await ctx.db
        .query('projectReaders')
        .withIndex('by_project_and_reader', q =>
          q.eq('projectId', input.projectId).eq('reader', input.reader),
        )
        .unique();
      if (input.present && !grant)
        await ctx.db.insert('projectReaders', { projectId: input.projectId, reader: input.reader });
      if (!input.present && grant) {
        await retainMembership(ctx, input.projectId, input.reader);
        await ctx.db.delete(grant._id);
      }
      await ctx.db.insert('projectReaderOperations', input);
      return null;
    } catch (error) {
      return report(error);
    }
  },
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
