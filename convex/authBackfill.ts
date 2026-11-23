// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalAction, internalQuery } from './server';
import { internal } from './_generated/api';
import { convexFetch, networkTimeout } from './networkFetch';
import { invariant } from '../src/errors';

const cursor = v.union(v.string(), v.null());
const account = v.object({ accountKey: v.string(), handle: v.string() });
const pageResult = v.object({ entries: v.array(account), cursor: v.string(), isDone: v.boolean() });
export const accountsPage = internalQuery({
  args: { cursor },
  returns: pageResult,
  handler: async (ctx, args) => {
    const page = await ctx.db.query('forgeAccounts').paginate({ cursor: args.cursor, numItems: 25 });
    return {
      entries: page.page.map(row => ({ accountKey: row.owner, handle: row.handle })),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** Read-only operator page. Never return provider profiles, email, or credentials. */
export const readPage = internalAction({
  args: { cursor },
  returns: v.object({
    entries: v.array(v.object({ ...account.fields, githubIds: v.array(v.string()) })),
    cursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    entries: { accountKey: string; handle: string; githubIds: string[] }[];
    cursor: string;
    isDone: boolean;
  }> => {
    const page = await ctx.runQuery(internal.authBackfill.accountsPage, args);
    const owners = page.entries.filter(row => /^user_[A-Za-z0-9]+$/.test(row.accountKey));
    let people: {
      id: string;
      external_accounts?: {
        provider?: string;
        provider_user_id?: unknown;
        verification?: { status?: string } | null;
      }[];
    }[] = [];
    if (owners.length) {
      const secret = process.env.CLERK_SECRET_KEY;
      invariant(secret, 'AUTH_CONFIGURATION', 'Configure CLERK_SECRET_KEY for the account backfill.');
      const params = new URLSearchParams({ limit: '25' });
      for (const row of owners) params.append('user_id', row.accountKey);
      const response = await convexFetch(`https://api.clerk.com/v1/users?${params}`, {
        headers: { Authorization: `Bearer ${secret}` },
        redirect: 'error',
        signal: networkTimeout(30_000),
      });
      invariant(
        response.ok,
        'GITHUB_UNAVAILABLE',
        'The account backfill could not read provider identities.',
      );
      const value: unknown = await response.json();
      invariant(Array.isArray(value) && value.length <= 25, 'GITHUB_RESPONSE', 'Invalid account page.');
      people = value;
      invariant(
        people.every(person => owners.some(row => row.accountKey === person.id)) &&
          new Set(people.map(person => person.id)).size === people.length,
        'GITHUB_RESPONSE',
        'The provider returned another account.',
      );
    }
    return {
      ...page,
      entries: page.entries.map(row => ({
        ...row,
        githubIds: [
          ...new Set(
            (people.find(person => person.id === row.accountKey)?.external_accounts ?? []).flatMap(link =>
              link.provider === 'oauth_github' &&
              link.verification?.status === 'verified' &&
              typeof link.provider_user_id === 'string' &&
              /^[1-9][0-9]{0,19}$/.test(link.provider_user_id)
                ? [link.provider_user_id]
                : [],
            ),
          ),
        ],
      })),
    };
  },
});
