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
import { effectivePolicy } from '../src/autonomy-policy';
import { isPublicProject } from './publicVisibility';
import { ensurePublicRow, publicRow } from './publicListing';
import { entry, listedProjects } from './publicRead';

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

/** The viewer's stars for a single rendered page, in one query. Each shown project gets one exact indexed lookup.
 * Old clients can still read the first 200 stars. Signed-out visitors and agents have none. */
export const myStars = query({
  args: { projectIds: v.optional(v.array(v.id('hostedProjects'))) },
  returns: v.array(v.id('hostedProjects')),
  handler: async (ctx, { projectIds }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user || isDeviceIdentity(user)) return [];
    if (projectIds) {
      const ids = [...new Set(projectIds.slice(0, 200))];
      const stars = await Promise.all(
        ids.map(projectId =>
          ctx.db
            .query('projectStars')
            .withIndex('by_project_and_account', q =>
              q.eq('projectId', projectId).eq('account', user.subject),
            )
            .unique(),
        ),
      );
      return stars.flatMap(star => (star ? [star.projectId] : []));
    }
    const rows = await ctx.db
      .query('projectStars')
      .withIndex('by_account', q => q.eq('account', user.subject))
      .take(200);
    return rows.map(row => row.projectId);
  },
});

export const STARRED_READ = 50;

/** The viewer's own starred projects, for the Starred list on their own profile (Item 6a251b23). A starred list is
 * never public (D.7): this reads only the signed-in person's stars, so it cannot show anyone else's. The newest
 * STARRED_READ stars, each kept only while its project is still public, as the same rows explore lists. Asked once
 * when the person opens their own profile, never subscribed. Reads at most 50 stars, and 50 listing rows, projects
 * and owner handles. */
export const myStarred = query({
  args: { now: v.number() },
  returns: v.object({
    projects: v.array(
      v.object({
        id: v.id('hostedProjects'),
        handle: v.string(),
        slug: v.string(),
        name: v.string(),
        since: v.number(),
        stars: v.number(),
        landings: v.number(),
        days: v.array(v.number()),
        recordedSince: v.optional(v.number()),
        main: v.union(v.literal('passing'), v.literal('unchecked')),
      }),
    ),
    more: v.boolean(),
  }),
  handler: async (ctx, { now }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user || isDeviceIdentity(user)) return { projects: [], more: false };
    const stars = await ctx.db
      .query('projectStars')
      .withIndex('by_account', q => q.eq('account', user.subject))
      .order('desc')
      .take(STARRED_READ + 1);
    const rows = [];
    for (const star of stars.slice(0, STARRED_READ)) {
      const row = await publicRow(ctx, star.projectId);
      if (row) rows.push(row);
    }
    return {
      projects: (await listedProjects(ctx, rows)).map(item => entry(item, now)),
      more: stars.length > STARRED_READ,
    };
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

const planVisibility = v.union(v.literal('public'), v.literal('members'));
const settingsResult = v.object({ laneTitles: v.boolean(), planVisibility, stars: v.number() });
const planOf = (project: { planVisibility?: unknown }) =>
  project.planVisibility === 'members' ? ('members' as const) : ('public' as const);
/** What visitors see of this project: the Lane-titles opt-in, whether the plan is public or members-only (Item
 * 76be0714; an Item's own `hidden` is set on the Item), and the star count. */
export const settings = query({
  args: { projectId: v.id('hostedProjects') },
  returns: settingsResult,
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'This Forge project is unavailable with the current account.');
      const project = await ownedProject(ctx, projectId, user.subject);
      const row = await publicRow(ctx, projectId);
      return {
        laneTitles: row?.laneTitles === true,
        planVisibility: planOf(project),
        stars: row?.stars ?? 0,
      };
    } catch (error) {
      return report(error);
    }
  },
});

/** Show open Lane titles to visitors ("show work in progress", D.3) and keep the plan public or members-only
 * (76be0714): the owner person only; each is reversible, and an omitted field keeps its value. */
export const setSettings = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    laneTitles: v.optional(v.boolean()),
    planVisibility: v.optional(planVisibility),
    /** One id per attempt: a retry of a plan change whose reply was lost reconciles instead of applying it again. */
    operationId: v.optional(v.string()),
  },
  returns: settingsResult,
  handler: async (ctx, { projectId, laneTitles: requested, planVisibility: plan, operationId }) => {
    try {
      const user = await requireOwnerPerson(ctx, 'change what visitors see');
      const project = await ownedProject(ctx, projectId, user.subject);
      const row = await ensurePublicRow(ctx, project);
      const laneTitles = requested ?? row.laneTitles === true;
      if (row.laneTitles !== laneTitles) await ctx.db.patch(row._id, { laneTitles });
      const current = planOf(project);
      const request = JSON.stringify({ planVisibility: plan });
      const original =
        plan && operationId
          ? await ctx.db
              .query('projectPolicyChanges')
              .withIndex('by_project_and_operation', q =>
                q.eq('projectId', projectId).eq('operationId', operationId),
              )
              .unique()
          : null;
      if (original) {
        invariant(
          original.actor === user.subject && original.request === request,
          'WORK_OPERATION_CHANGED',
          'Retry the plan change with its original values.',
        );
        // Already applied: report the project as it is now; a later change by someone else is not undone.
        return { laneTitles, planVisibility: current, stars: row.stars };
      }
      if (plan && plan !== current) {
        await ctx.db.patch(project._id, { planVisibility: plan === 'members' ? 'members' : undefined });
        // Item 65b6d701: recorded in the policy history as its own kind of change, in the same transaction.
        // Repeating the same value changes nothing and records nothing, so a retry never doubles the row.
        const policy = effectivePolicy(project);
        await ctx.db.insert('projectPolicyChanges', {
          projectId,
          operationId: operationId ?? crypto.randomUUID(),
          actor: user.subject,
          request,
          at: new Date().toISOString(),
          previous: policy,
          policy,
          planChange: { from: current, to: plan },
          rule: 'owner-person',
        });
      }
      return { laneTitles, planVisibility: plan ?? current, stars: row.stars };
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
