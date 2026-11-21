// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { invitationPerson, recipientEmail, invitationBlock } from './projectInvitationRecipient';
import {
  invitationLifetime,
  invitationPageCursor,
  invitationPageSize,
  invitationStatus,
} from './projectInvitationPolicy';
import { pendingTeamInvitation, teamInboxRow } from './teamInvitationReads';
import {
  invitationInviter,
  invitationWasRevoked,
  type InvitationRevocations,
} from './projectInvitationRevocation';

const projectInvitation = v.object({
  invitationId: v.id('projectInvites'),
  projectName: v.string(),
  inviterHandle: v.string(),
  role: v.union(v.literal('read'), v.literal('write')),
  expiresAt: v.number(),
  href: v.string(),
  state: v.union(v.literal('pending'), v.literal('expired')),
});
const teamInvitation = v.object({
  invitationId: v.id('projectInvites'),
  teamName: v.string(),
  inviterHandle: v.string(),
  href: v.string(),
  state: v.literal('pending'),
});
/** One indexed recipient page per selector. Sparse pages retain continuation; a link
 * carries no token or project identity and the session supplies both recipient selectors. */
export const inbox = query({
  args: {
    kind: v.union(v.literal('handle'), v.literal('email')),
    cursor: v.optional(v.union(v.string(), v.null())),
    includeTeams: v.optional(v.boolean()),
  },
  returns: v.object({
    rows: v.array(v.union(projectInvitation, teamInvitation)),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, input) => {
    const user = await invitationPerson(ctx),
      email = input.kind === 'email' ? await recipientEmail(ctx, user) : null;
    if (input.kind === 'email' && !email) return { rows: [], cursor: null };
    const selected =
      input.kind === 'email'
        ? ctx.db.query('projectInvites').withIndex('by_email', q => q.eq('email', email ?? ''))
        : ctx.db.query('projectInvites').withIndex('by_recipient', q => q.eq('recipient', user.subject));
    const page = await selected.order('desc').paginate({
      cursor: input.cursor ?? null,
      numItems: invitationPageSize,
      maximumRowsRead: invitationPageSize,
    });
    const rows = [];
    const revoked: InvitationRevocations = new Map();
    for (const row of page.page) {
      if (row.teamId) {
        if (input.includeTeams && email && pendingTeamInvitation(row)) {
          const teamRow = await teamInboxRow(ctx, row, user.subject);
          if (teamRow) rows.push(teamRow);
        }
        continue;
      }
      if (!row.projectId) continue;
      const state = invitationStatus(row);
      if (state !== 'pending') continue;
      const project = await ctx.db.get(row.projectId);
      if (!project || project.removal || (await invitationInviter(ctx, row)) !== project.owner) continue;
      if (await invitationWasRevoked(ctx, row, user.subject, revoked)) continue;
      if ((await invitationBlock(ctx, user.subject, project.owner))?.blocked) continue;
      const account = await ctx.db
        .query('forgeAccounts')
        .withIndex('by_owner', q => q.eq('owner', project.owner))
        .unique();
      rows.push({
        invitationId: row._id,
        projectName: project.name,
        inviterHandle: account?.handle ?? '',
        role: row.role ?? ('write' as const),
        expiresAt: row.expiresAt ?? row._creationTime + invitationLifetime,
        state,
        href:
          account?.handle && project.slug
            ? `/-/${encodeURIComponent(account.handle)}/${encodeURIComponent(project.slug)}`
            : '/-/account',
      });
    }
    return { rows, cursor: invitationPageCursor(page) };
  },
});
export const blocked = query({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({
    rows: v.array(v.object({ id: v.id('invitationBlocks'), inviterHandle: v.string(), version: v.number() })),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { cursor }) => {
    const user = await invitationPerson(ctx);
    const page = await ctx.db
      .query('invitationBlocks')
      .withIndex('by_recipient_and_inviter', q => q.eq('recipient', user.subject))
      .paginate({ cursor: cursor ?? null, numItems: 25 });
    const rows = [];
    for (const block of page.page) {
      if (!block.blocked) continue;
      const account = await ctx.db
        .query('forgeAccounts')
        .withIndex('by_owner', q => q.eq('owner', block.inviter))
        .unique();
      rows.push({ id: block._id, inviterHandle: account?.handle ?? '', version: block.version ?? 0 });
    }
    return { rows, cursor: page.isDone ? null : page.continueCursor };
  },
});
