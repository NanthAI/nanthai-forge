// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalMutation, type MutationCtx, type QueryCtx } from './server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { scheduleAccountMarks, SWEEP_KEEP_MS } from './sealedSecretMarkers';

/** An account with no users row cannot approve a device sign-in (deviceStore.approve needs the row), so its sweep
 * ends every device it has. */
const NO_ACCOUNT = Number.MAX_SAFE_INTEGER;

async function accountRow(ctx: QueryCtx, owner: string) {
  return await ctx.db
    .query('users')
    .withIndex('by_accountKey', q => q.eq('accountKey', owner))
    .unique();
}

/** The sign-out epoch a device sign-in issued now records (`signOutEpoch`); read in the issuing transaction. */
export function signInEpoch(account: Doc<'users'> | null) {
  return account?.deviceSignOutEpoch ?? 0;
}
export async function accountSignInEpoch(ctx: QueryCtx, owner: string) {
  return signInEpoch(await accountRow(ctx, owner));
}

/**
 * "Sign out everywhere" for CLI devices: one explicit account operation, bounded pages. The start's one small write
 * moves the account to its next sign-out epoch; a sign-in records the epoch its own transaction read. Pages end every
 * device recorded below that epoch, however it is used meanwhile (renewal keeps the recorded epoch), and keep every
 * sign-in issued after the start: transactions are serialized, so there is no clock tie.
 *
 * `markSealed` (the person's "Sign out everywhere", Gate B2 M3 follow-up): every swept sign-in linked to a sealed
 * device marks that device in its linked projects, signed out earlier or not, so a lost laptop is removed and
 * re-keyed on the next owner write. A page's links, each (project, device) pair once, mark in scheduled steps
 * (sealedSecretMarkers.scheduleAccountMarks; own-account entries only, owner devices included, see
 * markersForEndedDevice), at most one step per row.
 * The person issues it from a browser session (authLinkAccount), which holds no sealed device, so no device of the
 * account is spared as the issuer. `issuer` names that session, the only one the action keeps: a device approved
 * there clears its own mark where the sweep left no owner device unmarked (sole-owner follow-up). An operator suspension leaves it off: a reversible switch removes no device.
 */
export async function endAccountDevices(
  ctx: MutationCtx,
  owner: string,
  /** The caller's account row when it has one; read here otherwise. */
  account?: Doc<'users'> | null,
  {
    markSealed = false,
    issuer,
  }: {
    markSealed?: boolean;
    /** With `markSealed`: the browser session that issued it and stays signed in (sealedSweep). */
    issuer?: string;
  } = {},
) {
  const row = account === undefined ? await accountRow(ctx, owner) : account;
  const epoch = row ? signInEpoch(row) + 1 : NO_ACCOUNT;
  if (row)
    await ctx.db.patch(row._id, {
      deviceSignOutEpoch: epoch,
      ...(markSealed && issuer
        ? { sealedSweep: { sessionId: issuer, epoch, until: Date.now() + SWEEP_KEEP_MS } }
        : {}),
    });
  await endPage(ctx, owner, epoch, null, markSealed);
}
async function endPage(
  ctx: MutationCtx,
  owner: string,
  epoch: number,
  cursor: string | null,
  markSealed: boolean,
) {
  const page = await ctx.db
    .query('cliCredentials')
    .withIndex('by_owner', q => q.eq('owner', owner))
    .paginate({ cursor, numItems: 100, maximumRowsRead: 100, maximumBytesRead: 64 * 1024 });
  const links: NonNullable<Doc<'cliCredentials'>['sealed']> = [];
  for (const row of page.page) {
    if ((row.signOutEpoch ?? 0) >= epoch) continue;
    if (!row.revoked) await ctx.db.patch(row._id, { revoked: true });
    if (markSealed) links.push(...(row.sealed ?? []));
  }
  if (links.length) await scheduleAccountMarks(ctx, owner, links, epoch);
  if (!page.isDone)
    await ctx.scheduler.runAfter(0, internal.deviceEndAll.next, {
      owner,
      epoch,
      cursor: page.continueCursor,
      ...(markSealed ? { markSealed: true as const } : {}),
    });
}
export const next = internalMutation({
  args: {
    owner: v.string(),
    epoch: v.number(),
    cursor: v.string(),
    markSealed: v.optional(v.literal(true)),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    await endPage(ctx, input.owner, input.epoch, input.cursor, input.markSealed === true);
    return null;
  },
});
