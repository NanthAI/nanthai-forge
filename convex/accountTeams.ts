// SPDX-License-Identifier: Apache-2.0
/** Account > People and teams (Item a841a76d): the teams the person owns or is in, each with its owner and members by
 * handle, read page by page. Person-only: any device, agent or legacy CLI credential is refused before a membership is
 * read (the page is for the person in their browser; teams are managed on the owner paths in teams.ts/teamActions.ts).
 *
 * Who sees what: every member sees the team's name, its owner and the first members by handle (handles are public
 * identities); only the owner also gets each member's account key, which the existing remove path takes.
 *
 * Reads, page-level: handles live on the membership rows (convex/teamHandles.ts), so no account is looked up per
 * person. One call reads one range of at most TEAMS_PAGE_MAX of the viewer's memberships, then per team on the page one
 * get of the team, one range of MEMBERS_SHOWN + 1 member rows, and (when the viewer is not the owner) one point range
 * for the owner's row: at most 1 + 20 x 3 = 61 operations in the query body (51 measured: 20 gets, 31 ranges, half
 * the teams not the viewer's) and 20 x (1 + 13 + 1) + 20 = 320 documents at most (310 in that fixture). Browser sign-in adds its usual overhead on
 * top (convex/forgeIdentity.ts: one session-component query and one users get), not counted above. Bytes, metered in
 * tests/account-teams.test.mjs on the documents the read actually returns (UTF-8 JSON) for a full page of 40-member
 * teams with realistic ids (32-character ids, 37-character account keys, 39-character handles): 67.1 KB read and
 * 27.6 KB returned in that fixture, held under caps of 70 KB and 32 KB. A typical person (1-3 small teams) reads under
 * 5 KB. No writes, no subscription on the page (one-off read per visit), so idle costs nothing and no landing pays
 * for it. */
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import type { Doc } from './_generated/dataModel';
import { isDeviceIdentity, query } from './cliServer';
import type { QueryCtx } from './_generated/server';
import { invariant } from '../src/errors';
import { report } from './errors';

export const TEAMS_PAGE_MAX = 20;
export const MEMBERS_SHOWN = 12;

const member = v.object({
  handle: v.union(v.string(), v.null()),
  you: v.boolean(),
  owner: v.boolean(),
  /** The member's account key, for the owner's remove action only. */
  key: v.optional(v.string()),
});
const accountTeam = v.object({
  id: v.id('teams'),
  name: v.string(),
  role: v.union(v.literal('owner'), v.literal('member')),
  ownerHandle: v.union(v.string(), v.null()),
  members: v.array(member),
  /** More members than shown. */
  more: v.boolean(),
});

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(accountTeam),
  handler: async (ctx, { paginationOpts }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      if (!user) return { page: [], isDone: true, continueCursor: '' };
      invariant(
        !isDeviceIdentity(user) && !(ctx as { forgeDevice?: unknown }).forgeDevice,
        'AUTH_SCOPE_DENIED',
        'Open your teams in your Forge browser: Account → People and teams.',
      );
      const numItems = Math.max(1, Math.min(TEAMS_PAGE_MAX, Math.floor(paginationOpts.numItems)));
      const result = await ctx.db
        .query('teamMembers')
        .withIndex('by_member_and_teamId', q => q.eq('member', user.subject))
        .paginate({ ...paginationOpts, numItems });
      const page = await Promise.all(
        result.page.map(async row => {
          const team = await ctx.db.get(row.teamId);
          return team && !team.removal ? teamRow(ctx, team, row, user.subject) : null;
        }),
      );
      return { ...result, page: page.filter(row => row !== null) };
    } catch (error) {
      return report(error);
    }
  },
});

async function teamRow(ctx: QueryCtx, team: Doc<'teams'>, mine: Doc<'teamMembers'>, viewer: string) {
  const owns = team.owner === viewer;
  const [rows, ownerRow] = await Promise.all([
    ctx.db
      .query('teamMembers')
      .withIndex('by_teamId_and_member', q => q.eq('teamId', team._id))
      .take(MEMBERS_SHOWN + 1),
    owns
      ? mine
      : ctx.db
          .query('teamMembers')
          .withIndex('by_teamId_and_member', q => q.eq('teamId', team._id).eq('member', team.owner))
          .unique(),
  ]);
  return {
    id: team._id,
    name: team.name,
    role: owns ? ('owner' as const) : ('member' as const),
    ownerHandle: ownerRow?.handle ?? null,
    members: rows.slice(0, MEMBERS_SHOWN).map(row => ({
      handle: row.handle ?? null,
      you: row.member === viewer,
      owner: row.member === team.owner,
      ...(owns ? { key: row.member } : {}),
    })),
    more: rows.length > MEMBERS_SHOWN,
  };
}
