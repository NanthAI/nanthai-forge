// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import {
  addRollupCounts,
  emptyRollupCounts,
  rollupMembershipChanges,
  type RollupScope,
} from '../src/planning-rollup-membership';
import type { RollupCounts } from '../src/planning-rollup';

const COLLECTION = '_workStorePlanRollup';
type Scope = { projectId: Id<'hostedProjects'>; partition: Id<'projectWorkGenerations'> };
type Branch = Pick<RollupCounts, 'unsettled' | 'progress' | 'started'>;
type State = { counts: RollupCounts; effective?: RollupCounts; forwarded?: Branch };

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
    if (!state.counts.total && !state.forwarded) await db.delete(previous.row._id);
    else if (previous.row.value !== value) await db.patch(previous.row._id, { value });
  } else if (state.counts.total || state.forwarded) {
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
  effectiveChanges: ReadonlyMap<RollupScope, RollupCounts> = changes,
  read = (key: RollupScope) => rollupScope(db, scope.partition, key),
) {
  const touched = await Promise.all(
    [...new Set([...changes.keys(), ...effectiveChanges.keys()])].map(async key => {
      const direct = changes.get(key);
      const inherited = effectiveChanges.get(key);
      if (![direct, inherited].some(delta => delta && Object.values(delta).some(Boolean))) return null;
      const previous = await read(key);
      const counts = { ...previous.counts };
      const effective = { ...(previous.effective ?? previous.counts) };
      if (direct) addRollupCounts(counts, direct);
      if (inherited) addRollupCounts(effective, inherited);
      return { key, previous, counts, effective };
    }),
  );
  if (touched.some(step => step && (!validCounts(step.counts) || !validCounts(step.effective)))) return false;
  for (const step of touched) {
    if (!step) continue;
    const { key, previous, counts, effective } = step;
    await writeScope(db, scope, key, previous, {
      counts,
      ...(Object.keys(counts).some(
        k => counts[k as keyof RollupCounts] !== effective[k as keyof RollupCounts],
      )
        ? { effective }
        : {}),
      ...(previous.forwarded ? { forwarded: previous.forwarded } : {}),
    });
  }
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

export async function readRollupBranch(db: QueryCtx['db'], partition: Scope['partition'], itemId: string) {
  return rollupScope(db, partition, `parent:${itemId}`);
}

/** Store what the next parent consumed. A later re-parent uses this retained contribution, not newer unstamped facts. */
export async function publishRollupBranches(
  db: MutationCtx['db'],
  scope: Scope,
  updates: readonly {
    item: NonNullable<Parameters<typeof rollupMembershipChanges>[0]> & { id: string };
    previous: Awaited<ReturnType<typeof readRollupBranch>>;
    next: Branch;
  }[],
) {
  const changed = updates.filter(
    ({ previous: { forwarded: before }, next }) =>
      next.unsettled !== (before?.unsettled ?? 0) ||
      next.progress !== (before?.progress ?? 0) ||
      next.started !== (before?.started ?? 0),
  );
  const combined = new Map<RollupScope, RollupCounts>();
  for (const { item, previous, next } of changed) {
    for (const [key, delta] of rollupMembershipChanges(item, item, previous.forwarded, next)) {
      let total = combined.get(key);
      if (!total) combined.set(key, (total = emptyRollupCounts()));
      addRollupCounts(total, delta);
    }
  }
  if (!(await applyRollupDeltas(db, scope, new Map(), combined))) return null;
  for (const { item, previous, next } of changed)
    await writeScope(db, scope, `parent:${item.id}`, previous, {
      counts: previous.counts,
      ...(previous.effective ? { effective: previous.effective } : {}),
      ...(next.unsettled || next.progress || next.started ? { forwarded: next } : {}),
    });
  return combined.size > 0;
}

/** One indexed point after the parent writer proved complete coverage from the selected Plan metadata.
 * No siblings are read. A missing sparse row is zero only when coverage was proved. */
export async function readRollupScope(
  db: QueryCtx['db'],
  partition: Scope['partition'],
  scope: RollupScope,
  complete: boolean,
  effective?: true,
): Promise<RollupCounts | null> {
  if (!complete) return null;
  const row = await rollupScope(db, partition, scope);
  return (effective && row.effective) || row.counts;
}
