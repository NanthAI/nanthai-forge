// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** The native (Convex Auth) sign-in of a closing account (convex/accountClose.ts). Sessions end at the `signout` step;
 * passkeys, the username and the account key go in the close's final transaction, so a close that stops keeps them.
 * A person has a handful of sessions and passkeys (each made by a sign-in or a ceremony), so each call is small. */
import type { MutationCtx } from './server';
import type { QueryCtx } from './cliServer';
import type { Doc, Id } from './_generated/dataModel';
import { authComponents as components } from './authComponents';

export const nativeUser = (ctx: QueryCtx | MutationCtx, actor: string) =>
  ctx.db
    .query('users')
    .withIndex('by_accountKey', q => q.eq('accountKey', actor))
    .unique();

export async function passkeyCount(ctx: QueryCtx, userId: Id<'users'>) {
  return (await ctx.runQuery(components.authPasskey.registration.listPasskeys, { userId })).length;
}

/** Ends every browser session of the account's native user. */
export async function endSessions(ctx: MutationCtx, actor: string) {
  const user = await nativeUser(ctx, actor);
  if (!user) return;
  const sessions = await ctx.runQuery(components.auth.public.listSessions, { userId: user._id });
  if (sessions.length)
    await ctx.runMutation(components.auth.public.revokeSessions, {
      sessionIds: sessions.map(s => s.sessionId),
    });
}

/** Passkeys and the username go. A GitHub user keeps its numeric id and any conflict mark under a fresh account key:
 * the GitHub component keeps its own link to this row, so the next GitHub sign-in starts a new, empty account and never
 * acts as the closed key. A passkey-only user has no way back in, so its row goes. */
export async function removeNativeSignIn(ctx: MutationCtx, user: Doc<'users'>) {
  await ctx.runMutation(components.authPasskey.registration.deleteUser, { userId: user._id });
  await ctx.runMutation(components.authUsername.public.deleteUsername, { userId: user._id });
  if (!user.githubId) return ctx.db.delete(user._id);
  await ctx.db.replace(user._id, {
    accountKey: `user_${crypto.randomUUID().replace(/-/g, '')}`,
    githubId: user.githubId,
    ...(user.githubConflict ? { githubConflict: true } : {}),
    emailVerified: false,
    ...(user.legalAcceptance ? { legalAcceptance: user.legalAcceptance } : {}),
  });
}
