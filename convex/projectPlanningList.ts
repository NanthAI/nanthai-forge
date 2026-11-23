// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { planningRecordTable } from './projectWorkRecordTables';
import { v, type Infer } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { PaginationOptions } from 'convex/server';
import { record, recordPartition } from './projectWorkIndexStore';
import { hostedRecordValue } from './hostedRecordValue';
import { readsStore, storeItem } from './projectWorkStoreReads';
import { planningWaitingKinds } from '../src/work-planning-types';
import {
  coveredInitiativeTallies,
  planCounter,
  PLAN_STATUSES,
  zeroTally,
  type PlanCounts,
} from './projectPlanCountsStore';

export const planningFilter = v.object({
  kind: v.optional(v.union(v.literal('issue'), v.literal('initiative'))),
  status: v.optional(
    v.union(
      v.literal('proposed'),
      v.literal('open'),
      v.literal('in-progress'),
      v.literal('closed'),
      v.literal('abandoned'),
      v.literal('archived'),
      v.literal('deleted'),
    ),
  ),
  initiativeId: v.optional(v.string()),
  waitingOn: v.optional(v.union(v.literal('none'), ...planningWaitingKinds.map(kind => v.literal(kind)))),
});
type Filter = Infer<typeof planningFilter>;

/** Search roots already carry all three filters, including on pre-deploy rows. Ordinary indexes
 * read only matching roots, without text-search billing, fragments, a backfill or extra writes. */
async function matchingSelectors(ctx: QueryCtx, generationId: Id<'projectWorkGenerations'>, filter: Filter) {
  const rows = ctx.db.query(await planningRecordTable(ctx, generationId));
  if (filter.initiativeId !== undefined && filter.kind !== undefined && filter.status !== undefined)
    return rows.withIndex('by_planning_initiativeId_and_kind_and_status', q =>
      q
        .eq('generationId', generationId)
        .eq('collection', 'planningSearch')
        .eq('planning.initiativeId', filter.initiativeId!)
        .eq('planning.kind', filter.kind!)
        .eq('planning.status', filter.status!),
    );
  if (filter.initiativeId !== undefined && filter.kind !== undefined)
    return rows.withIndex('by_planning_initiativeId_and_kind', q =>
      q
        .eq('generationId', generationId)
        .eq('collection', 'planningSearch')
        .eq('planning.initiativeId', filter.initiativeId!)
        .eq('planning.kind', filter.kind!),
    );
  if (filter.initiativeId !== undefined && filter.status !== undefined)
    return rows.withIndex('by_planning_initiativeId_and_status', q =>
      q
        .eq('generationId', generationId)
        .eq('collection', 'planningSearch')
        .eq('planning.initiativeId', filter.initiativeId!)
        .eq('planning.status', filter.status!),
    );
  if (filter.kind !== undefined && filter.status !== undefined)
    return rows.withIndex('by_planning_kind_and_status', q =>
      q
        .eq('generationId', generationId)
        .eq('collection', 'planningSearch')
        .eq('planning.kind', filter.kind!)
        .eq('planning.status', filter.status!),
    );
  if (filter.initiativeId !== undefined)
    return rows.withIndex('by_planning_initiativeId', q =>
      q
        .eq('generationId', generationId)
        .eq('collection', 'planningSearch')
        .eq('planning.initiativeId', filter.initiativeId!),
    );
  if (filter.kind !== undefined)
    return rows.withIndex('by_planning_kind', q =>
      q.eq('generationId', generationId).eq('collection', 'planningSearch').eq('planning.kind', filter.kind!),
    );
  if (filter.status !== undefined)
    return rows.withIndex('by_planning_status', q =>
      q
        .eq('generationId', generationId)
        .eq('collection', 'planningSearch')
        .eq('planning.status', filter.status!),
    );
  return rows.withIndex('by_generation_and_collection_and_position', q =>
    q.eq('generationId', generationId).eq('collection', 'planningSearch'),
  );
}

async function matching(ctx: QueryCtx, generationId: Id<'projectWorkGenerations'>, filter: Filter) {
  const { waitingOn, kind, status, initiativeId } = filter;
  if (waitingOn === undefined) return matchingSelectors(ctx, generationId, filter);
  // When no wait reason is the common case, use a supplied selector's index before testing absence.
  if (waitingOn === 'none' && (kind || status || initiativeId !== undefined))
    return (await matchingSelectors(ctx, generationId, filter)).filter(q => q.eq(q.field('parent'), ''));
  const rows = ctx.db
    .query(await planningRecordTable(ctx, generationId))
    .withIndex('by_generation_and_collection_and_parent_and_position', q =>
      q
        .eq('generationId', generationId)
        .eq('collection', 'planningSearch')
        .eq('parent', waitingOn === 'none' ? '' : waitingOn),
    );
  if (!kind && !status && initiativeId === undefined) return rows;
  // These predicates refine only the selected bucket, within the existing per-page rows and bytes limits.
  const selectors = [
    ['planning.kind', kind],
    ['planning.status', status],
    ['planning.initiativeId', initiativeId],
  ] as const;
  return rows.filter(q =>
    q.and(
      ...selectors.flatMap(([field, value]) => (value === undefined ? [] : [q.eq(q.field(field), value)])),
    ),
  );
}

/** The existing Plan counter can answer an Initiative from one row when every Issue's group is known.
 * Hidden Issues and overflow groups discard the Initiative ID. Use the indexed roots in those cases. */
export async function countedInitiative(
  ctx: QueryCtx,
  generation: Doc<'projectWorkGenerations'>,
  filter: Filter,
  cursor: string | null,
) {
  const { initiativeId, kind, status, waitingOn } = filter;
  if (
    !initiativeId ||
    kind === 'initiative' ||
    status ||
    waitingOn ||
    cursor !== null ||
    generation.planningSearchVersion !== 2
  )
    return null;
  const tallies = await coveredInitiativeTallies(ctx.db, recordPartition(generation));
  if (!tallies) return null;
  const counts = tallies.get(initiativeId) ?? zeroTally();
  return { counts, page: [], isDone: true, continueCursor: '' };
}

/** A first count page answered from the exact Plan counter (Item 3fa3187d) instead of every root: Item 411727ba
 * measured an unfiltered `planning {counts:true}` at four ~1 MB root pages on the dogfood board. The counter tallies
 * the five Plan statuses per kind in the transaction of each status move; Archived and Deleted, which it leaves out,
 * are counted from their own indexed roots. A viewer without a role, an Initiative or waiting filter, a continued
 * cursor, an unprepared search index, a counter still backfilling or a shelf past one page keeps the root scan. */
async function counterCounts(
  ctx: QueryCtx,
  generation: Doc<'projectWorkGenerations'>,
  filter: Filter,
  counts: Record<(typeof PLAN_STATUSES)[number] | 'archived' | 'deleted', number>,
) {
  if (
    filter.initiativeId !== undefined ||
    filter.waitingOn !== undefined ||
    generation.planningSearchVersion !== 2
  )
    return false;
  const partition = recordPartition(generation);
  const row = await planCounter(ctx.db, partition);
  const stored = row ? (JSON.parse(row.value) as PlanCounts) : null;
  if (!stored?.done) return false;
  const kinds: ('issue' | 'initiative')[] = filter.kind ? [filter.kind] : ['issue', 'initiative'];
  const found: Partial<typeof counts> = {};
  for (const status of PLAN_STATUSES)
    if (!filter.status || filter.status === status)
      found[status] = kinds.reduce((sum, kind) => sum + stored[kind][status], 0);
  for (const status of ['archived', 'deleted'] as const) {
    if (filter.status && filter.status !== status) continue;
    const shelf = await (
      await matchingSelectors(ctx, partition, { ...filter, status })
    ).paginate({ cursor: null, numItems: 1000, maximumRowsRead: 1000, maximumBytesRead: 1000000 });
    if (!shelf.isDone) return false;
    found[status] = shelf.page.length;
  }
  Object.assign(counts, found);
  return true;
}

/** One bounded DB page. Counts inspect root metadata only; lists hydrate only their matching items.
 * Current record-store readers keep exact item bytes and reconciliation inputs, including long bodies. */
export async function planningPage(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  generation: Doc<'projectWorkGenerations'>,
  input: {
    planningFilter: Filter;
    counts?: boolean;
    /** With `counts`: also return the roots counted (their stored values), for a per-row visibility count. */
    roots?: boolean;
    /** With `counts`: the viewer has a project role, so the member-only Plan counter may answer. */
    members?: boolean;
    newestFirst?: boolean;
    paginationOpts: PaginationOptions;
  },
) {
  const partition = recordPartition(generation);
  const counts = { proposed: 0, open: 0, 'in-progress': 0, closed: 0, abandoned: 0, archived: 0, deleted: 0 };
  const counted =
    input.counts &&
    input.members &&
    !input.roots &&
    !input.paginationOpts.cursor &&
    (await counterCounts(ctx, generation, input.planningFilter, counts));
  const page = counted
    ? { page: [], isDone: true, continueCursor: '' }
    : await (
        await matching(ctx, partition, input.planningFilter)
      )
        .order(input.newestFirst ? 'desc' : 'asc')
        .paginate({
          ...input.paginationOpts,
          numItems: input.counts ? 1000 : Math.min(input.paginationOpts.numItems, 100),
          maximumRowsRead: input.counts ? 1000 : 100,
          maximumBytesRead: 1000000,
        });
  const rows: { id: string; position: number; value: unknown }[] = [];
  const roots: string[] = [];
  for (const root of page.page) {
    if (input.counts) {
      const status = root.planning!.status as keyof typeof counts;
      counts[status]++;
      if (input.roots)
        roots.push(
          root.planningClose || root.planningRestored
            ? JSON.stringify({
                ...JSON.parse(root.value),
                planningClose: root.planningClose,
                planningRestored: root.planningRestored,
              })
            : root.value,
        );
      continue;
    }
    const stored = readsStore(project, 'planningItems');
    const row = stored ? null : await record(ctx, partition, 'planningItems', root.key);
    const value = stored
      ? await storeItem(ctx, project._id, root.key)
      : row
        ? JSON.parse(await hostedRecordValue(ctx, partition, row))
        : null;
    if (value) rows.push({ id: root.key, position: root.position, value });
  }
  return {
    ...page,
    ...(input.counts && input.roots ? { roots } : {}),
    page: rows,
    ...(input.counts
      ? {
          // Archived and Deleted keys appear only when counted, so older replies stay byte-identical.
          counts: Object.fromEntries(
            Object.entries(counts).filter(
              ([status, count]) => count > 0 || (status !== 'archived' && status !== 'deleted'),
            ),
          ),
          ...(generation.planningSearchVersion === 2 ? {} : { coverage: 'partial-needs-preparation' }),
        }
      : {}),
  };
}
