// SPDX-License-Identifier: Apache-2.0
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx, MutationCtx } from './_generated/server';

export const workRecordTables = [
  'projectWorkRecords',
  'projectPlanningRecords',
  'projectWorkDataRecords',
] as const;
export type WorkRecordTable = (typeof workRecordTables)[number];
type Context = Pick<QueryCtx | MutationCtx, 'db'>;
type Layout = Doc<'projectWorkGenerations'>['recordTables'];
const layouts = new WeakMap<object, Map<string, Promise<Layout>>>();
function cache(ctx: Context) {
  let values = layouts.get(ctx.db);
  if (!values) layouts.set(ctx.db, (values = new Map()));
  return values;
}
export function rememberRecordTables(ctx: Context, generation: Doc<'projectWorkGenerations'>) {
  // A return wrapper can share the old partition. Its layout belongs to the partition, not the wrapper.
  if (!generation.recordsGenerationId)
    cache(ctx).set(generation._id, Promise.resolve(generation.recordTables));
}
export function recordTablesLayout(ctx: Context, generationId: Id<'projectWorkGenerations'>) {
  const values = cache(ctx);
  let value = values.get(generationId);
  if (!value) {
    value = ctx.db.get(generationId).then(row => row?.recordTables);
    values.set(generationId, value);
  }
  return value;
}
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
export async function workRecordTable(
  ctx: Context,
  generationId: Id<'projectWorkGenerations'>,
  collection: string,
): Promise<WorkRecordTable> {
  const target = splitRecordTable(collection);
  if (target === 'projectWorkRecords') return target;
  return (await recordTablesLayout(ctx, generationId)) === 'split' ? target : 'projectWorkRecords';
}
/** One cached layout read per transaction at most; current-generation readers seed it for free. */
export async function workRecordLookup(
  ctx: Context,
  generationId: Id<'projectWorkGenerations'>,
  collection: string,
  key: string,
) {
  const target = splitRecordTable(collection);
  const layout = target === 'projectWorkRecords' ? undefined : await recordTablesLayout(ctx, generationId);
  const lookup = (table: WorkRecordTable) =>
    ctx.db
      .query(table)
      .withIndex('by_generation_and_collection_and_key', q =>
        q.eq('generationId', generationId).eq('collection', collection).eq('key', key),
      )
      .unique();
  if (layout === 'copying' || layout === 'split') {
    const row = await lookup(target);
    if (row || layout === 'split') return row;
  }
  return lookup('projectWorkRecords');
}

export async function planningRecordTable(
  ctx: Context,
  generationId: Id<'projectWorkGenerations'>,
): Promise<'projectWorkRecords' | 'projectPlanningRecords'> {
  return (await recordTablesLayout(ctx, generationId)) === 'split'
    ? 'projectPlanningRecords'
    : 'projectWorkRecords';
}
export function shareRecordTableCache(source: Context['db'], target: Context['db']) {
  layouts.set(target, cache({ db: source }));
}
