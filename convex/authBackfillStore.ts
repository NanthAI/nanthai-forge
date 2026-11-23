// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './server';
import { authComponents } from './authComponents';
import { invariant } from '../src/errors';

/** Operator-only, bounded and retry-safe. No ownership fields are rewritten. */
export const batch = internalMutation({
  args: {
    apply: v.boolean(),
    entries: v.array(v.object({ accountKey: v.string(), githubId: v.string(), ambiguous: v.boolean() })),
  },
  returns: v.object({
    matched: v.number(),
    conflicts: v.number(),
    userWrites: v.number(),
    accountWrites: v.number(),
  }),
  handler: async (ctx, { entries, apply }) => {
    invariant(
      entries.length <= 25 && new Set(entries.map(row => row.accountKey)).size === entries.length,
      'BAD_ARGUMENT',
      'Use one backfill page of distinct accounts.',
    );
    const result = { matched: 0, conflicts: 0, userWrites: 0, accountWrites: 0 };
    for (const entry of entries) {
      invariant(/^[1-9][0-9]{0,19}$/.test(entry.githubId), 'GITHUB_RESPONSE', 'Invalid numeric GitHub id.');
      const account = await ctx.db
        .query('forgeAccounts')
        .withIndex('by_owner', q => q.eq('owner', entry.accountKey))
        .unique();
      invariant(account, 'BAD_ARGUMENT', 'The backfill account no longer exists.');
      const owners = await ctx.db
        .query('users')
        .withIndex('by_accountKey', q => q.eq('accountKey', entry.accountKey))
        .take(2);
      const matches = await ctx.db
        .query('users')
        .withIndex('by_githubId', q => q.eq('githubId', entry.githubId))
        .take(2);
      const current = owners[0];
      const binding = await ctx.runQuery(authComponents.authGithub.provider.getUserIdByAccount, {
        providerAccountId: entry.githubId,
      });
      const conflict =
        entry.ambiguous ||
        current?.githubConflict ||
        owners.length > 1 ||
        (current && current.githubId !== entry.githubId) ||
        matches.some(row => row.accountKey !== entry.accountKey) ||
        (binding !== null && binding !== current?._id);
      if (conflict) result.conflicts++;
      else result.matched++;
      // Retain both verified claims so callbacks also refuse a previously bound
      // provider account. Never reassign a component binding or an existing row.
      let userId = current?._id;
      if (!current) {
        result.userWrites++;
        if (apply)
          userId = await ctx.db.insert('users', {
            accountKey: entry.accountKey,
            githubId: entry.githubId,
            emailVerified: false,
            legacyGithubProvider: true,
            ...(conflict ? { githubConflict: true } : {}),
          });
      } else if ((conflict && !current.githubConflict) || !current.legacyGithubProvider) {
        result.userWrites++;
        if (apply)
          await ctx.db.patch(current._id, {
            legacyGithubProvider: true,
            ...(conflict ? { githubConflict: true } : {}),
          });
      }
      if (!conflict && binding === null) {
        result.accountWrites++;
        if (apply)
          await ctx.runMutation(authComponents.authGithub.provider._internal_dangerous_createAccount, {
            providerAccountId: entry.githubId,
            userId: userId!,
          });
      }
    }
    return result;
  },
});

/** Live evidence discloses only whether this handle has a consistent seed. */
export const seeded = internalQuery({
  args: { handle: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { handle }) => {
    const account = await ctx.db
      .query('forgeAccounts')
      .withIndex('by_handle', q => q.eq('handle', handle))
      .unique();
    if (!account) return false;
    const users = await ctx.db
      .query('users')
      .withIndex('by_accountKey', q => q.eq('accountKey', account.owner))
      .take(2);
    const user = users[0];
    if (users.length !== 1 || !user?.githubId || user.githubConflict) return false;
    const matches = await ctx.db
      .query('users')
      .withIndex('by_githubId', q => q.eq('githubId', user.githubId))
      .take(2);
    if (matches.length !== 1) return false;
    return (
      (await ctx.runQuery(authComponents.authGithub.provider.getUserIdByAccount, {
        providerAccountId: user.githubId,
      })) === user._id
    );
  },
});
