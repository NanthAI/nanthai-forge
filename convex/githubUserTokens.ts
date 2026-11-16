// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './server';
import { invariant } from '../src/errors';
const sealed = v.object({ keyId: v.string(), nonce: v.string(), tag: v.string(), ciphertext: v.string() });
export const read = internalQuery({
  args: { owner: v.string() },
  returns: v.union(v.object({ token: v.union(sealed, v.null()), legacy: v.optional(v.boolean()) }), v.null()),
  handler: async (ctx, { owner }) => {
    const user = await ctx.db
      .query('users')
      .withIndex('by_accountKey', q => q.eq('accountKey', owner))
      .unique();
    return user
      ? { token: user.githubToken ?? null, ...(user.legacyGithubProvider ? { legacy: true } : {}) }
      : null;
  },
});
export const store = internalMutation({
  args: { state: v.string(), owner: v.string(), token: sealed },
  returns: v.null(),
  handler: async (ctx, { state, owner, token }) => {
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
    await ctx.db.patch(user._id, { githubToken: token });
    return null;
  },
});
