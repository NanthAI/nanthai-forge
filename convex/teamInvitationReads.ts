// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { query, type QueryCtx } from './cliServer';
import { requireOwnerPerson } from './ownerPerson';
import { invitationBlock } from './projectInvitationRecipient';
import { teamOwner } from './teams';
import { report } from './errors';
import { teamInvitationWasRevoked } from './teamInvitationMembership';
import { invitationPageCursor, invitationPageSize } from './projectInvitationPolicy';

type TeamInvitation = Doc<'projectInvites'> & { teamId: Id<'teams'>; state: 'pending' };

export function pendingTeamInvitation(row: Doc<'projectInvites'>): row is TeamInvitation {
  return Boolean(row.teamId && !row.projectId && row.state === 'pending');
}

export async function teamInboxRow(ctx: QueryCtx, row: TeamInvitation, recipient: string) {
  const team = await ctx.db.get(row.teamId);
  if (!team || team.removal || team.owner !== row.inviter) return null;
  if (await teamInvitationWasRevoked(ctx, row, recipient)) return null;
  if ((await invitationBlock(ctx, recipient, team.owner))?.blocked) return null;
  const account = await ctx.db
    .query('forgeAccounts')
    .withIndex('by_owner', q => q.eq('owner', team.owner))
    .unique();
  return {
    invitationId: row._id,
    teamName: team.name,
    inviterHandle: account?.handle ?? '',
    href: '/account/people',
    state: row.state,
  };
}

export const pending = query({
  args: { teamId: v.id('teams'), cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({
    rows: v.array(v.object({ id: v.id('projectInvites'), target: v.string(), state: v.literal('pending') })),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { teamId, cursor }) => {
    try {
      const user = await requireOwnerPerson(ctx, 'read pending team invitations');
      await teamOwner(ctx, teamId, user.subject);
      const page = await ctx.db
        .query('projectInvites')
        .withIndex('by_teamId_and_state', q => q.eq('teamId', teamId).eq('state', 'pending'))
        .order('desc')
        .paginate({
          cursor: cursor ?? null,
          numItems: invitationPageSize,
          maximumRowsRead: invitationPageSize,
        });
      const rows = page.page.flatMap(row =>
        pendingTeamInvitation(row) && row.inviter === user.subject
          ? [{ id: row._id, target: row.target ?? row.email, state: row.state }]
          : [],
      );
      return { rows, cursor: invitationPageCursor(page) };
    } catch (error) {
      return report(error);
    }
  },
});
