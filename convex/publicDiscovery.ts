// SPDX-License-Identifier: Apache-2.0
/** Stars and public settings (Items 8947a779, 76be0714). Each write is one retry-safe mutation: a star sets the
 * person's state for one project (repeating it changes nothing) and updates the project's count in the same
 * transaction. Agents cannot star, and only the owner, as a person in a browser, changes what visitors see. */
import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import { query, mutation, internalMutation, isDeviceIdentity } from './cliServer';
import { ownedProject } from './projectAuthority';
import { requireOwnerPerson } from './ownerPerson';
import { accountFor } from './urlIdentity';
import { report } from './errors';
import { invariant } from '../src/errors';
import { isPublicProject } from './publicVisibility';
import { ensurePublicRow, publicRow } from './publicListing';

/** A star is a signed-in person's: no sign-in and agent credentials each get a structured refusal naming the step. */
async function starringPerson(ctx: MutationCtx) {
  const user = await ctx.auth.getUserIdentity();
  invariant(
    user,
    'AUTH_REQUIRED',
    'Sign in to star a project: open Forge in a browser and sign in, then star.',
  );
  invariant(
    !isDeviceIdentity(user),
    'AUTH_SCOPE_DENIED',
    'A star is a person’s: agents cannot star. Open the project in a browser, signed in, to star it.',
  );
  return user.subject;
}

export const star = mutation({
  args: { projectId: v.id('hostedProjects'), starred: v.boolean() },
  returns: v.object({ starred: v.boolean(), stars: v.number() }),
  handler: async (ctx, { projectId, starred }) => {
    try {
      const account = await starringPerson(ctx);
      const project = await ctx.db.get(projectId);
      // Private and missing projects answer alike, so a star never confirms a private project exists.
      invariant(isPublicProject(project), 'PROJECT_UNAVAILABLE', 'This public project is unavailable.');
      const row = await ensurePublicRow(ctx, project!);
      const existing = await ctx.db
        .query('projectStars')
        .withIndex('by_project_and_account', q => q.eq('projectId', projectId).eq('account', account))
        .unique();
      if (starred === Boolean(existing)) return { starred, stars: row.stars };
      if (starred) await ctx.db.insert('projectStars', { projectId, account });
      else await ctx.db.delete(existing!._id);
      const stars = Math.max(0, row.stars + (starred ? 1 : -1));
      await ctx.db.patch(row._id, { stars });
      return { starred, stars };
    } catch (error) {
      return report(error);
    }
  },
});

/** The viewer's own star; signed out (or an agent) has none. One indexed read. */
export const myStar = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.object({ starred: v.boolean() }),
  handler: async (ctx, { projectId }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user || isDeviceIdentity(user)) return { starred: false };
    const row = await ctx.db
      .query('projectStars')
      .withIndex('by_project_and_account', q => q.eq('projectId', projectId).eq('account', user.subject))
      .unique();
    return { starred: Boolean(row) };
  },
});

/** Who starred: the owner only, one page of handles (D.7). */
export const stargazers = query({
  args: { projectId: v.id('hostedProjects'), paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(v.object({ handle: v.string() })),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { projectId, paginationOpts }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'This Forge project is unavailable with the current account.');
      await ownedProject(ctx, projectId, user.subject);
      const result = await ctx.db
        .query('projectStars')
        .withIndex('by_project_and_account', q => q.eq('projectId', projectId))
        .paginate({ ...paginationOpts, numItems: Math.min(paginationOpts.numItems, 100) });
      const page = [];
      for (const row of result.page) {
        const account = await accountFor(ctx, row.account);
        if (account?.handle) page.push({ handle: account.handle });
      }
      return { page, isDone: result.isDone, continueCursor: result.continueCursor };
    } catch (error) {
      return report(error);
    }
  },
});

const settingsResult = v.object({ laneTitles: v.boolean(), stars: v.number() });
/** What visitors see of this project that this Lane owns: the Lane-titles opt-in, and the star count. The plan's
 * public settings are the planning contract's (an Item's `hidden`, the project's `planVisibility`; d3357f40). */
export const settings = query({
  args: { projectId: v.id('hostedProjects') },
  returns: settingsResult,
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'This Forge project is unavailable with the current account.');
      await ownedProject(ctx, projectId, user.subject);
      const row = await publicRow(ctx, projectId);
      return { laneTitles: row?.laneTitles === true, stars: row?.stars ?? 0 };
    } catch (error) {
      return report(error);
    }
  },
});

/** Show open Lane titles to visitors ("show work in progress", D.3): the owner person only; reversible. */
export const setSettings = mutation({
  args: { projectId: v.id('hostedProjects'), laneTitles: v.boolean() },
  returns: settingsResult,
  handler: async (ctx, { projectId, laneTitles }) => {
    try {
      const user = await requireOwnerPerson(ctx, 'change what visitors see');
      const project = await ownedProject(ctx, projectId, user.subject);
      const row = await ensurePublicRow(ctx, project);
      if (row.laneTitles !== laneTitles) await ctx.db.patch(row._id, { laneTitles });
      return { laneTitles, stars: row.stars };
    } catch (error) {
      return report(error);
    }
  },
});

/** One-time listing of public projects created before discovery existed: bounded pages, run by the lead on dev. */
export const backfillListed = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({ listed: v.number(), continueCursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db.query('hostedProjects').paginate({ cursor, numItems: 50 });
    let listed = 0;
    for (const project of result.page)
      if (isPublicProject(project)) {
        await ensurePublicRow(ctx, project);
        listed++;
      }
    return { listed, continueCursor: result.continueCursor, isDone: result.isDone };
  },
});
