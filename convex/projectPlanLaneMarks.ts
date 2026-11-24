// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { PlanRow } from '../src/planning-model';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { workRecordLookup } from './projectWorkRecordTables';
import { invariant } from '../src/errors';

const kind = (status: string) => `plan-item-lanes:${status}`;
type Source = { id: string; status: string; kind: string; purged?: unknown };
type Placement = Pick<Source, 'id' | 'status'> & { position: number };
type MarkId = Id<'projectFinishReadRows'>;
type LifecycleId = Id<'projectHostedLifecyclePlans'>;
type Count = { open: number; cascades?: Record<string, number> };
const countOf = (row: Pick<Doc<'projectFinishReadRows'>, 'value'>): Count => JSON.parse(row.value);
const applied = -1;
type ProjectId = Id<'hostedProjects'>;
const source = (projectId: ProjectId, itemId: string) => `${projectId}:${itemId}`;
const lookup = (ctx: QueryCtx, projectId: ProjectId, item: Pick<Source, 'id' | 'status'>) =>
  ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_source', q =>
      q.eq('kind', kind(item.status)).eq('sourceId', source(projectId, item.id)),
    )
    .unique();

/** A roll-up needs the same open-work fact as the Plan, without enumerating finished Intents. */
export async function planItemOpenLaneMark(
  ctx: QueryCtx,
  projectId: ProjectId,
  item: Pick<Source, 'id' | 'status'>,
) {
  const row = await lookup(ctx, projectId, item);
  return row ? { id: row._id, open: countOf(row).open } : null;
}

/** A compact count row is shared only by Lanes serving the same Item. The Lane retains this row's id,
 * so ending a Lane needs one bounded point read and one write, with no planning generation lookup. */
export async function addPlanLane(ctx: MutationCtx, projectId: ProjectId, item: Placement, count = 1) {
  const old = await lookup(ctx, projectId, item);
  if (old) {
    const value = countOf(old);
    await ctx.db.patch(old._id, { value: JSON.stringify({ ...value, open: value.open + count }) });
    return old._id;
  }
  return await ctx.db.insert('projectFinishReadRows', {
    kind: kind(item.status),
    projectId,
    sourceId: source(projectId, item.id),
    sourceCreatedAt: item.position,
    value: JSON.stringify({ open: count }),
  });
}

async function writeCount(ctx: MutationCtx, id: MarkId, open: number, cascades: Record<string, number>) {
  if (Object.keys(cascades).length) {
    await ctx.db.patch(id, { value: JSON.stringify({ open, cascades }) });
  } else if (open) {
    await ctx.db.patch(id, { value: JSON.stringify({ open }) });
  } else {
    await ctx.db.delete(id);
  }
}

export async function removePlanLanes(ctx: MutationCtx, id: MarkId, planIds: (LifecycleId | undefined)[]) {
  const old = await ctx.db.get(id);
  if (!old) return;
  const { open, cascades = {} } = countOf(old);
  let removed = 0;
  for (const planId of planIds) {
    const staged = planId && cascades[planId];
    // The row already excludes Lanes of an applied cascade, even before materialization.
    if (staged === applied) continue;
    if (planId && staged) cascades[planId] = staged - 1;
    removed++;
  }
  if (removed) await writeCount(ctx, id, Math.max(0, open - removed), cascades);
}

export async function changePlanLaneCascade(
  ctx: MutationCtx,
  id: MarkId,
  planId: LifecycleId,
  change: number | 'apply' | 'clear',
) {
  const old = await ctx.db.get(id);
  if (!old) return;
  const { open, cascades = {} } = countOf(old);
  const staged = cascades[planId] ?? 0;
  if (change === 'clear') {
    delete cascades[planId];
  } else if (change === 'apply') {
    if (staged === applied) return;
    cascades[planId] = applied;
    await writeCount(ctx, id, Math.max(0, open - staged), cascades);
    return;
  } else {
    cascades[planId] = staged + change;
  }
  await writeCount(ctx, id, open, cascades);
}

export async function planLaneItem(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  itemId: string,
  starting = false,
  partition?: Id<'projectWorkGenerations'>,
): Promise<Placement | null> {
  if (!itemId) return null; // The Intent was explicitly created independently.
  if (!partition) {
    const generation = await selectedGeneration(ctx, project);
    if (!generation) return null;
    partition = recordPartition(generation);
  }
  const root = await workRecordLookup(ctx, partition, 'planningSearch', itemId);
  if (!root) return null;
  const item = JSON.parse(root.value) as Source;
  invariant(
    !starting || (!item.purged && item.status !== 'deleted'),
    'INTENT_CLOSED',
    'A deleted Item cannot start work.',
  );
  return item.kind === 'issue' && !item.purged ? { ...item, position: root.position } : null;
}

/** Status edits move the existing count row without changing its id. Purging an Item removes the
 * association, while Archive and Delete retain it for Restore. */
export async function movePlanLaneMark(
  ctx: MutationCtx,
  projectId: ProjectId,
  previous: Source | null,
  next: Source,
) {
  if (!previous || previous.kind !== 'issue' || (previous.status === next.status && !next.purged)) return;
  const old = await lookup(ctx, projectId, previous);
  if (!old) return;
  if (next.purged) await ctx.db.delete(old._id);
  else await ctx.db.patch(old._id, { kind: kind(next.status) });
}

/** The source-time index uses Item position, so marks for work beyond the Plan page cannot displace
 * marks on the page. Only count rows are read, up to the number of Items in the existing response. */
export async function markPlanPage(ctx: QueryCtx, projectId: ProjectId, status: string, rows: PlanRow[]) {
  if (!rows.length) return rows;
  const prefix = `${projectId}:`;
  const range = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_project_and_source_time', q =>
      q.eq('kind', kind(status)).eq('projectId', projectId).lte('sourceCreatedAt', rows.at(-1)!.position),
    )
    .take(rows.length);
  const marked = new Set(
    range.filter(mark => countOf(mark).open > 0).map(mark => mark.sourceId.slice(prefix.length)),
  );
  return rows.map(row => (marked.has(row.id) ? { ...row, inLane: true } : row));
}
