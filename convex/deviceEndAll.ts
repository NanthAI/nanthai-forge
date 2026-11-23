// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, type MutationCtx, type QueryCtx } from './server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';

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
 */
export async function endAccountDevices(
  ctx: MutationCtx,
  owner: string,
  /** The caller's account row when it has one; a time (callers from before epochs) is ignored. */
  account?: Doc<'users'> | null | number,
) {
  const row = account === undefined || typeof account === 'number' ? await accountRow(ctx, owner) : account;
  const epoch = row ? signInEpoch(row) + 1 : NO_ACCOUNT;
  if (row) await ctx.db.patch(row._id, { deviceSignOutEpoch: epoch });
  await endPage(ctx, owner, epoch, null);
}
/** `before`: a page scheduled before epochs (deploy of 90b02b72) ends what was issued by then; remove once none can be queued. */
async function endPage(
  ctx: MutationCtx,
  owner: string,
  epoch: number | undefined,
  cursor: string | null,
  before?: number,
) {
  const page = await ctx.db
    .query('cliCredentials')
    .withIndex('by_owner', q => q.eq('owner', owner))
    .paginate({ cursor, numItems: 100, maximumRowsRead: 100, maximumBytesRead: 64 * 1024 });
  for (const row of page.page)
    if (!row.revoked && (epoch === undefined ? row.issuedAt <= before! : (row.signOutEpoch ?? 0) < epoch))
      await ctx.db.patch(row._id, { revoked: true });
  if (!page.isDone)
    await ctx.scheduler.runAfter(0, internal.deviceEndAll.next, {
      owner,
      ...(epoch === undefined ? { before: before! } : { epoch }),
      cursor: page.continueCursor,
    });
}
export const next = internalMutation({
  args: {
    owner: v.string(),
    epoch: v.optional(v.number()),
    before: v.optional(v.number()),
    cursor: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    await endPage(ctx, input.owner, input.epoch, input.cursor, input.before);
    return null;
  },
});
