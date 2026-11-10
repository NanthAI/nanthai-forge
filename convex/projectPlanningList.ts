// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { PaginationOptions } from 'convex/server';
import { record, recordPartition } from './projectWorkIndexStore';
import { hostedRecordValue } from './hostedRecordValue';
import { readsStore, storeItem } from './projectWorkStoreReads';

export const planningFilter = v.object({
  kind: v.optional(v.union(v.literal('issue'), v.literal('initiative'))),
  status: v.optional(
    v.union(
      v.literal('proposed'),
      v.literal('open'),
      v.literal('in-progress'),
      v.literal('closed'),
      v.literal('abandoned'),
    ),
  ),
  initiativeId: v.optional(v.string()),
});
type Filter = { kind?: 'issue' | 'initiative'; status?: string; initiativeId?: string };

/** Search roots already carry all three filters, including on pre-deploy rows. Ordinary indexes
 * read only matching roots, without text-search billing, fragments, a backfill or extra writes. */
function matching(ctx: QueryCtx, generationId: Id<'projectWorkGenerations'>, filter: Filter) {
  const rows = ctx.db.query('projectWorkRecords');
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

/** One bounded DB page. Counts inspect root metadata only; lists hydrate only their matching items.
 * Current record-store readers keep exact item bytes and reconciliation inputs, including long bodies. */
export async function planningPage(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  generation: Doc<'projectWorkGenerations'>,
  input: {
    planningFilter: Filter;
    counts?: boolean;
    newestFirst?: boolean;
    paginationOpts: PaginationOptions;
  },
) {
  const partition = recordPartition(generation);
  const page = await matching(ctx, partition, input.planningFilter)
    .order(input.newestFirst ? 'desc' : 'asc')
    .paginate({
      ...input.paginationOpts,
      numItems: input.counts ? 1000 : Math.min(input.paginationOpts.numItems, 100),
      maximumRowsRead: input.counts ? 1000 : 100,
      maximumBytesRead: 1000000,
    });
  const counts = { proposed: 0, open: 0, 'in-progress': 0, closed: 0, abandoned: 0 };
  const rows: { id: string; position: number; value: unknown }[] = [];
  for (const root of page.page) {
    if (input.counts) {
      const status = root.planning!.status as keyof typeof counts;
      counts[status]++;
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
    page: rows,
    ...(input.counts
      ? {
          counts,
          ...(generation.planningSearchVersion === 2 ? {} : { coverage: 'partial-needs-preparation' }),
        }
      : {}),
  };
}
