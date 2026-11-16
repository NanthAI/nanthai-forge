// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { vGithubProfile } from '@convex-dev/auth/methods/github/server';
import { internalMutation, internalQuery, type MutationCtx } from './server';
import { invariant } from '../src/errors';
import { ensureAccount } from './urlIdentity';

const githubMethod = v.object({ name: v.literal('github'), profile: vGithubProfile });
const passkeyMethod = v.object({ name: v.literal('usernamePasskey'), profile: v.object({}) });
async function insertUser(
  ctx: MutationCtx,
  fields: { githubId?: string; githubLogin?: string; email?: string; emailVerified: boolean },
) {
  const id = await ctx.db.insert('users', { accountKey: 'pending', ...fields });
  await ctx.db.patch(id, { accountKey: `user_${id}` });
  await ensureAccount(ctx, `user_${id}`, { githubLogin: fields.githubLogin });
  return id;
}
export const createGithub = internalMutation({
  args: { method: githubMethod },
  returns: v.id('users'),
  handler: async (ctx, { method: { profile } }) => {
    invariant(
      /^[1-9][0-9]{0,19}$/.test(profile.id),
      'GITHUB_RESPONSE',
      'GitHub returned an invalid account id.',
    );
    const existing = await ctx.db
      .query('users')
      .withIndex('by_githubId', q => q.eq('githubId', profile.id))
      .unique();
    if (existing) return existing._id;
    return insertUser(ctx, {
      githubId: profile.id,
      githubLogin: profile.login,
      ...(profile.emailVerified && profile.email ? { email: profile.email } : {}),
      emailVerified: profile.emailVerified && Boolean(profile.email),
    });
  },
});
export const signedInGithub = internalMutation({
  args: { method: githubMethod, userId: v.id('users') },
  returns: v.null(),
  handler: async (ctx, { method: { profile }, userId }) => {
    const user = await ctx.db.get(userId);
    invariant(
      user?.githubId === profile.id,
      'GITHUB_ACCOUNT_MISMATCH',
      'GitHub account does not match this user.',
    );
    await ctx.db.patch(userId, {
      githubLogin: profile.login,
      ...(profile.emailVerified && profile.email ? { email: profile.email, emailVerified: true } : {}),
    });
    return null;
  },
});
export const createPasskey = internalMutation({
  args: { method: passkeyMethod },
  returns: v.id('users'),
  handler: async ctx => insertUser(ctx, { emailVerified: false }),
});
/** Used only on authenticated server paths, including the GitHub App connection. */
export const githubAccounts = internalQuery({
  args: { accountKey: v.string() },
  returns: v.union(v.array(v.string()), v.null()),
  handler: async (ctx, { accountKey }) => {
    const user = await ctx.db
      .query('users')
      .withIndex('by_accountKey', q => q.eq('accountKey', accountKey))
      .unique();
    return user ? (user.githubId ? [user.githubId] : []) : null;
  },
});
