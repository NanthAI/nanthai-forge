// SPDX-License-Identifier: Apache-2.0
import type { Doc } from './_generated/dataModel';
import { v } from 'convex/values';
import { query, mutation, type QueryCtx, type MutationCtx } from './cliServer';
import { accessibleProject, activeOwnedProject, activeProject } from './projectAuthority';
import { invariant } from '../src/errors';
import { guidanceInputSchema } from '../src/agent-guidance-schema';
import { report } from './errors';
async function projectEditable(ctx: QueryCtx | MutationCtx, project: Doc<'hostedProjects'>, actor: string) {
  if (project.owner === actor) return true;
  const member = await ctx.db
    .query('projectContributors')
    .withIndex('by_project_and_contributor', q => q.eq('projectId', project._id).eq('contributor', actor))
    .unique();
  return member?.agentGuidanceMaintainer === true;
}
const scope = v.union(v.literal('project'), v.literal('personal'));
export const read = query({
  args: { projectId: v.optional(v.id('hostedProjects')) },
  returns: v.object({ project: v.string(), personal: v.string(), projectEditable: v.boolean() }),
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read agent guidance.');
      const project = projectId ? await accessibleProject(ctx, projectId, user.subject) : null;
      const personal = await ctx.db
        .query('agentUserSettings')
        .withIndex('by_actor', q => q.eq('actor', user.subject))
        .unique();
      return {
        project: project?.agentGuidance ?? '',
        personal: personal?.agentGuidance ?? '',
        projectEditable: project ? await projectEditable(ctx, project, user.subject) : false,
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const set = mutation({
  args: {
    operationId: v.string(),
    scope,
    agentGuidance: v.string(),
    projectId: v.optional(v.id('hostedProjects')),
  },
  returns: v.object({ operationId: v.string(), scope, agentGuidance: v.string() }),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to set agent guidance.');
      const parsed = guidanceInputSchema.safeParse(input);
      invariant(
        parsed.success,
        'BAD_ARGUMENT',
        'Use an operation UUID and guidance of at most 4,000 characters.',
      );
      if (input.scope === 'project') {
        invariant(input.projectId, 'BAD_ARGUMENT', 'Choose a project for project guidance.');
        const project = await activeProject(ctx, input.projectId, user.subject);
        invariant(
          await projectEditable(ctx, project, user.subject),
          'PROJECT_UNAVAILABLE',
          'Project guidance is editable by its owner or an assigned guidance maintainer.',
        );
      }
      const original = await ctx.db
        .query('agentGuidanceOperations')
        .withIndex('by_actor_and_operationId', q =>
          q.eq('actor', user.subject).eq('operationId', input.operationId),
        )
        .unique();
      if (original) {
        invariant(
          original.scope === input.scope &&
            original.projectId === input.projectId &&
            original.agentGuidance === input.agentGuidance,
          'WORK_OPERATION_CHANGED',
          'Retry guidance with the original operation values.',
        );
        return {
          operationId: original.operationId,
          scope: original.scope,
          agentGuidance: original.agentGuidance,
        };
      }
      if (input.scope === 'project')
        await ctx.db.patch(input.projectId!, { agentGuidance: input.agentGuidance });
      else {
        const personal = await ctx.db
          .query('agentUserSettings')
          .withIndex('by_actor', q => q.eq('actor', user.subject))
          .unique();
        if (personal) await ctx.db.patch(personal._id, { agentGuidance: input.agentGuidance });
        else
          await ctx.db.insert('agentUserSettings', {
            actor: user.subject,
            agentGuidance: input.agentGuidance,
          });
      }
      await ctx.db.insert('agentGuidanceOperations', { ...input, actor: user.subject });
      return parsed.data;
    } catch (error) {
      return report(error);
    }
  },
});

/** Owner-assigned permission covers only agentGuidance; other project authority is unchanged. */
export const setMaintainer = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    actor: v.string(),
    maintainer: v.boolean(),
  },
  returns: v.object({ operationId: v.string(), actor: v.string(), maintainer: v.boolean() }),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to assign a guidance maintainer.');
      await activeOwnedProject(ctx, input.projectId, user.subject);
      invariant(
        /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId),
        'BAD_ARGUMENT',
        'Use an original operation UUID.',
      );
      const original = await ctx.db
        .query('agentGuidanceMaintainerOperations')
        .withIndex('by_owner_and_operationId', q =>
          q.eq('owner', user.subject).eq('operationId', input.operationId),
        )
        .unique();
      if (original) {
        invariant(
          original.projectId === input.projectId &&
            original.actor === input.actor &&
            original.maintainer === input.maintainer,
          'WORK_OPERATION_CHANGED',
          'Retry this maintainer operation with its original values.',
        );
        return { operationId: original.operationId, actor: original.actor, maintainer: original.maintainer };
      }
      const member = await ctx.db
        .query('projectContributors')
        .withIndex('by_project_and_contributor', q =>
          q.eq('projectId', input.projectId).eq('contributor', input.actor),
        )
        .unique();
      invariant(member, 'PROJECT_UNAVAILABLE', 'Choose an existing project member.');
      await ctx.db.patch(member._id, { agentGuidanceMaintainer: input.maintainer });
      await ctx.db.insert('agentGuidanceMaintainerOperations', { ...input, owner: user.subject });
      return { operationId: input.operationId, actor: input.actor, maintainer: input.maintainer };
    } catch (error) {
      return report(error);
    }
  },
});
