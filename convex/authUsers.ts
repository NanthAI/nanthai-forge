// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ConvexError, v } from 'convex/values';
import { vGithubProfile } from '@convex-dev/auth/methods/github/server';
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './server';
import { invariant } from '../src/errors';
import { LEGAL_VERSION } from '../src/legal-version';
import { ensureAccount } from './urlIdentity';

const githubMethod = v.object({ name: v.literal('github'), profile: vGithubProfile });
const passkeyMethod = v.object({ name: v.literal('usernamePasskey'), profile: v.object({}) });
/** How long a provider-confirmed address stays good for recipient lookup and redemption without
 * a new GitHub sign-in or link (16723708: the owner's recommended 90 days). */
export const EMAIL_CONFIRMED_MAX_AGE_MS = 90 * 86_400_000;
/** The address fields every GitHub sign-in, sign-up and link writes: verified, or cleared. */
export const githubEmailFields = (profile: { email?: string | null; emailVerified?: boolean }) =>
  profile.emailVerified && profile.email
    ? { email: profile.email.trim().toLowerCase(), emailVerified: true, emailConfirmedAt: Date.now() }
    : { email: undefined, emailVerified: false, emailConfirmedAt: undefined };
async function insertUser(
  ctx: MutationCtx,
  fields: {
    githubId?: string;
    githubLogin?: string;
    email?: string;
    emailVerified: boolean;
    emailConfirmedAt?: number;
  },
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
    const { email, emailVerified, emailConfirmedAt } = githubEmailFields(profile);
    return insertUser(ctx, {
      githubId: profile.id,
      githubLogin: profile.login,
      ...(email ? { email, emailConfirmedAt } : {}),
      emailVerified,
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
    await ctx.db.patch(userId, { githubLogin: profile.login, ...githubEmailFields(profile) });
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

/** Shared by account lookup and redemption; no provider fallback. For granting access (the
 * default), an address a provider has not confirmed within EMAIL_CONFIRMED_MAX_AGE_MS (a
 * passkey-only account keeps its old one) is no recipient until the next GitHub sign-in or link
 * refreshes it. `anyAge` is for protections only (mail suppression, the block step's address):
 * they keep working for an old address and never grant anything. */
export async function findVerifiedRecipient(
  ctx: QueryCtx | MutationCtx,
  email: string,
  { anyAge = false }: { anyAge?: boolean } = {},
) {
  email = email.trim().toLowerCase();
  const rows = await ctx.db
    .query('users')
    .withIndex('by_email', q => q.eq('email', email))
    .take(2);
  invariant(rows.length <= 1, 'BAD_ARGUMENT', 'No unique account matches that address.');
  const row = rows[0];
  const confirmed = row ? (row.emailConfirmedAt ?? row._creationTime) : 0;
  return row?.emailVerified &&
    row.email === email &&
    (anyAge || Date.now() - confirmed <= EMAIL_CONFIRMED_MAX_AGE_MS)
    ? row.accountKey
    : null;
}
/** Internal recipient lookup: exact current verified address only. */
export const verifiedRecipient = internalQuery({
  args: { email: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: (ctx, { email }) => findVerifiedRecipient(ctx, email),
});
