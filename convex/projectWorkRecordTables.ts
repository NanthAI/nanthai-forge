// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Id } from './_generated/dataModel';
import type { QueryCtx, MutationCtx } from './_generated/server';

export const workRecordTables = [
  'projectWorkRecords',
  'projectPlanningRecords',
  'projectWorkDataRecords',
] as const;
export type WorkRecordTable = (typeof workRecordTables)[number];
type Context = Pick<QueryCtx | MutationCtx, 'db'>;
/** Item history (Items, versions, comments) and Work events need only the generic key, position,
 * parent and actor indexes, so they live in the 8-copy data table, as do payload, source and
 * comparison rows. Planning search roots live in the planning table, everything else in the core
 * table. The table follows the collection alone: no partition keeps an older layout. */
const dataCollections = new Set(['planningItems', 'planningVersions', 'planningComments', 'events']);
export const isHistoryCollection = (collection: string) => dataCollections.has(collection);
export function splitRecordTable(collection: string): WorkRecordTable {
  if (dataCollections.has(collection)) return 'projectWorkDataRecords';
  if (collection.startsWith('planningSearch')) return 'projectPlanningRecords';
  if (
    collection.endsWith(':payload') ||
    collection.startsWith('source') ||
    collection.startsWith('_workStore')
  )
    return 'projectWorkDataRecords';
  return collection.startsWith('planning') ? 'projectPlanningRecords' : 'projectWorkRecords';
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
