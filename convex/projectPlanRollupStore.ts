// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { addRollupCounts, emptyRollupCounts, type RollupScope } from '../src/planning-rollup-membership';
import type { RollupCounts } from '../src/planning-rollup';

const COLLECTION = '_workStorePlanRollup';
type Scope = { projectId: Id<'hostedProjects'>; partition: Id<'projectWorkGenerations'> };
type State = { counts: RollupCounts };

const find = (db: QueryCtx['db'], partition: Scope['partition'], key: string) =>
  db
    .query('projectWorkDataRecords')
    .withIndex('by_generation_and_collection_and_key', q =>
      q.eq('generationId', partition).eq('collection', COLLECTION).eq('key', key),
    )
    .unique();

async function rollupScope(db: QueryCtx['db'], partition: Scope['partition'], key: RollupScope) {
  const row = await find(db, partition, key);
  const state: State = row ? JSON.parse(row.value) : { counts: emptyRollupCounts() };
  return { row, ...state };
}

async function writeScope(
  db: MutationCtx['db'],
  scope: Scope,
  key: RollupScope,
  previous: Awaited<ReturnType<typeof rollupScope>>,
  state: State,
) {
  const value = JSON.stringify(state);
  if (previous.row) {
    if (!state.counts.total) await db.delete(previous.row._id);
    else if (previous.row.value !== value) await db.patch(previous.row._id, { value });
  } else if (state.counts.total) {
    await db.insert('projectWorkDataRecords', {
      projectId: scope.projectId,
      generationId: scope.partition,
      collection: COLLECTION,
      key,
      parent: '',
      position: 0,
      value,
    });
  }
}

const validCounts = (c: RollupCounts) =>
  Object.values(c).every(n => Number.isSafeInteger(n) && n >= 0 && n <= c.total) && c.progress <= c.started;

/** All point reads and validation precede the writes. A broken counter cannot be interpreted as zero
 * or give permission to close; the caller invalidates coverage and leaves the user's write intact. */
export async function applyRollupDeltas(
  db: MutationCtx['db'],
  scope: Scope,
  changes: ReadonlyMap<RollupScope, RollupCounts>,
  read = (key: RollupScope) => rollupScope(db, scope.partition, key),
) {
  const touched = await Promise.all(
    [...changes]
      .filter(([, delta]) => Object.values(delta).some(Boolean))
      .map(async ([key, delta]) => {
        const previous = await read(key);
        const counts = { ...previous.counts };
        addRollupCounts(counts, delta);
        return { key, previous, counts };
      }),
  );
  if (touched.some(({ counts }) => !validCounts(counts))) return false;
  for (const { key, previous, counts } of touched) await writeScope(db, scope, key, previous, { counts });
  return true;
}

/** Reuse a scope point read if its row will also be updated at the end of the same mutation. */
export function rollupScopeReads(db: QueryCtx['db']) {
  const cached = new Map<string, ReturnType<typeof rollupScope>>();
  return {
    read(partition: Scope['partition'], key: RollupScope) {
      const id = `${partition}/${key}`;
      const row = cached.get(id) ?? rollupScope(db, partition, key);
      cached.set(id, row);
      return row;
    },
    clear: () => cached.clear(),
  };
}

/** One indexed point after the parent writer proved complete coverage from the selected Plan metadata.
 * No siblings are read. A missing sparse row is zero only when coverage was proved. */
export async function readRollupScope(
  db: QueryCtx['db'],
  partition: Scope['partition'],
  scope: RollupScope,
  complete: boolean,
): Promise<RollupCounts | null> {
  return complete ? (await rollupScope(db, partition, scope)).counts : null;
}
