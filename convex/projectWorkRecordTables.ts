// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Id } from './_generated/dataModel';
import type { QueryCtx, MutationCtx } from './_generated/server';
import {
  isDataRouted,
  knownLayout,
  partitionLayout,
  readsData,
  settledLayout,
  type RecordLayout,
} from './projectWorkRecordLayout';

export const workRecordTables = [
  'projectWorkRecords',
  'projectPlanningRecords',
  'projectWorkDataRecords',
] as const;
export type WorkRecordTable = (typeof workRecordTables)[number];
type Context = Pick<QueryCtx | MutationCtx, 'db'>;
/** Payload, source and comparison rows need no activity, status or planning-filter indexes. This is
 * the legacy static route; Item history and Work events also follow their partition's layout. */
export function splitRecordTable(collection: string): WorkRecordTable {
  if (collection.startsWith('planningSearch')) return 'projectPlanningRecords';
  if (
    collection.endsWith(':payload') ||
    collection.startsWith('source') ||
    collection === 'viewFiles' ||
    collection.startsWith('_workStore')
  )
    return 'projectWorkDataRecords';
  return collection.startsWith('planning') ? 'projectPlanningRecords' : 'projectWorkRecords';
}
/** The table a layout reads for a collection: `copying` still reads the legacy table it mirrors. */
export function layoutRecordTable(layout: RecordLayout, collection: string): WorkRecordTable {
  return readsData(layout) && isDataRouted(collection)
    ? 'projectWorkDataRecords'
    : splitRecordTable(collection);
}
/** Static for most collections (no I/O); Item history and Work events read the partition's
 * layout marker once per transaction (Item 411727ba row 3). */
export async function workRecordTable(
  ctx: Context,
  generationId: Id<'projectWorkGenerations'>,
  collection: string,
): Promise<WorkRecordTable> {
  if (!isDataRouted(collection)) return splitRecordTable(collection);
  return layoutRecordTable(await partitionLayout(ctx, generationId), collection);
}
/** As workRecordTable, for purge paths: refuses while the partition's history is moving. */
export async function settledRecordTable(
  ctx: Context,
  generationId: Id<'projectWorkGenerations'>,
  collection: string,
): Promise<WorkRecordTable> {
  if (!isDataRouted(collection)) return splitRecordTable(collection);
  return layoutRecordTable(await settledLayout(ctx, generationId), collection);
}
export async function workRecordLookup(
  ctx: Context,
  generationId: Id<'projectWorkGenerations'>,
  collection: string,
  key: string,
) {
  const lookup = (table: WorkRecordTable) =>
    ctx.db
      .query(table)
      .withIndex('by_generation_and_collection_and_key', q =>
        q.eq('generationId', generationId).eq('collection', collection).eq('key', key),
      )
      .unique();
  // A moved row is found without the layout read: a data-table copy is always exact, because a
  // copying partition mirrors every write in both directions (projectWorkRecordWriter).
  const known = isDataRouted(collection) ? await knownLayout(ctx.db, generationId) : undefined;
  if (isDataRouted(collection) && (!known || known === 'copying')) {
    const moved = await lookup('projectWorkDataRecords');
    if (moved || readsData(await partitionLayout(ctx, generationId))) return moved;
    return lookup(splitRecordTable(collection));
  }
  return lookup(await workRecordTable(ctx, generationId, collection));
}
export async function planningRecordTable(
  _ctx: Context,
  _generationId: Id<'projectWorkGenerations'>,
): Promise<'projectPlanningRecords'> {
  return 'projectPlanningRecords';
}
