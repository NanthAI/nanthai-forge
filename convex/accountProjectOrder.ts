// SPDX-License-Identifier: Apache-2.0
/** Each person's projects in activity order (Item 3d5d8839): one row per (person, project) the person owns or is a
 * member of, so Account > Projects pages by activity with a real cursor and never reads a project the person has no
 * role on. Activity is main landings plus creation, in whole hours, so a landing writes nothing here unless its hour
 * bucket is new for the project (at most 24 hour updates per project per day, each one run per 100 stale rows; most
 * landings add none).
 *
 * Writers: project creation (owner row), every grant add/remove (same transaction, `syncPersonOrder`), project
 * removal and restore (`dropProjectOrder`, `restoreProjectOrder`), and the bucket update scheduled by acceptance.
 * Readers re-check the role (convex/accountProjects.ts); a row is an ordering hint, never access. */
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { internalMutation, type MutationCtx } from './server';
import { projectRole } from './projectRole';
import { lineSummary } from './projectLiveLineStore';
import { activityHour } from './accountProjectOrderHour';

/** Order rows deleted per removal transaction and per scheduled cleanup run. */
const ORDER_BATCH = 100;
/** Order rows a removal deletes in its own transaction; beyond it, bounded scheduled cleanup (read-time
 * `project.removal` and role checks hide the rest meanwhile; docs/data-placement.md). */
const INLINE_ROWS = 500;
/** Index ranges one rebuild or backfill transaction may spend, well inside the provider's 4,096 per transaction
 * (https://docs.convex.dev/production/state/limits). Each charge below is an upper bound of the reads it covers. */
const RANGE_BUDGET = 900;
/** One grant's sync: role (at most 2 ranges) plus the person's row (1). */
const SYNC_RANGES = 3;
/** Starting a project: its row, its live-line summary (the hour) and one grant page. */
const PROJECT_RANGES = 3;

const personRow = (ctx: Pick<MutationCtx, 'db'>, projectId: Id<'hostedProjects'>, person: string) =>
  ctx.db
    .query('accountProjectOrder')
    .withIndex('by_project_and_person', q => q.eq('projectId', projectId).eq('person', person))
    .unique();

/** The project's current activity hour: its latest main landing (live-line summary) or its creation. */
async function projectHour(ctx: Pick<MutationCtx, 'db'>, project: Doc<'hostedProjects'>) {
  const summary = await lineSummary(ctx.db, project._id);
  const value = (summary ? JSON.parse(summary.value) : {}) as { hour?: number; main?: { at?: string } };
  const mainAt = value.main?.at ? Date.parse(value.main.at) : NaN;
  return Math.max(
    activityHour(project._creationTime),
    value.hour ?? 0,
    Number.isFinite(mainAt) ? activityHour(mainAt) : 0,
  );
}

/** Upsert or delete one person's row from the current grant state. Call after every grant write. */
export async function syncPersonOrder(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  person: string,
  known?: Doc<'hostedProjects'> | null,
  hour?: number,
) {
  const project = known === undefined ? await ctx.db.get(projectId) : known;
  const role = project && !project.removal ? await projectRole(ctx, project, person) : null;
  const old = await personRow(ctx, projectId, person);
  if (!role) {
    if (old) await ctx.db.delete(old._id);
    return;
  }
  if (old) {
    if (old.role !== role) await ctx.db.patch(old._id, { role });
    return;
  }
  await ctx.db.insert('accountProjectOrder', {
    person,
    projectId,
    role,
    activityHour: hour ?? (await projectHour(ctx, project!)),
  });
}

/** Removal: up to INLINE_ROWS person rows go in the same transaction; the rest in bounded scheduled runs. */
export async function dropProjectOrder(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  limit = INLINE_ROWS,
) {
  const rows = await ctx.db
    .query('accountProjectOrder')
    .withIndex('by_project_and_person', q => q.eq('projectId', projectId))
    .take(limit + 1);
  for (const row of rows.slice(0, limit)) await ctx.db.delete(row._id);
  if (rows.length > limit) await ctx.scheduler.runAfter(0, internal.accountProjectOrder.drop, { projectId });
}

export const drop = internalMutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const project = await ctx.db.get(projectId);
    // A restore that raced the cleanup rebuilt the rows; leave them.
    if (project && !project.removal) return null;
    await dropProjectOrder(ctx, projectId, ORDER_BATCH);
    return null;
  },
});

type GrantTable = 'projectContributors' | 'projectReaders';
/** Where a project's grant rebuild stands: the table, and the last person done in it. */
type Rebuild = { projectId: Id<'hostedProjects'>; table: GrantTable; after?: string };
type Spend = { left: number };
const rebuildArgs = {
  projectId: v.id('hostedProjects'),
  table: v.union(v.literal('projectContributors'), v.literal('projectReaders')),
  after: v.optional(v.string()),
};

/** One grant page after `after`, in the grant index order (one range). */
async function grantPage(ctx: MutationCtx, at: Rebuild, n: number) {
  if (at.table === 'projectContributors') {
    const rows = await ctx.db
      .query('projectContributors')
      .withIndex('by_project_and_contributor', q =>
        at.after === undefined
          ? q.eq('projectId', at.projectId)
          : q.eq('projectId', at.projectId).gt('contributor', at.after),
      )
      .take(n);
    return rows.map(row => row.contributor);
  }
  const rows = await ctx.db
    .query('projectReaders')
    .withIndex('by_project_and_reader', q =>
      at.after === undefined
        ? q.eq('projectId', at.projectId)
        : q.eq('projectId', at.projectId).gt('reader', at.after),
    )
    .take(n);
  return rows.map(row => row.reader);
}

/** Rebuilds a project's grant rows from `at` while the range budget lasts; returns where it stopped (null: done). */
async function rebuildSome(ctx: MutationCtx, at: Rebuild, spend: Spend): Promise<Rebuild | null> {
  if (spend.left < PROJECT_RANGES + SYNC_RANGES) return at;
  spend.left -= PROJECT_RANGES - 1;
  const project = await ctx.db.get(at.projectId);
  if (!project || project.removal) return null;
  const hour = await projectHour(ctx, project);
  let next: Rebuild | null = at;
  while (next && spend.left >= 1 + SYNC_RANGES) {
    spend.left -= 1;
    const n = Math.min(ORDER_BATCH, Math.floor(spend.left / SYNC_RANGES));
    const people = await grantPage(ctx, next, n + 1);
    for (const person of people.slice(0, n)) await syncPersonOrder(ctx, project._id, person, project, hour);
    spend.left -= Math.min(people.length, n) * SYNC_RANGES;
    next =
      people.length > n
        ? { ...next, after: people[n - 1] }
        : next.table === 'projectContributors'
          ? { projectId: next.projectId, table: 'projectReaders' }
          : null;
  }
  return next;
}

/** Restore: the owner row plus one per current grant, inline while the budget lasts, then in scheduled runs. The
 * owner's sync is charged to the same budget, so the restore's order work stays within RANGE_BUDGET. */
export async function restoreProjectOrder(ctx: MutationCtx, project: Doc<'hostedProjects'>) {
  if (project.removal) return;
  await syncPersonOrder(ctx, project._id, project.owner, project);
  const next = await rebuildSome(
    ctx,
    { projectId: project._id, table: 'projectContributors' },
    { left: RANGE_BUDGET - SYNC_RANGES },
  );
  if (next) await ctx.scheduler.runAfter(0, internal.accountProjectOrder.rebuild, next);
}

export const rebuild = internalMutation({
  args: rebuildArgs,
  returns: v.null(),
  handler: async (ctx, at) => {
    const next = await rebuildSome(ctx, at, { left: RANGE_BUDGET });
    if (next) await ctx.scheduler.runAfter(0, internal.accountProjectOrder.rebuild, next);
    return null;
  },
});

/** Acceptance writes the summary's `hour`; only a new bucket schedules this. It patches the project's rows that are
 * older than `hour` (an index range on [projectId, activityHour]), 100 per run, and continues only while stale rows
 * remain: a replay, a superseded hour or an already-current project reads one empty range and schedules nothing. */
export const touch = internalMutation({
  args: { projectId: v.id('hostedProjects'), hour: v.number() },
  returns: v.null(),
  handler: async (ctx, { projectId, hour }) => {
    const stale = await ctx.db
      .query('accountProjectOrder')
      .withIndex('by_project_and_activity', q => q.eq('projectId', projectId).lt('activityHour', hour))
      .take(ORDER_BATCH + 1);
    for (const row of stale.slice(0, ORDER_BATCH)) await ctx.db.patch(row._id, { activityHour: hour });
    if (stale.length > ORDER_BATCH)
      await ctx.scheduler.runAfter(0, internal.accountProjectOrder.touch, { projectId, hour });
    return null;
  },
});

/** Projects read per backfill page (one native paginate per run). */
const PROJECT_PAGE = 25;
/** One-time backfill, bounded by the range budget per transaction (projects and their grants together) and
 * self-continuing with where it stopped: the project page (its cursor), how many of its projects are done, and the
 * unfinished grant rebuild. Upserts only, so a rerun writes nothing new and never changes a grant. */
export const backfill = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    done: v.optional(v.number()),
    grants: v.optional(v.object(rebuildArgs)),
  },
  returns: v.object({ projects: v.number(), isDone: v.boolean() }),
  handler: async (ctx, input) => {
    const spend = { left: RANGE_BUDGET - 1 };
    const cursor = input.cursor ?? null;
    const page = await ctx.db.query('hostedProjects').paginate({ cursor, numItems: PROJECT_PAGE });
    let done = input.done ?? 0;
    let grants: Rebuild | null = input.grants ?? null;
    let projects = 0;
    let next: { cursor: string | null; done: number } | null = null;
    for (;;) {
      if (grants) {
        grants = await rebuildSome(ctx, grants, spend);
        if (grants) {
          next = { cursor, done };
          break;
        }
        continue;
      }
      if (done >= page.page.length) {
        next = page.isDone ? null : { cursor: page.continueCursor, done: 0 };
        break;
      }
      if (spend.left < SYNC_RANGES + PROJECT_RANGES + SYNC_RANGES) {
        next = { cursor, done };
        break;
      }
      const project = page.page[done++]!;
      projects++;
      if (project.removal) continue;
      spend.left -= SYNC_RANGES;
      await syncPersonOrder(ctx, project._id, project.owner, project);
      grants = { projectId: project._id, table: 'projectContributors' };
    }
    if (next)
      await ctx.scheduler.runAfter(0, internal.accountProjectOrder.backfill, {
        ...next,
        ...(grants ? { grants } : {}),
      });
    return { projects, isDone: !next };
  },
});
