// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './server';
import { invariant } from '../src/errors';
const sealed = v.object({ keyId: v.string(), nonce: v.string(), tag: v.string(), ciphertext: v.string() });
const renewal = v.object({ refreshToken: sealed, expiresAt: v.number() });
const sameSealed = (
  a: { ciphertext: string; nonce: string } | undefined,
  b: { ciphertext: string; nonce: string },
) => a?.ciphertext === b.ciphertext && a.nonce === b.nonce;
export const read = internalQuery({
  args: { owner: v.string() },
  returns: v.union(v.object({ token: v.union(sealed, v.null()), renewal: v.optional(renewal) }), v.null()),
  handler: async (ctx, { owner }) => {
    const user = await ctx.db
      .query('users')
      .withIndex('by_accountKey', q => q.eq('accountKey', owner))
      .unique();
    if (!user) return null;
    return {
      token: user.githubToken ?? null,
      ...(user.githubTokenRenewal ? { renewal: user.githubTokenRenewal } : {}),
    };
  },
});
export const store = internalMutation({
  args: { state: v.string(), owner: v.string(), token: sealed, renewal: v.optional(renewal) },
  returns: v.null(),
  handler: async (ctx, { state, owner, token, renewal }) => {
    const op = await ctx.db
      .query('githubBindingOperations')
      .withIndex('by_state', q => q.eq('state', state))
      .unique();
    invariant(
      op?.status === 'processing' && op.actor === owner,
      'GITHUB_OAUTH_STATE',
      'GitHub authorization changed.',
    );
    const user = await ctx.db
      .query('users')
      .withIndex('by_accountKey', q => q.eq('accountKey', owner))
      .unique();
    invariant(
      user?.githubId && op.githubAccounts?.includes(user.githubId),
      'GITHUB_ACCOUNT_MISMATCH',
      'GitHub account does not match this user.',
    );
    await ctx.db.patch(user._id, { githubToken: token, githubTokenRenewal: renewal });
    return null;
  },
});
/** Replaces a renewed token only if the stored one is still the token that was renewed, so a
 * concurrent renewal or a new connection is never overwritten. Returns whether it was replaced. */
export const renew = internalMutation({
  args: { owner: v.string(), previous: sealed, token: sealed, renewal: v.optional(renewal) },
  returns: v.boolean(),
  handler: async (ctx, { owner, previous, token, renewal }) => {
    const user = await ctx.db
      .query('users')
      .withIndex('by_accountKey', q => q.eq('accountKey', owner))
      .unique();
    if (!user || !sameSealed(user.githubToken, previous)) return false;
    await ctx.db.patch(user._id, { githubToken: token, githubTokenRenewal: renewal });
    return true;
  },
});
