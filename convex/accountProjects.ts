// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** The signed-in person's projects for Account > Projects and the older Projects screen (Item 3d5d8839): every active
 * project they own or are a member of, with their role and compact counts, newest activity first. One query per page.
 *
 * Order and paging come from the person's rows in accountProjectOrder (activity in whole hours, ties by project id;
 * convex/accountProjectOrder.ts) with Convex's cursor: removed projects and ended grants have no row, so they never
 * fill a page. Bounds per page (P ≤ 100, default 50): one index page of P order rows, then per row its project and,
 * for a member row only, the role re-check (≤ 2 indexed reads; owner rows 0); per shown project the owner's account
 * (once per owner), the line summary, ≤ 31 held and ≤ 61 open Lane marks, and on compact planning partitions ≤ 4
 * pages per live Item state plus ≤ 40 done pages (positions only). A device limited to one project reads only that
 * project. For a person, the page includes their one indexed star lookup per public row.
 *
 * Projects reached only through a linked team (no direct grant, so no order row) join the FIRST page, merged by
 * activity (convex/teamGrant.ts: bounded, ≤ 25 projects, one empty range and nothing else for a person in no
 * team); later pages read none. Their rows cost the same per project as any other.
 * Nothing is written; no per-project client query. */
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { projectRole, shareQueryRoles } from './projectRole';
import { teamReachedProjects } from './teamGrant';
import { activityHour, HOUR_MS } from './accountProjectOrderHour';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { isDeviceIdentity, query } from './cliServer';
import { accountFor } from './urlIdentity';
import { lineSummary } from './projectLiveLineStore';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { decodePlanPage, PLAN_ROWS, planParent } from './projectPlanRows';
import { flowDay, flowVerdict } from '../src/flow-day';
import { retainedMainVerdict } from './projectLiveLineRecovery';
import { NEEDS_ME_HELD_LIMIT, readNeedsMe } from './projectNeedsMe';
import { attentionSchedule } from '../src/needs-attention';

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
  /** The project's revision, so Move to trash from this list is the one retry-safe mutation (no read first). */
  revision: v.number(),
  role,
  visibility: v.union(v.literal('private'), v.literal('public')),
  starred: v.optional(v.boolean()),
  /** The hour (as ms) of the last landing on main or the project's creation: the list's order key. */
  activityAt: v.number(),
  /** Lanes held for a person (an approval or review): what needs someone. A Lane held on its own next step (a failed
   * check, a conflict, a wait) counts under `lanes`, as agent work (Issue f5c4d136). */
  held: count,
  /** Open Lanes that wait on no person: editing, saved, checking, ready, or held on their own next step. */
  lanes: count,
  /** A viewer-specific decision count, not a Lane count. Absent in replies from before this projection. */
  attention: v.optional(count),
  attentionChanges: v.optional(v.array(v.object({ at: v.number(), n: v.number(), atLeast: v.boolean() }))),
  main: v.union(v.object({ at: v.optional(v.number()), passing: v.boolean() }), v.null()),
  checksConfigured: v.optional(v.boolean()),
  verdict: v.optional(
    v.object({
      red: v.boolean(),
      since: v.union(v.number(), v.null()),
      checkedAt: v.union(v.number(), v.null()),
      sequence: v.optional(v.number()),
    }),
  ),
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
  starAccount: string | undefined,
  viaTeam = false,
) {
  if (!handles.has(project.owner))
    handles.set(
      project.owner,
      accountFor(ctx, project.owner).then(account => account?.handle),
    );
  const marks = (held: boolean, limit: number) =>
    ctx.db
      .query('projectLiveLineLanes')
      .withIndex('by_project_and_held', q => q.eq('projectId', project._id).eq('held', held))
      .order(held ? 'asc' : 'desc')
      .take(limit + 1);
  const starred =
    starAccount && project.visibility === 'public'
      ? ctx.db
          .query('projectStars')
          .withIndex('by_project_and_account', q => q.eq('projectId', project._id).eq('account', starAccount))
          .unique()
          .then(Boolean)
      : undefined;
  const [handle, summary, held, open, star] = await Promise.all([
    handles.get(project.owner)!,
    lineSummary(ctx.db, project._id),
    marks(true, NEEDS_ME_HELD_LIMIT),
    marks(false, OPEN_LIMIT),
    starred,
  ]);
  const newestHeld =
    viaTeam && held.length > NEEDS_ME_HELD_LIMIT
      ? await ctx.db
          .query('projectLiveLineLanes')
          .withIndex('by_project_and_held', q => q.eq('projectId', project._id).eq('held', true))
          .order('desc')
          .first()
      : null;
  const value = (summary ? JSON.parse(summary.value) : {}) as {
    main?: { at?: string; check?: string };
    exit?: { at: number };
    flow?: unknown;
  };
  const flow = flowDay(value.flow);
  const verdict = flowVerdict(flow) ?? flowVerdict(await retainedMainVerdict(ctx.db, project._id));
  const mainAt = value.main?.at ? Date.parse(value.main.at) : NaN;
  // A hold that waits on a person is Needs you; a Lane held on its own next step is agent work (no extra read).
  const counted = held.slice(0, HELD_LIMIT + 1);
  const waiting = counted.filter(mark => !mark.fix);
  const activityAt = Math.max(
    project._creationTime,
    Number.isFinite(mainAt) ? mainAt : 0,
    value.exit?.at ?? 0,
    newestHeld?.changedAt ?? 0,
    ...[...held, ...open].map(mark => mark.changedAt),
  );
  return {
    marks: held,
    value: {
      id: project._id,
      name: project.name,
      ...(handle ? { handle } : {}),
      ...(project.slug ? { slug: project.slug } : {}),
      revision: project.revision,
      role,
      visibility: project.visibility === 'public' ? 'public' : 'private',
      ...(star === undefined ? {} : { starred: star }),
      activityAt,
      held: { n: Math.min(waiting.length, HELD_LIMIT), atLeast: held.length > HELD_LIMIT },
      lanes: capped(open.length + counted.length - waiting.length, OPEN_LIMIT),
      ...(verdict ? { verdict } : {}),
      ...(project.hasCheckDefinitions === undefined ? {} : { checksConfigured: project.hasCheckDefinitions }),
      main: value.main
        ? { ...(Number.isFinite(mainAt) ? { at: mainAt } : {}), passing: value.main.check === 'passed' }
        : null,
    } satisfies Omit<AccountProject, 'items'>,
  };
}

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(accountProject),
  handler: async (ctx, { paginationOpts }) => {
    const user = await ctx.auth.getUserIdentity();
    const none = { page: [], isDone: true, continueCursor: '' };
    if (!user) return none;
    shareQueryRoles(ctx);
    const handles = new Map<string, Promise<string | undefined>>();
    const now = Date.now();
    const addDetails = async (
      project: Doc<'hostedProjects'>,
      shown: Awaited<ReturnType<typeof row>>,
    ): Promise<AccountProject> => {
      // The list and roles have already been read. Only start the next bounded Needs me projection
      // when there is room for one whole project; return an explicit unknown rather than a false zero.
      const headroom = await ctx.meta?.getTransactionMetrics?.();
      if (
        headroom &&
        (headroom.bytesRead.remaining < 8 * 1024 * 1024 ||
          headroom.databaseQueries.remaining < 1024 ||
          headroom.documentsRead.remaining < 2048)
      ) {
        return { ...shown.value, items: null, attention: { n: 0, atLeast: true } };
      }
      const [items, evidence] = await Promise.all([
        itemCounts(ctx, project),
        readNeedsMe(ctx, project, user.subject, { marks: shown.marks }),
      ]);
      return { ...shown.value, items, ...attentionSchedule(evidence, now) };
    };
    const starAccount = !isDeviceIdentity(user) ? user.subject : undefined;
    // A device limited to one project reads that project directly: no page of other projects is ever taken.
    const device = (ctx as { forgeDevice?: Doc<'cliCredentials'> | null }).forgeDevice;
    if (device?.settings?.projects.kind === 'project') {
      const project = await ctx.db.get(device.settings.projects.projectId as Id<'hostedProjects'>);
      const role = project && !project.removal ? await projectRole(ctx, project, user.subject) : null;
      return role
        ? {
            ...none,
            page: [await addDetails(project!, await row(ctx, project!, role, handles, starAccount))],
          }
        : none;
    }
    const numItems = Math.max(1, Math.min(ACCOUNT_PROJECTS_PAGE_MAX, Math.floor(paginationOpts.numItems)));
    // Activity order (whole hours, ties by project id) with Convex's own cursor; removal and grant writes keep the
    // rows current in their own transaction, and the role is re-checked here so a row never grants a read.
    // First page only: the team-reached projects have no order row, so no cursor could ever reach them. They are read
    // first so the page never hydrates more than the page maximum in all.
    const reached = paginationOpts.cursor ? [] : await teamReachedProjects(ctx, user.subject);
    const result = await ctx.db
      .query('accountProjectOrder')
      .withIndex('by_person_and_activity', q => q.eq('person', user.subject))
      .order('desc')
      .paginate({
        ...paginationOpts,
        numItems: Math.min(numItems, ACCOUNT_PROJECTS_PAGE_MAX - reached.length),
      });
    const page = [];
    for (const order of result.page) {
      const project = await ctx.db.get(order.projectId);
      if (!project || project.removal) continue;
      const role = project.owner === user.subject ? 'owner' : await projectRole(ctx, project, user.subject);
      if (role) page.push({ project, role, activityAt: order.activityHour * HOUR_MS });
    }
    const [direct, team] = await Promise.all([
      Promise.all(
        page.map(async ({ project, role, activityAt }) => {
          const shown = await row(ctx, project, role, handles, starAccount);
          return { project, shown: { ...shown, value: { ...shown.value, activityAt } } };
        }),
      ),
      Promise.all(
        reached.map(async ({ project, role }) => {
          const shown = await row(ctx, project, role, handles, starAccount, true);
          return {
            project,
            shown: {
              ...shown,
              value: { ...shown.value, activityAt: activityHour(shown.value.activityAt) * HOUR_MS },
            },
          };
        }),
      ),
    ]);
    const rows = [];
    const viaTeam = [];
    for (const { project, shown } of direct) rows.push(await addDetails(project, shown));
    for (const { project, shown } of team) viaTeam.push(await addDetails(project, shown));
    // Merge by activity without reordering the direct rows (their order is the index's).
    for (const item of viaTeam.sort((a, b) => b.activityAt - a.activityAt)) {
      const at = rows.findIndex(other => other.activityAt < item.activityAt);
      rows.splice(at < 0 ? rows.length : at, 0, item);
    }
    return { ...result, page: rows };
  },
});
