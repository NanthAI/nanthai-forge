// SPDX-License-Identifier: Apache-2.0
import { retainMembership } from './projectActorNames';
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  type QueryCtx,
  type MutationCtx,
} from './cliServer';
import type { Id } from './_generated/dataModel';
import { ownedProject, activeProject, activeOwnedProject } from './projectAuthority';
import { invariant } from '../src/errors';
import { report } from './errors';
import { selectedGeneration, record, recordPartition } from './projectWorkIndexStore';

export async function intentAuthority(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  intentId: string,
) {
  const project = await activeProject(ctx, projectId, actor);
  const generation = await selectedGeneration(ctx, project);
  const alias = generation ? await record(ctx, recordPartition(generation), 'intentAliases', intentId) : null;
  const targetId: string = alias ? JSON.parse(alias.value).intentId : intentId;
  const event = await ctx.db
    .query('projectWorkEvents')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', targetId))
    .unique();
  const row = generation ? await record(ctx, recordPartition(generation), 'intents', targetId) : null;
  const intent = row ? JSON.parse(row.value) : null;
  const authority = generation
    ? await record(ctx, recordPartition(generation), 'intentAuthorities', `${targetId}:${actor}`)
    : null;
  const command = event ? JSON.parse(event.command) : null;
  invariant(
    (intent || command?.action === 'intent') &&
      (project.owner === actor ||
        (command?.action === 'intent' && event?.actor === actor) ||
        Boolean(authority) ||
        intent?.creatorAccountId === actor ||
        (Array.isArray(intent?.assigneeAccountIds) && intent.assigneeAccountIds.includes(actor))),
    'PROJECT_UNAVAILABLE',
    'Select an Intent created by or assigned to this account on this Forge project.',
  );
  return { project, event, command: command as { action: 'intent'; base: string } | null };
}
export const add = internalMutation({
  args: { projectId: v.id('hostedProjects'), owner: v.string(), contributor: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, owner, contributor }) => {
    try {
      await activeOwnedProject(ctx, projectId, owner);
      if (contributor === owner) return null;
      const old = await ctx.db
        .query('projectContributors')
        .withIndex('by_project_and_contributor', q =>
          q.eq('projectId', projectId).eq('contributor', contributor),
        )
        .unique();
      if (!old) await ctx.db.insert('projectContributors', { projectId, contributor });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const remove = mutation({
  args: { projectId: v.id('hostedProjects'), contributor: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, contributor }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to manage your Forge project.');
      await ownedProject(ctx, projectId, user.subject);
      const grant = await ctx.db
        .query('projectContributors')
        .withIndex('by_project_and_contributor', q =>
          q.eq('projectId', projectId).eq('contributor', contributor),
        )
        .unique();
      if (grant) {
        await retainMembership(ctx, projectId, contributor);
        await ctx.db.delete(grant._id);
      }
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const list = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.array(
    v.object({
      id: v.id('projectContributors'),
      contributor: v.string(),
      at: v.number(),
      agentGuidanceMaintainer: v.optional(v.boolean()),
    }),
  ),
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to manage your Forge project.');
      await ownedProject(ctx, projectId, user.subject);
      const grants = [];
      for await (const grant of ctx.db
        .query('projectContributors')
        .withIndex('by_project_and_contributor', q => q.eq('projectId', projectId)))
        grants.push(grant);
      return grants.map(grant => ({
        id: grant._id,
        contributor: grant.contributor,
        ...(grant.agentGuidanceMaintainer !== undefined
          ? { agentGuidanceMaintainer: grant.agentGuidanceMaintainer }
          : {}),
        at: grant._creationTime,
      }));
    } catch (error) {
      return report(error);
    }
  },
});
export const shared = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({
      id: v.id('hostedProjects'),
      key: v.string(),
      name: v.string(),
      currentBackup: v.union(v.id('projectBackups'), v.null()),
      revision: v.number(),
    }),
  ),
  handler: async (ctx, { paginationOpts }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return { page: [], isDone: true, continueCursor: '' };
    const grants = await ctx.db
      .query('projectContributors')
      .withIndex('by_contributor', q => q.eq('contributor', user.subject))
      .order('desc')
      .paginate(paginationOpts);
    const page = [];
    for (const grant of grants.page) {
      const project = await ctx.db.get(grant.projectId);
      if (project && !project.removal)
        page.push({
          id: project._id,
          key: project.key,
          name: project.name,
          currentBackup: project.currentBackup,
          revision: project.revision,
        });
    }
    return { ...grants, page };
  },
});

// Handle search is available only to the current access manager.
export const handles = query({
  args: { projectId: v.id('hostedProjects'), prefix: v.string() },
  returns: v.array(v.object({ handle: v.string() })),
  handler: async (ctx, { projectId, prefix }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to manage access.');
      await ownedProject(ctx, projectId, user.subject);
      const value = prefix.replace(/^@/, '').toLowerCase().trim();
      if (!value || value.includes('@')) return [];
      const rows = await ctx.db
        .query('forgeAccounts')
        .withIndex('by_handle', q => q.gte('handle', value).lt('handle', value + '\uffff'))
        .take(10);
      return rows.map(row => ({ handle: row.handle }));
    } catch (error) {
      return report(error);
    }
  },
});
export const identity = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    contributor: v.optional(v.string()),
    handle: v.optional(v.string()),
  },
  returns: v.union(v.object({ owner: v.string(), handle: v.string() }), v.null()),
  handler: async (ctx, input) => {
    try {
      await activeOwnedProject(ctx, input.projectId, input.owner);
      const row =
        input.handle !== undefined
          ? await ctx.db
              .query('forgeAccounts')
              .withIndex('by_handle', q => q.eq('handle', input.handle!))
              .unique()
          : await ctx.db
              .query('forgeAccounts')
              .withIndex('by_owner', q => q.eq('owner', input.contributor!))
              .unique();
      return row ? { owner: row.owner, handle: row.handle } : null;
    } catch (error) {
      return report(error);
    }
  },
});
export const pending = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.array(v.object({ id: v.id('projectInvites'), email: v.string() })),
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to manage access.');
      await ownedProject(ctx, projectId, user.subject);
      const rows = await ctx.db
        .query('projectInvites')
        .withIndex('by_project_and_email', q => q.eq('projectId', projectId))
        .take(1000);
      return rows.map(row => ({ id: row._id, email: row.email }));
    } catch (error) {
      return report(error);
    }
  },
});
async function invitationSeen(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; owner: string; operationId: string; person: string },
) {
  try {
    await activeOwnedProject(ctx, input.projectId, input.owner);
    const old = await ctx.db
      .query('projectAccessOperations')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', input.projectId).eq('operationId', input.operationId),
      )
      .unique();
    invariant(
      !old || (old.owner === input.owner && old.person === input.person),
      'WORK_OPERATION_CHANGED',
      'Retry the original invitation.',
    );
    return !!old;
  } catch (error) {
    return report(error);
  }
}
export const invitationOperation = internalQuery({
  args: { projectId: v.id('hostedProjects'), owner: v.string(), operationId: v.string(), person: v.string() },
  returns: v.boolean(),
  handler: invitationSeen,
});
export const invite = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    operationId: v.string(),
    person: v.string(),
    email: v.optional(v.string()),
    contributor: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const { projectId, owner, email, contributor, operationId, person } = input;
      await activeOwnedProject(ctx, projectId, owner);
      invariant(operationId.trim(), 'BAD_ARGUMENT', 'Retain the invitation operation id.');
      if (await invitationSeen(ctx, { projectId, owner, operationId, person })) return null;
      if (contributor && contributor !== owner) {
        const old = await ctx.db
          .query('projectContributors')
          .withIndex('by_project_and_contributor', q =>
            q.eq('projectId', projectId).eq('contributor', contributor),
          )
          .unique();
        if (!old) await ctx.db.insert('projectContributors', { projectId, contributor });
      } else if (email) {
        const old = await ctx.db
          .query('projectInvites')
          .withIndex('by_project_and_email', q => q.eq('projectId', projectId).eq('email', email))
          .unique();
        if (!old) await ctx.db.insert('projectInvites', { projectId, email });
      }
      await ctx.db.insert('projectAccessOperations', { projectId, owner, operationId, person });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const cancelInvite = mutation({
  args: { projectId: v.id('hostedProjects'), id: v.id('projectInvites') },
  returns: v.null(),
  handler: async (ctx, { projectId, id }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to manage access.');
      await ownedProject(ctx, projectId, user.subject);
      const row = await ctx.db.get(id);
      invariant(!row || row.projectId === projectId, 'PROJECT_UNAVAILABLE', 'Invitation unavailable.');
      if (row) await ctx.db.delete(id);
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
/** Redeem only the signed-in account’s verified email, never client-supplied identity. */
export async function redeemInvites(
  ctx: MutationCtx,
  user: { subject: string; email?: string; emailVerified?: boolean },
) {
  if (!user.email || !user.emailVerified) return;
  const email = user.email.trim().toLowerCase();
  const rows = await ctx.db
    .query('projectInvites')
    .withIndex('by_email', q => q.eq('email', email))
    .take(1000);
  for (const row of rows) {
    const project = await ctx.db.get(row.projectId);
    if (!project || project.removal) continue;
    const old = await ctx.db
      .query('projectContributors')
      .withIndex('by_project_and_contributor', q =>
        q.eq('projectId', row.projectId).eq('contributor', user.subject),
      )
      .unique();
    if (!old && project.owner !== user.subject)
      await ctx.db.insert('projectContributors', { projectId: row.projectId, contributor: user.subject });
    await ctx.db.delete(row._id);
  }
}
