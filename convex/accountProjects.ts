// SPDX-License-Identifier: Apache-2.0
/** The signed-in person's projects for Account > Projects and the older Projects screen (Item 3d5d8839): every active
 * project they own or are a member of, with their role and compact counts, newest activity first. One query per page.
 *
 * Order and paging come from the person's rows in accountProjectOrder (activity in whole hours, ties by project id;
 * convex/accountProjectOrder.ts) with Convex's cursor: removed projects and ended grants have no row, so they never
 * fill a page. Bounds per page (P ≤ 100, default 50): one index page of P order rows, then per row its project and,
 * for a member row only, the role re-check (≤ 2 indexed reads; owner rows 0); per shown project the owner's account
 * (once per owner), the line summary, ≤ 21 held and ≤ 61 open Lane marks, and on compact planning partitions ≤ 4
 * pages per live Item state plus ≤ 40 done pages (positions only). A device limited to one project reads only that
 * project. Nothing is written; no per-project client query. */
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { projectRole } from './projectRole';
import { HOUR_MS } from './accountProjectOrderHour';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { query } from './cliServer';
import { accountFor } from './urlIdentity';
import { lineSummary } from './projectLiveLineStore';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { decodePlanPage, PLAN_ROWS, planParent } from './projectPlanRows';

const ACCOUNT_PROJECTS_PAGE_MAX = 100;
const HELD_LIMIT = 20;
const OPEN_LIMIT = 60;
const LIVE_PAGES = 4;
const DONE_PAGES = 40;

const role = v.union(v.literal('owner'), v.literal('write'), v.literal('read'));
const count = v.object({ n: v.number(), atLeast: v.boolean() });
export const accountProject = v.object({
  id: v.id('hostedProjects'),
  name: v.string(),
  handle: v.optional(v.string()),
  slug: v.optional(v.string()),
  role,
  visibility: v.union(v.literal('private'), v.literal('public')),
  /** The hour (as ms) of the last landing on main or the project's creation: the list's order key. */
  activityAt: v.number(),
  /** Lanes held for a person: what needs someone. */
  held: count,
  /** Open Lanes not held: editing, saved, checking or ready. */
  lanes: count,
  main: v.union(v.object({ at: v.optional(v.number()), passing: v.boolean() }), v.null()),
  /** Items by state; null until the project's plan has compact pages (or it has no plan). */
  items: v.union(v.object({ left: count, inProgress: count, done: count }), v.null()),
});

type AccountProject = typeof accountProject.type;
type Role = AccountProject['role'];
const capped = (n: number, limit: number) => ({ n: Math.min(n, limit), atLeast: n > limit });

async function itemCounts(ctx: QueryCtx, project: Doc<'hostedProjects'>): Promise<AccountProject['items']> {
  const generation = await selectedGeneration(ctx, project);
  if (!generation) return null;
  const generationId = recordPartition(generation);
  const partition = generation.recordsGenerationId ? await ctx.db.get(generationId) : generation;
  if (partition?.planRowsVersion !== 1) return null;
  const pages = (parent: string, limit: number) =>
    ctx.db
      .query('projectWorkDataRecords')
      .withIndex('by_generation_and_collection_and_parent_and_position', q =>
        q.eq('generationId', generationId).eq('collection', PLAN_ROWS).eq('parent', parent),
      )
      .take(limit);
  const live = async (status: string) => {
    const rows = await pages(planParent('issue', status), LIVE_PAGES);
    const n = rows.reduce((sum, page) => sum + decodePlanPage(page.value, page.parent).length, 0);
    return { n, atLeast: rows.length === LIVE_PAGES };
  };
  const [proposed, open, inProgress] = await Promise.all(['proposed', 'open', 'in-progress'].map(live));
  // Done Items sit in one parent per Initiative ("issue:closed:<id>", "issue:closed:" for none): one range.
  const closedPrefix = planParent('issue', 'closed', '');
  const closed = await ctx.db
    .query('projectWorkDataRecords')
    .withIndex('by_generation_and_collection_and_parent_and_position', q =>
      q
        .eq('generationId', generationId)
        .eq('collection', PLAN_ROWS)
        .gte('parent', closedPrefix)
        .lt('parent', `${closedPrefix.slice(0, -1)};`),
    )
    .take(DONE_PAGES);
  const done = closed.reduce((sum, page) => sum + decodePlanPage(page.value, page.parent).length, 0);
  return {
    left: { n: proposed!.n + open!.n, atLeast: proposed!.atLeast || open!.atLeast },
    inProgress: inProgress!,
    done: { n: done, atLeast: closed.length === DONE_PAGES },
  };
}

async function row(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  role: Role,
  handles: Map<string, Promise<string | undefined>>,
): Promise<AccountProject> {
  if (!handles.has(project.owner))
    handles.set(
      project.owner,
      accountFor(ctx, project.owner).then(account => account?.handle),
    );
  const marks = (held: boolean, limit: number) =>
    ctx.db
      .query('projectLiveLineLanes')
      .withIndex('by_project_and_held', q => q.eq('projectId', project._id).eq('held', held))
      .order('desc')
      .take(limit + 1);
  const [handle, summary, held, open, items] = await Promise.all([
    handles.get(project.owner)!,
    lineSummary(ctx.db, project._id),
    marks(true, HELD_LIMIT),
    marks(false, OPEN_LIMIT),
    itemCounts(ctx, project),
  ]);
  const value = (summary ? JSON.parse(summary.value) : {}) as {
    main?: { at?: string; check?: string };
    exit?: { at: number };
  };
  const mainAt = value.main?.at ? Date.parse(value.main.at) : NaN;
  const activityAt = Math.max(
    project._creationTime,
    Number.isFinite(mainAt) ? mainAt : 0,
    value.exit?.at ?? 0,
    ...[...held, ...open].map(mark => mark.changedAt),
  );
  return {
    id: project._id,
    name: project.name,
    ...(handle ? { handle } : {}),
    ...(project.slug ? { slug: project.slug } : {}),
    role,
    visibility: project.visibility === 'public' ? 'public' : 'private',
    activityAt,
    held: capped(held.length, HELD_LIMIT),
    lanes: capped(open.length, OPEN_LIMIT),
    main: value.main
      ? { ...(Number.isFinite(mainAt) ? { at: mainAt } : {}), passing: value.main.check === 'passed' }
      : null,
    items,
  };
}

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(accountProject),
  handler: async (ctx, { paginationOpts }) => {
    const user = await ctx.auth.getUserIdentity();
    const none = { page: [], isDone: true, continueCursor: '' };
    if (!user) return none;
    const handles = new Map<string, Promise<string | undefined>>();
    // A device limited to one project reads that project directly: no page of other projects is ever taken.
    const device = (ctx as { forgeDevice?: Doc<'cliCredentials'> | null }).forgeDevice;
    if (device?.settings?.projects.kind === 'project') {
      const project = await ctx.db.get(device.settings.projects.projectId as Id<'hostedProjects'>);
      const role = project && !project.removal ? await projectRole(ctx, project, user.subject) : null;
      return role ? { ...none, page: [await row(ctx, project!, role, handles)] } : none;
    }
    const numItems = Math.max(1, Math.min(ACCOUNT_PROJECTS_PAGE_MAX, Math.floor(paginationOpts.numItems)));
    // Activity order (whole hours, ties by project id) with Convex's own cursor; removal and grant writes keep the
    // rows current in their own transaction, and the role is re-checked here so a row never grants a read.
    const result = await ctx.db
      .query('accountProjectOrder')
      .withIndex('by_person_and_activity', q => q.eq('person', user.subject))
      .order('desc')
      .paginate({ ...paginationOpts, numItems });
    const page = [];
    for (const order of result.page) {
      const project = await ctx.db.get(order.projectId);
      if (!project || project.removal) continue;
      const role = project.owner === user.subject ? 'owner' : await projectRole(ctx, project, user.subject);
      if (role) page.push({ project, role, activityAt: order.activityHour * HOUR_MS });
    }
    return {
      ...result,
      page: await Promise.all(
        page.map(async ({ project, role, activityAt }) => ({
          ...(await row(ctx, project, role, handles)),
          activityAt,
        })),
      ),
    };
  },
});
