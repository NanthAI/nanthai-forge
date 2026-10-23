// SPDX-License-Identifier: Apache-2.0
import { invariant } from '../src/errors';
import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { ensureAccount, ensureProjectSlug } from './urlIdentity';
import { personUrlProfile, urlProfilesPage } from './projectPeople';
const cursor = v.union(v.string(), v.null());
const profile = v.object({
  owner: v.string(),
  username: v.optional(v.string()),
  firstName: v.optional(v.string()),
  lastName: v.optional(v.string()),
});
export const owners = internalQuery({
  args: { cursor },
  returns: v.object({ owners: v.array(v.string()) }),
  handler: async (ctx, input) => {
    const page = await ctx.db.query('hostedProjects').paginate({ cursor: input.cursor, numItems: 25 });
    return { owners: [...new Set(page.page.map(p => p.owner))] };
  },
});
/** Idempotent cursor mutation: all names and aliases are assigned transactionally. */
export const page = internalMutation({
  args: { cursor, profiles: v.array(profile) },
  returns: v.object({ cursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, input) => {
    const page = await ctx.db.query('hostedProjects').paginate({ cursor: input.cursor, numItems: 25 });
    for (const project of page.page) {
      await ensureAccount(
        ctx,
        project.owner,
        input.profiles.find(p => p.owner === project.owner),
      );
      await ensureProjectSlug(ctx, project);
    }
    return { cursor: page.continueCursor, isDone: page.isDone };
  },
});
export const accounts = internalMutation({
  args: { profiles: v.array(profile) },
  returns: v.null(),
  handler: async (ctx, input) => {
    for (const profile of input.profiles) await ensureAccount(ctx, profile.owner, profile);
    return null;
  },
});
/** Cursor spans Clerk accounts first, then project rows. Retry the same cursor safely. */
export const run = internalAction({
  args: { cursor },
  returns: v.object({ cursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, input): Promise<{ cursor: string; isDone: boolean }> => {
    if (!input.cursor || input.cursor.startsWith('accounts:')) {
      const offset = Number(input.cursor?.slice(9) ?? 0);
      invariant(
        Number.isSafeInteger(offset) && offset >= 0,
        'BAD_ARGUMENT',
        'Use the returned backfill cursor.',
      );
      const profiles = await urlProfilesPage(offset);
      await ctx.runMutation(internal.urlsBackfill.accounts, { profiles });
      return { cursor: profiles.length < 25 ? 'projects:' : `accounts:${offset + 25}`, isDone: false };
    }
    invariant(input.cursor.startsWith('projects:'), 'BAD_ARGUMENT', 'Use the returned backfill cursor.');
    const cursor = input.cursor.slice('projects:'.length) || null;
    const { owners } = await ctx.runQuery(internal.urlsBackfill.owners, { cursor });
    const profiles = await Promise.all(
      owners.map(async owner => ({ owner, ...(await personUrlProfile(owner)) })),
    );
    const page = await ctx.runMutation(internal.urlsBackfill.page, { cursor, profiles });
    return { ...page, cursor: `projects:${page.cursor}` };
  },
});
