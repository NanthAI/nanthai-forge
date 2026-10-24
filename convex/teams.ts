// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query, mutation, internalQuery, internalMutation } from './cliServer';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { report } from './errors';

const item = v.object({ id: v.id('teams'), name: v.string(), owner: v.string() });
export async function teamOwner(ctx: QueryCtx | MutationCtx, id: Id<'teams'>, owner: string | undefined) {
  const team = await ctx.db.get(id);
  invariant(
    owner && team?.owner === owner && !team.removal,
    'GITHUB_UNAVAILABLE',
    'This team is unavailable with the current access.',
  );
  return team;
}
export const create = mutation({
  args: { name: v.string(), operationId: v.string() },
  returns: v.id('teams'),
  handler: async (ctx, { name, operationId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'GITHUB_UNAVAILABLE', 'Sign in to create a team.');
      invariant(
        name.trim() && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId),
        'BAD_ARGUMENT',
        'Enter a team name and operation identity.',
      );
      const old = await ctx.db
        .query('teams')
        .withIndex('by_owner_and_operationId', q =>
          q.eq('owner', user.subject).eq('operationId', operationId),
        )
        .unique();
      if (old) {
        invariant(
          !old.removal,
          'GITHUB_UNAVAILABLE',
          'This original team was removed; its creation operation cannot recreate access.',
        );
        return old._id;
      }
      const id = await ctx.db.insert('teams', { name: name.trim(), owner: user.subject, operationId });
      await ctx.db.insert('teamMembers', { teamId: id, member: user.subject });
      return id;
    } catch (error) {
      return report(error);
    }
  },
});
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(item),
  handler: async (ctx, { paginationOpts }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return { page: [], isDone: true, continueCursor: '' };
    const result = await ctx.db
      .query('teamMembers')
      .withIndex('by_member_and_teamId', q => q.eq('member', user.subject))
      .paginate(paginationOpts);
    const page = [];
    for (const row of result.page) {
      const team = await ctx.db.get(row.teamId);
      if (team && !team.removal) page.push({ id: team._id, name: team.name, owner: team.owner });
    }
    return { ...result, page };
  },
});
export const members = query({
  args: { id: v.id('teams'), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ member: v.string() })),
  handler: async (ctx, { id, paginationOpts }) => {
    try {
      await teamOwner(ctx, id, (await ctx.auth.getUserIdentity())?.subject);
      const result = await ctx.db
        .query('teamMembers')
        .withIndex('by_teamId_and_member', q => q.eq('teamId', id))
        .paginate(paginationOpts);
      return { ...result, page: result.page.map(row => ({ member: row.member })) };
    } catch (error) {
      return report(error);
    }
  },
});
export const owned = internalQuery({
  args: { id: v.id('teams'), owner: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, owner }) => {
    await teamOwner(ctx, id, owner);
    return null;
  },
});
export const add = internalMutation({
  args: { id: v.id('teams'), owner: v.string(), member: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, owner, member }) => {
    await teamOwner(ctx, id, owner);
    const old = await ctx.db
      .query('teamMembers')
      .withIndex('by_teamId_and_member', q => q.eq('teamId', id).eq('member', member))
      .unique();
    if (!old) await ctx.db.insert('teamMembers', { teamId: id, member });
    return null;
  },
});
export const removeMember = mutation({
  args: { id: v.id('teams'), member: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, member }) => {
    try {
      const team = await teamOwner(ctx, id, (await ctx.auth.getUserIdentity())?.subject);
      invariant(member !== team.owner, 'BAD_ARGUMENT', 'The creator manages this team.');
      const row = await ctx.db
        .query('teamMembers')
        .withIndex('by_teamId_and_member', q => q.eq('teamId', id).eq('member', member))
        .unique();
      if (row) await ctx.db.delete(row._id);
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const link = mutation({
  args: { id: v.id('teams'), importId: v.id('imports'), shared: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { id, importId, shared }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      await teamOwner(ctx, id, user?.subject);
      const job = await ctx.db.get(importId);
      invariant(
        user && job?.owner === user.subject && job.visibility === 'private' && job.removal !== 'deleting',
        'GITHUB_UNAVAILABLE',
        'This Codescape is unavailable with the current access.',
      );
      const row = await ctx.db
        .query('teamImports')
        .withIndex('by_teamId_and_importId', q => q.eq('teamId', id).eq('importId', importId))
        .unique();
      if (shared && !row) await ctx.db.insert('teamImports', { teamId: id, importId });
      if (!shared && row) await ctx.db.delete(row._id);
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const links = query({
  args: { importId: v.id('imports'), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(item),
  handler: async (ctx, { importId, paginationOpts }) => {
    try {
      const user = await ctx.auth.getUserIdentity(),
        job = await ctx.db.get(importId);
      invariant(
        user && job?.owner === user.subject && job.visibility === 'private' && job.removal !== 'deleting',
        'GITHUB_UNAVAILABLE',
        'This Codescape is unavailable with the current access.',
      );
      const result = await ctx.db
        .query('teamImports')
        .withIndex('by_importId_and_teamId', q => q.eq('importId', importId))
        .paginate(paginationOpts);
      const page = [];
      for (const row of result.page) {
        const team = await ctx.db.get(row.teamId);
        if (team?.owner === user.subject && !team.removal)
          page.push({ id: team._id, name: team.name, owner: team.owner });
      }
      return { ...result, page };
    } catch (error) {
      return report(error);
    }
  },
});
export const candidates = internalQuery({
  args: { id: v.id('teams'), member: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.id('imports')),
  handler: async (ctx, { id, member, paginationOpts }) => {
    const team = await ctx.db.get(id),
      membership = await ctx.db
        .query('teamMembers')
        .withIndex('by_teamId_and_member', q => q.eq('teamId', id).eq('member', member))
        .unique();
    invariant(
      team && !team.removal && membership,
      'GITHUB_UNAVAILABLE',
      'This team is unavailable with the current access.',
    );
    const result = await ctx.db
      .query('teamImports')
      .withIndex('by_teamId_and_importId', q => q.eq('teamId', id))
      .paginate(paginationOpts);
    return { ...result, page: result.page.map(row => row.importId) };
  },
});
export const linked = internalQuery({
  args: { id: v.id('teams'), importId: v.id('imports'), member: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { id, importId, member }) => {
    const team = await ctx.db.get(id),
      job = await ctx.db.get(importId);
    return Boolean(
      team &&
      !team.removal &&
      job &&
      !job.removal &&
      job.visibility === 'private' &&
      job.owner === team.owner &&
      (await ctx.db
        .query('teamMembers')
        .withIndex('by_teamId_and_member', q => q.eq('teamId', id).eq('member', member))
        .unique()) &&
      (await ctx.db
        .query('teamImports')
        .withIndex('by_teamId_and_importId', q => q.eq('teamId', id).eq('importId', importId))
        .unique()),
    );
  },
});
