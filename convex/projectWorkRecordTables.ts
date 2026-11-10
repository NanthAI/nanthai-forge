// SPDX-License-Identifier: Apache-2.0
import type { Id } from './_generated/dataModel';
import type { QueryCtx, MutationCtx } from './_generated/server';

export const workRecordTables = [
  'projectWorkRecords',
  'projectPlanningRecords',
  'projectWorkDataRecords',
] as const;
export type WorkRecordTable = (typeof workRecordTables)[number];
type Context = Pick<QueryCtx | MutationCtx, 'db'>;
/** Payload, source and comparison rows need no activity, status or planning-filter indexes. */
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
/** Every published partition uses the split layout; routing performs no database I/O. */
export async function workRecordTable(
  _ctx: Context,
  _generationId: Id<'projectWorkGenerations'>,
  collection: string,
): Promise<WorkRecordTable> {
  return splitRecordTable(collection);
}
export async function workRecordLookup(
  ctx: Context,
  generationId: Id<'projectWorkGenerations'>,
  collection: string,
  key: string,
) {
  return ctx.db
    .query(splitRecordTable(collection))
    .withIndex('by_generation_and_collection_and_key', q =>
      q.eq('generationId', generationId).eq('collection', collection).eq('key', key),
    )
    .unique();
}
export async function planningRecordTable(
  _ctx: Context,
  _generationId: Id<'projectWorkGenerations'>,
): Promise<'projectPlanningRecords'> {
  return 'projectPlanningRecords';
}
