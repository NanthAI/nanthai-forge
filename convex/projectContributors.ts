// SPDX-License-Identifier: Apache-2.0
import { createInvitation } from './projectInvitationCreate';
import { invitationStatus } from './projectInvitationPolicy';
import { retainMembership } from './projectActorNames';
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query, mutation, internalMutation, type QueryCtx, type MutationCtx } from './cliServer';
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
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    contributor: v.string(),
    email: v.optional(v.string()),
    legacyEmail: v.optional(v.string()),
  },
  returns: v.null(),
  handler: addContributor,
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
      return rows
        .filter(row => invitationStatus(row) === 'pending')
        .map(row => ({ id: row._id, email: row.email }));
    } catch (error) {
      return report(error);
    }
  },
});
export const invite = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    operationId: v.string(),
    person: v.string(),
    email: v.optional(v.string()),
    contributor: v.optional(v.string()),
    role: v.optional(v.union(v.literal('read'), v.literal('write'))),
  },
  returns: v.null(),
  handler: inviteContributor,
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
      if (row && invitationStatus(row) === 'pending')
        await ctx.db.patch(id, { state: 'cancelled', endedAt: Date.now() });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export async function addContributor(
  ctx: MutationCtx,
  {
    projectId,
    owner,
    contributor,
    email,
    legacyEmail,
  }: {
    projectId: Id<'hostedProjects'>;
    owner: string;
    contributor: string;
    email?: string;
    legacyEmail?: string;
  },
): Promise<null> {
  try {
    await activeOwnedProject(ctx, projectId, owner);
    const address = email ?? legacyEmail;
    if (address)
      return await createInvitation(ctx, {
        projectId,
        owner,
        operationId: `add-email:${address.trim().toLowerCase()}`,
        person: address,
      });
    if (contributor === owner) return null;
    const account = await ctx.db
      .query('forgeAccounts')
      .withIndex('by_owner', q => q.eq('owner', contributor))
      .unique();
    invariant(account, 'BAD_ARGUMENT', 'Invite this person by their Forge handle.');
    return await createInvitation(ctx, {
      projectId,
      owner,
      operationId: `add:${contributor}`,
      person: `@${account.handle}`,
      contributor,
    });
  } catch (error) {
    return report(error);
  }
}

export async function inviteContributor(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    owner: string;
    operationId: string;
    person: string;
    email?: string;
    contributor?: string;
    role?: 'read' | 'write';
  },
): Promise<null> {
  try {
    return await createInvitation(ctx, input);
  } catch (error) {
    return report(error);
  }
}
