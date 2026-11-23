// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';

/** Item 411727ba row 3: Issue history, comments, Item bodies and Work events need only the generic
 * key/position/parent/actor indexes, so they belong in the 8-copy `projectWorkDataRecords` table
 * instead of the 17-copy planning table or the 11-copy core table. A partition records which layout
 * holds them in one small marker row: absent = legacy (the older tables), `copying` = legacy is read
 * and every write is mirrored into the data table, `cleaning` = the data table is read and written
 * while the stale legacy copies are deleted, `moved` = done. Every partition born after this change
 * starts `moved`; older ones move by projectWorkRecordMigration. */
const dataRoutedCollections = new Set(['planningItems', 'planningVersions', 'planningComments', 'events']);
export const isDataRouted = (collection: string) => dataRoutedCollections.has(collection);
export const dataRoutedList = [...dataRoutedCollections];
export type RecordLayout = 'legacy' | 'copying' | 'cleaning' | 'moved';
/** Reads and writes use the data table once the copy is complete. */
export const readsData = (layout: RecordLayout) => layout === 'cleaning' || layout === 'moved';
export const layoutCollection = '_workStoreLayout';
const layoutKey = 'tables';
type Ctx = Pick<QueryCtx | MutationCtx, 'db'>;
const cache = new WeakMap<object, Map<string, Promise<RecordLayout>>>();

function cached(db: object) {
  let entries = cache.get(db);
  if (!entries) cache.set(db, (entries = new Map()));
  return entries;
}
export function layoutMarker(ctx: Ctx, partition: Id<'projectWorkGenerations'>) {
  return ctx.db
    .query('projectWorkDataRecords')
    .withIndex('by_generation_and_collection_and_key', q =>
      q.eq('generationId', partition).eq('collection', layoutCollection).eq('key', layoutKey),
    )
    .unique();
}
/** One ~200-byte indexed read per transaction and partition, only when a moved collection is routed. */
export function partitionLayout(ctx: Ctx, partition: Id<'projectWorkGenerations'>): Promise<RecordLayout> {
  const entries = cached(ctx.db);
  let layout = entries.get(partition);
  if (!layout) {
    layout = layoutMarker(ctx, partition).then(row =>
      row ? (JSON.parse(row.value) as { layout: RecordLayout }).layout : 'legacy',
    );
    entries.set(partition, layout);
  }
  return layout;
}
/** The partition's layout if this transaction already read (or wrote) it. */
export const knownLayout = (db: object, partition: string) => cached(db).get(partition);
/** Records a layout this transaction just wrote, so later routing in it agrees with the marker. */
export function noteLayout(db: object, partition: string, layout: RecordLayout) {
  cached(db).set(partition, Promise.resolve(layout));
}
export function layoutMarkerFields(
  projectId: Id<'hostedProjects'>,
  partition: Id<'projectWorkGenerations'>,
  layout: RecordLayout,
) {
  return {
    projectId,
    generationId: partition,
    collection: layoutCollection,
    key: layoutKey,
    parent: '',
    position: 0,
    value: JSON.stringify({ layout }),
  };
}
/** Purges must reach every copy of the words and bypass the mirroring writer, so they wait out a
 * move (copy and cleanup) instead of leaving a second copy behind. */
export async function settledLayout(ctx: Ctx, partition: Id<'projectWorkGenerations'>) {
  const layout = await partitionLayout(ctx, partition);
  invariant(
    layout === 'legacy' || layout === 'moved',
    'WORK_STALE',
    'Work history storage is moving to a smaller table for this project. Retry in a few minutes. Nothing was changed.',
  );
  return layout;
}
