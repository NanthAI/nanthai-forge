// SPDX-License-Identifier: Apache-2.0
// Exact planning progress (Item 3fa3187d): one small row per Work record partition counts Items and Initiatives by
// status. The planning writer (projectWorkRecordWriter.ts, projectPlanCountsStore.ts) moves it in the transaction of each status change, so
// Needs me, Plan and the CLI's paged `planning {counts:true}` agree at any size. A partition made after this row
// existed counts from birth (projectWorkRecordWriter.ts); an older one is counted once by `backfill`, a bounded,
// idempotent chain whose cursor lives in the row itself. Disposable: `backfill {restart:true}` rebuilds it.
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import {
  emptyPlanCounts,
  planCounter as counter,
  planCountsBirth,
  planRootFacts as facts,
  PLAN_STATUSES,
  tallyGroup,
  zeroTally as zero,
  type PlanCounts,
  type Tally,
} from './projectPlanCountsStore';
import { visitorPlanCounter } from './publicWorkReadContext';
import { internal } from './_generated/api';
import { planQuery as query } from './cliServer';
import { internalMutation } from './server';
import { finishReadReader, finishReadSourceDb } from './projectFinishReadReader';
import { accessibleProject, readProjectRole } from './projectAuthority';
import { publicWorkPlan, type PublicPlanRoot } from './publicWorkPlan';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { planningRecordTable } from './projectWorkRecordTables';
import { planningPage } from './projectPlanningList';
import { report } from './errors';
import { invariant } from '../src/errors';

/** Roots read per backfill step; each step is one transaction. */
export const PLAN_COUNTS_PAGE = 200;
/** Distinct Initiatives and parent Items a visitor's Plan counts look up (then those parents' Initiatives). Groups past
 * it are left out and the reply is marked not exact: a lower bound, never a count of what the visitor may not see. */
export const VISITOR_COUNT_LOOKUPS = 100;

// Validator fields must be identifiers, so the reply names in-progress `inProgress`; the stored row keeps statuses.
const tally = v.object({
  proposed: v.number(),
  open: v.number(),
  inProgress: v.number(),
  closed: v.number(),
  abandoned: v.number(),
});
const reply = (counts: Partial<Tally>) => {
  const all = { ...zero(), ...counts };
  return {
    proposed: all.proposed,
    open: all.open,
    inProgress: all['in-progress'],
    closed: all.closed,
    abandoned: all.abandoned,
  };
};
export const planCountsResult = v.object({
  /** Every Item is counted. False only before this project's backfill finished: then the figures are lower bounds. */
  exact: v.boolean(),
  issue: tally,
  initiative: v.union(tally, v.null()),
  /** Issues closed on `day` (UTC). The reader compares it with today; null when not counted yet. */
  closedToday: v.union(v.object({ day: v.string(), n: v.number() }), v.null()),
});
type Result = typeof planCountsResult.type;

/** One point read on the selected partition. Until the backfill completes, one capped page of Issue roots, marked
 * not exact, so a screen shows "N+" and never a bare capped figure. */
export async function planCounts(ctx: QueryCtx, projectId: Id<'hostedProjects'>): Promise<Result> {
  const observed = ctx;
  ctx = finishReadReader(ctx, 'plan');
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
  const project = await accessibleProject(ctx, projectId, user.subject);
  const generation = await selectedGeneration(ctx, project);
  if (!generation) return { exact: true, issue: reply({}), initiative: reply({}), closedToday: null };
  // A viewer without a role (a signed-in visitor of a public project) counts only the Items the one public rule
  // shows (Item 76be0714): the stored totals less every visibility group the rule hides; never the bare totals.
  if (!(await readProjectRole(ctx, project, user.subject))) {
    // The compact Plan header omits planning policy: the rule reads the current project row (one read).
    const current = await finishReadSourceDb(ctx).get(project._id);
    invariant(current, 'PROJECT_UNAVAILABLE', 'This project is unavailable.');
    // A members-only plan shows a visitor no Item: nothing to read.
    if (current.planVisibility === 'members')
      return { exact: true, issue: reply({}), initiative: null, closedToday: null };
    // The stored counter's visibility groups: one row plus the Initiatives and parents they name, never the roots.
    // This handler reduces the member-only row to the visitor rule itself, so it reads the row unobserved.
    const row = await visitorPlanCounter(finishReadSourceDb(observed), recordPartition(generation));
    const stored = row ? (JSON.parse(row.value) as PlanCounts) : null;
    if (stored?.done && stored.v === 2) return visitorCounts(ctx, current, stored);
    // Until this partition's backfill rebuilds its row with groups: the capped root page, filtered.
    const page = await planningPage(ctx, project, generation, {
      planningFilter: { kind: 'issue' },
      counts: true,
      roots: true,
      paginationOpts: { numItems: 1000, cursor: null },
    });
    const loaded = new Map<string, PublicPlanRoot>();
    for (const value of page.roots ?? []) {
      const root = JSON.parse(value) as PublicPlanRoot;
      if (typeof root.id === 'string') loaded.set(root.id, root);
    }
    const plan = publicWorkPlan(ctx, current, loaded);
    const counts: Record<string, number> = {};
    for (const [id, root] of loaded)
      if (typeof root.status === 'string' && (await plan.allowed(id)))
        counts[root.status] = (counts[root.status] ?? 0) + 1;
    return {
      exact: page.isDone && !page.coverage,
      issue: reply(counts as Partial<Tally>),
      initiative: null,
      closedToday: null,
    };
  }
  const row = await counter(ctx.db, recordPartition(generation));
  const counts = row ? (JSON.parse(row.value) as PlanCounts) : null;
  if (counts?.done)
    return {
      exact: true,
      issue: reply(counts.issue),
      initiative: reply(counts.initiative),
      closedToday: counts.day ? { day: counts.day, n: counts.closedToday } : null,
    };
  const page = await planningPage(ctx, project, generation, {
    planningFilter: { kind: 'issue' },
    counts: true,
    paginationOpts: { numItems: 1000, cursor: null },
  });
  return {
    exact: page.isDone && !page.coverage,
    issue: reply(page.counts ?? {}),
    initiative: null,
    closedToday: null,
  };
}

/** A visitor's Issue counts from the stored groups (Item 76be0714). The Issues in no group are public whenever the
 * plan is; a group counts when the one rule shows an Issue with its Initiative and parent; `h` never counts. */
async function visitorCounts(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  stored: PlanCounts,
): Promise<Result> {
  const plan = publicWorkPlan(ctx, project, new Map());
  const issue = { ...stored.issue };
  const groups = Object.entries(stored.g ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // Issues past the stored groups (`x`) are never counted for a visitor: the figures are then a lower bound.
  for (const [, tally] of [...groups, ['x', stored.x ?? []] as const])
    PLAN_STATUSES.forEach(
      (status, index) => (issue[status] = Math.max(0, issue[status] - (tally[index] ?? 0))),
    );
  if (!(await plan.rowAllowed({})))
    return { exact: true, issue: reply({}), initiative: null, closedToday: null };
  const named = new Set<string>();
  let exact = !stored.x;
  const counted: [string, number[]][] = [];
  for (const [key, tally] of groups) {
    if (key === 'h') continue;
    const ids = key.split('|').filter(id => id && !named.has(id));
    if (named.size + ids.length > VISITOR_COUNT_LOOKUPS) {
      exact = false;
      continue;
    }
    ids.forEach(id => named.add(id));
    counted.push([key, tally]);
  }
  const shown = await Promise.all(
    counted.map(([key]) => {
      const [initiativeId, parentId] = key.split('|');
      return plan.rowAllowed({ initiativeId: initiativeId || null, parentId: parentId || null });
    }),
  );
  counted.forEach(([, tally], index) => {
    if (shown[index]) PLAN_STATUSES.forEach((status, i) => (issue[status] += tally[i] ?? 0));
  });
  return { exact, issue: reply(issue), initiative: null, closedToday: null };
}

export const read = query({
  args: { projectId: v.id('hostedProjects') },
  returns: planCountsResult,
  handler: async (ctx, { projectId }) => {
    try {
      return await planCounts(ctx, projectId);
    } catch (error) {
      return report(error);
    }
  },
});

async function step(ctx: MutationCtx, project: Doc<'hostedProjects'>, restart: boolean) {
  const generation = await selectedGeneration(ctx, project);
  if (!generation) return { done: true, counted: 0 };
  const partition = recordPartition(generation);
  const row = await counter(ctx.db, partition);
  const parsed = row && !restart ? (JSON.parse(row.value) as PlanCounts) : null;
  // A version 1 row has no visibility groups: it is rebuilt from the start (members read the capped page meanwhile),
  // keeping today's closed count.
  const counts =
    parsed?.v === 2
      ? parsed
      : {
          ...emptyPlanCounts(false),
          ...(parsed ? { day: parsed.day, closedToday: parsed.closedToday } : {}),
        };
  if (counts.done) return { done: true, counted: 0 };
  const page = await ctx.db
    .query(await planningRecordTable(ctx, partition))
    .withIndex('by_generation_and_collection_and_key', q =>
      q
        .eq('generationId', partition)
        .eq('collection', 'planningSearch')
        .gt('key', counts.after ?? ''),
    )
    .paginate({
      cursor: null,
      numItems: PLAN_COUNTS_PAGE,
      maximumRowsRead: PLAN_COUNTS_PAGE,
      maximumBytesRead: 1_000_000,
    });
  for (const root of page.page) {
    const fact = facts(root);
    if (fact) {
      counts[fact.kind][fact.status]++;
      tallyGroup(counts, fact.group, fact.status, 1);
    }
    counts.after = root.key;
  }
  if (page.isDone) Object.assign(counts, { done: true, after: null });
  const value = JSON.stringify(counts);
  if (row) await ctx.db.patch(row._id, { value });
  else await ctx.db.insert('projectWorkDataRecords', { ...planCountsBirth(project._id, partition), value });
  return { done: counts.done, counted: page.page.length };
}

/** Counts one page of the selected partition's roots and schedules the next until done. Safe to call again at any
 * time: a complete counter returns at once, and a running one continues from the cursor stored in its row. */
export const backfill = internalMutation({
  args: { projectId: v.id('hostedProjects'), restart: v.optional(v.boolean()) },
  returns: v.object({ done: v.boolean(), counted: v.number() }),
  handler: async (ctx, { projectId, restart }) => {
    const project = await ctx.db.get(projectId);
    if (!project) return { done: true, counted: 0 };
    const result = await step(ctx, project, restart === true);
    if (!result.done) await ctx.scheduler.runAfter(0, internal.projectPlanCounts.backfill, { projectId });
    return result;
  },
});

/** Starts `backfill` for every project, 50 projects per transaction. Run once after deploy. */
export const backfillAll = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ scheduled: v.number(), isDone: v.boolean() }),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('hostedProjects').paginate({ cursor: cursor ?? null, numItems: 50 });
    for (const project of page.page)
      await ctx.scheduler.runAfter(0, internal.projectPlanCounts.backfill, { projectId: project._id });
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.projectPlanCounts.backfillAll, {
        cursor: page.continueCursor,
      });
    return { scheduled: page.page.length, isDone: page.isDone };
  },
});
