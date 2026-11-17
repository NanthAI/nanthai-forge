// SPDX-License-Identifier: Apache-2.0
import { ConvexError, v } from 'convex/values';
import { vGithubProfile } from '@convex-dev/auth/methods/github/server';
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './server';
import { invariant } from '../src/errors';
import { LEGAL_VERSION } from '../src/legal-version';
import { ensureAccount } from './urlIdentity';

const githubMethod = v.object({ name: v.literal('github'), profile: vGithubProfile });
const passkeyMethod = v.object({ name: v.literal('usernamePasskey'), profile: v.object({}) });
async function insertUser(
  ctx: MutationCtx,
  fields: { githubId?: string; githubLogin?: string; email?: string; emailVerified: boolean },
) {
  const id = await ctx.db.insert('users', {
    accountKey: 'pending',
    ...fields,
    legalAcceptance: { version: LEGAL_VERSION, at: Date.now() },
  });
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
    const matches = await ctx.db
      .query('users')
      .withIndex('by_githubId', q => q.eq('githubId', profile.id))
      .take(2);
    if (matches.length > 1 || matches[0]?.githubConflict)
      throw new ConvexError({
        code: 'GITHUB_ACCOUNT_MISMATCH',
        message: 'GitHub identity matches multiple Forge accounts.',
      });
    const existing = matches[0];
    if (existing) return existing._id;
    return insertUser(ctx, {
      githubId: profile.id,
      githubLogin: profile.login,
      ...(profile.emailVerified && profile.email ? { email: profile.email.trim().toLowerCase() } : {}),
      emailVerified: profile.emailVerified && Boolean(profile.email),
    });
  },
});
export const signedInGithub = internalMutation({
  args: { method: githubMethod, userId: v.id('users') },
  returns: v.null(),
  handler: async (ctx, { method: { profile }, userId }) => {
    const user = await ctx.db.get(userId);
    const matches = await ctx.db
      .query('users')
      .withIndex('by_githubId', q => q.eq('githubId', profile.id))
      .take(2);
    if (
      !(
        user?.githubId === profile.id &&
        !user.githubConflict &&
        matches.length === 1 &&
        matches[0]!._id === userId
      )
    )
      throw new ConvexError({
        code: 'GITHUB_ACCOUNT_MISMATCH',
        message: 'GitHub account does not match this user.',
      });
    await ctx.db.patch(userId, {
      githubLogin: profile.login,
      email: profile.emailVerified && profile.email ? profile.email.trim().toLowerCase() : undefined,
      emailVerified: Boolean(profile.emailVerified && profile.email),
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
    return user ? (user.githubId ? [user.githubId] : user.legacyGithubProvider ? null : []) : null;
  },
});

/** Shared by account lookup and redemption; no provider fallback. */
export async function findVerifiedRecipient(ctx: QueryCtx | MutationCtx, email: string) {
  email = email.trim().toLowerCase();
  const rows = await ctx.db
    .query('users')
    .withIndex('by_email', q => q.eq('email', email))
    .take(2);
  invariant(rows.length <= 1, 'BAD_ARGUMENT', 'No unique account matches that address.');
  return rows[0]?.emailVerified && rows[0].email === email ? rows[0].accountKey : null;
}
/** Internal recipient lookup: exact current verified address only. */
export const verifiedRecipient = internalQuery({
  args: { email: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: (ctx, { email }) => findVerifiedRecipient(ctx, email),
});

/** Recheck a provider-attested recipient inside the granting transaction. */
export async function currentEmailRecipient(
  ctx: QueryCtx | MutationCtx,
  email: string,
  recipient: string,
  native: boolean,
) {
  const current = await findVerifiedRecipient(ctx, email);
  invariant(
    !current || current === recipient,
    'BAD_ARGUMENT',
    'This email matches different Forge accounts. Invite by Forge handle instead.',
  );
  return !native || current === recipient;
}
