// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Item a841a76d: each `teamMembers` row carries its member's handle, so the account's team page reads handles with
 * the rows it already reads (convex/accountTeams.ts) instead of one account lookup per person.
 *
 * Kept current where handles are written: a membership takes the handle when it is inserted (teams.create, teams.add);
 * a handle change (urlAccounts.setHandle, the passkey sign-up) and a new account (urlIdentity.ensureAccount) patch the
 * person's memberships, SYNC_PAGE rows inline (one range), the rest in scheduled runs of the same size. A person in no
 * team pays one empty range read. Rows written before this change take their handle from the one-time `backfill`
 * (BACKFILL_PAGE rows and as many account reads per run; a rerun writes nothing). Delete `backfill` once production
 * has run it (follow-up Issue 506ba762). */
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { internalMutation, type MutationCtx } from './server';

const SYNC_PAGE = 100;
const BACKFILL_PAGE = 100;

/** The member's current handle; null when the account has none (or does not exist yet). */
export async function memberHandle(ctx: MutationCtx, member: string) {
  const account = await ctx.db
    .query('forgeAccounts')
    .withIndex('by_owner', q => q.eq('owner', member))
    .unique();
  return account?.handle ?? null;
}

async function syncSome(ctx: MutationCtx, member: string, handle: string | null, after?: Id<'teams'>) {
  const rows = await ctx.db
    .query('teamMembers')
    .withIndex('by_member_and_teamId', q =>
      after === undefined ? q.eq('member', member) : q.eq('member', member).gt('teamId', after),
    )
    .take(SYNC_PAGE + 1);
  for (const row of rows.slice(0, SYNC_PAGE))
    if (row.handle !== handle) await ctx.db.patch(row._id, { handle });
  if (rows.length > SYNC_PAGE)
    await ctx.scheduler.runAfter(0, internal.teamHandles.sync, {
      member,
      handle,
      after: rows[SYNC_PAGE - 1]!.teamId,
    });
}

/** After a handle is written: the person's memberships take it. */
export async function syncTeamHandles(ctx: MutationCtx, member: string, handle: string | null) {
  await syncSome(ctx, member, handle);
}

export const sync = internalMutation({
  args: { member: v.string(), handle: v.union(v.string(), v.null()), after: v.id('teams') },
  returns: v.null(),
  handler: async (ctx, { member, after }) => {
    // Re-read: a later change may have landed since this run was scheduled.
    await syncSome(ctx, member, await memberHandle(ctx, member), after);
    return null;
  },
});

/** One-time: memberships written before handles were kept on the row. */
export const backfill = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ rows: v.number(), patched: v.number(), isDone: v.boolean() }),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('teamMembers')
      .paginate({ cursor: cursor ?? null, numItems: BACKFILL_PAGE });
    let patched = 0;
    for (const row of page.page) {
      const handle = await memberHandle(ctx, row.member);
      if (row.handle !== handle) {
        await ctx.db.patch(row._id, { handle });
        patched++;
      }
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.teamHandles.backfill, { cursor: page.continueCursor });
    return { rows: page.page.length, patched, isDone: page.isDone };
  },
});
