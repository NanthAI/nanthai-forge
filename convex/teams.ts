// SPDX-License-Identifier: Apache-2.0
import { findVerifiedRecipient, currentEmailRecipient } from './authUsers';
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query, internalQuery, internalMutation, accountMutation } from './cliServer';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { isDeviceIdentity } from './cliServer';
import { invariant } from '../src/errors';
import { report } from './errors';
import { memberHandle } from './teamHandles';
import {
  addTeamMembership,
  endTeamInvitations,
  recordDirectTeamEmail,
  teamEmailOperationKey,
  teamEmailReplay,
  teamInvitationOperation,
} from './teamInvitationMembership';
import { teamEmailInvitationsEnabled } from './projectInvitationPolicy';

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
/** A team name's longest length, as GitHub allows for names (review s1-astra62 r4 #6: a name the size of the document
 * limit left no room for its deletion's bookkeeping). */
const TEAM_NAME_MAX = 100;
export const create = accountMutation('write')({
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
      // After the replay: a creation that succeeded before the cap answers as it did (review c4ece6f2).
      invariant(
        name.length <= TEAM_NAME_MAX,
        'BAD_ARGUMENT',
        `Use a team name of at most ${TEAM_NAME_MAX} characters.`,
      );
      const id = await ctx.db.insert('teams', { name: name.trim(), owner: user.subject, operationId });
      await ctx.db.insert('teamMembers', {
        teamId: id,
        member: user.subject,
        handle: await memberHandle(ctx, user.subject),
      });
      return id;
    } catch (error) {
      return report(error);
    }
  },
});
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({
      ...item.fields,
      emailInvitations: v.optional(v.literal(true)),
      canReadInvitations: v.optional(v.literal(true)),
    }),
  ),
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
      if (team && !team.removal)
        page.push({
          id: team._id,
          name: team.name,
          owner: team.owner,
          ...(team.owner === user.subject && teamEmailInvitationsEnabled()
            ? { emailInvitations: true as const }
            : {}),
          ...(team.owner === user.subject && team.invitationEpoch !== undefined
            ? { canReadInvitations: true as const }
            : {}),
        });
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
  args: {
    id: v.id('teams'),
    owner: v.string(),
    email: v.optional(v.string()),
    operationId: v.optional(v.string()),
    pending: v.optional(v.literal(true)),
  },
  returns: v.union(
    v.null(),
    v.object({ recipient: v.union(v.string(), v.null()) }),
    v.literal('direct'),
    v.literal('pending'),
    v.literal('unavailable'),
  ),
  handler: async (ctx, { id, owner, email, operationId, pending }) => {
    const team = await teamOwner(ctx, id, owner);
    if (email === undefined) return null;
    if (operationId !== undefined || team.invitationEpoch !== undefined) {
      const replay = await teamInvitationOperation(ctx, id, teamEmailOperationKey(email, operationId));
      if (replay) return teamEmailReplay(replay, email);
    }
    if (pending) return 'unavailable' as const;
    return { recipient: await findVerifiedRecipient(ctx, email) };
  },
});
export const add = internalMutation({
  args: {
    id: v.id('teams'),
    owner: v.string(),
    member: v.string(),
    email: v.optional(v.string()),
    legacyEmail: v.optional(v.string()),
    operationId: v.optional(v.string()),
  },
  returns: v.union(v.null(), v.literal('pending')),
  handler: async (ctx, { id, owner, member, email, legacyEmail, operationId }) => {
    invariant(
      !isDeviceIdentity((await ctx.auth.getUserIdentity()) ?? {}),
      'AUTH_SCOPE_DENIED',
      'Add team members in your Forge browser.',
    );
    const team = await teamOwner(ctx, id, owner);
    const address = email ?? legacyEmail;
    if (address && (operationId !== undefined || team.invitationEpoch !== undefined)) {
      const replay = await teamInvitationOperation(ctx, id, teamEmailOperationKey(address, operationId));
      if (replay) return teamEmailReplay(replay, address) === 'pending' ? 'pending' : null;
    }
    invariant(
      !address || !teamEmailInvitationsEnabled(),
      'WORK_OPERATION_CHANGED',
      'Team email invitations are now available. Retry your request.',
    );
    invariant(
      !email || (await currentEmailRecipient(ctx, email, member, true)),
      'BAD_ARGUMENT',
      'No Forge account currently matches that verified address.',
    );
    if (legacyEmail) await currentEmailRecipient(ctx, legacyEmail, member, false);
    await addTeamMembership(ctx, id, member);
    if (address && operationId !== undefined) await recordDirectTeamEmail(ctx, id, address, operationId);
    return null;
  },
});
export const removeMember = accountMutation('write')({
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
      if (row) {
        await endTeamInvitations(ctx, team, member);
        await ctx.db.delete(row._id);
      }
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const link = accountMutation('write')({
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
