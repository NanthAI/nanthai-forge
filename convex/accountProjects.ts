// SPDX-License-Identifier: Apache-2.0
/** The signed-in person's projects for Account > Projects and the older Projects screen (Item 3d5d8839): every active
 * project they own or are a member of, with their role and compact counts, newest activity first. One query per view.
 *
 * Bounds per call (limit L ≤ 200, default 50): ≤ L+1 owned rows from the active-only index (removed projects never
 * fill the page), ≤ L+1 write and ≤ L+1 read grants, then per shown project: its row, the owner's account (once per
 * owner), the line summary, ≤ 21 held and ≤ 61 open Lane marks, and on compact planning partitions ≤ 4 pages per live
 * Item state plus ≤ 40 done pages (positions only). Nothing is written; no per-project client query. */
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { query } from './cliServer';
import { accountFor } from './urlIdentity';
import { lineSummary } from './projectLiveLineStore';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { decodePlanPage, PLAN_ROWS, planParent } from './projectPlanRows';

export const ACCOUNT_PROJECTS_DEFAULT = 50;
export const ACCOUNT_PROJECTS_MAX = 200;
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
  /** Latest of: last landing on main, last Lane change, last Lane exit, the project's creation. */
  activityAt: v.number(),
  /** Lanes held for a person: what needs someone. */
  held: count,
  /** Open Lanes not held: editing, saved, checking or ready. */
  lanes: count,
  main: v.union(v.object({ at: v.optional(v.number()), passing: v.boolean() }), v.null()),
  /** Items by state; null until the project's plan has compact pages (or it has no plan). */
  items: v.union(v.object({ left: count, inProgress: count, done: count }), v.null()),
});
export type AccountProject = typeof accountProject.type;

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
  args: { limit: v.optional(v.number()) },
  returns: v.object({ projects: v.array(accountProject), more: v.boolean() }),
  handler: async (ctx, { limit: asked }) => {
    const user = await ctx.auth.getUserIdentity();
    if (!user) return { projects: [], more: false };
    const limit = Math.max(1, Math.min(ACCOUNT_PROJECTS_MAX, Math.floor(asked ?? ACCOUNT_PROJECTS_DEFAULT)));
    const [owned, writes, reads] = await Promise.all([
      ctx.db
        .query('hostedProjects')
        .withIndex('by_owner_and_removal', q => q.eq('owner', user.subject).eq('removal', undefined))
        .order('desc')
        .take(limit + 1),
      ctx.db
        .query('projectContributors')
        .withIndex('by_contributor', q => q.eq('contributor', user.subject))
        .order('desc')
        .take(limit + 1),
      ctx.db
        .query('projectReaders')
        .withIndex('by_reader', q => q.eq('reader', user.subject))
        .order('desc')
        .take(limit + 1),
    ]);
    let more = owned.length > limit || writes.length > limit || reads.length > limit;
    const found = new Map<Id<'hostedProjects'>, { project: Doc<'hostedProjects'>; role: Role }>();
    for (const project of owned.slice(0, limit)) found.set(project._id, { project, role: 'owner' });
    for (const [grants, role] of [
      [writes.slice(0, limit).map(grant => grant.projectId), 'write'],
      [reads.slice(0, limit).map(grant => grant.projectId), 'read'],
    ] as const)
      for (const id of grants) {
        if (found.has(id)) continue;
        const project = await ctx.db.get(id);
        if (project && !project.removal && project.owner !== user.subject) found.set(id, { project, role });
      }
    // A device limited to one project sees only that project here too.
    const device = (ctx as { forgeDevice?: Doc<'cliCredentials'> | null }).forgeDevice;
    const only = device?.settings?.projects.kind === 'project' ? device.settings.projects.projectId : null;
    const chosen = [...found.values()].filter(({ project }) => !only || project._id === only);
    const handles = new Map<string, Promise<string | undefined>>();
    const rows = await Promise.all(chosen.map(({ project, role }) => row(ctx, project, role, handles)));
    rows.sort((a, b) => b.activityAt - a.activityAt);
    if (rows.length > limit) more = true;
    return { projects: rows.slice(0, limit), more };
  },
});
