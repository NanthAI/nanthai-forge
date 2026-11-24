// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { PlanningItem } from '../src/work-planning-types';

// Disposable projection, excluded from source-return snapshots just like other _workStore rows.
export const planningInbound = (epoch: string) => `_workStorePlanningInbound:${epoch}`;
const inboundParent = (itemId: string, shelved: boolean) => `${shelved ? 'shelf' : 'live'}:${itemId}`;
const MAX_TARGETS = 20;
type Root = Pick<
  Doc<'projectPlanningRecords'>,
  'projectId' | 'generationId' | 'collection' | 'key' | 'position' | 'value'
>;
function edges(root: Root | null) {
  if (root?.collection !== 'planningSearch') return new Map<string, string>();
  const item = JSON.parse(root.value) as Pick<PlanningItem, 'kind' | 'purged' | 'status' | 'relations'>;
  if (item.kind !== 'issue' || item.purged) return new Map<string, string>();
  const shelved = item.status === 'archived' || item.status === 'deleted';
  return new Map(
    item.relations
      ?.filter(relation => relation.id !== root.key)
      .map(relation => [`${root.key}:${relation.id}`, inboundParent(relation.id, shelved)]),
  );
}

async function reconcile(db: MutationCtx['db'], root: Root, epoch: string, next: Map<string, string>) {
  const { generationId, projectId, position, key: source } = root;
  const collection = planningInbound(epoch);
  const old = await db
    .query('projectWorkDataRecords')
    .withIndex('by_generation_and_collection_and_key', q =>
      q
        .eq('generationId', generationId)
        .eq('collection', collection)
        .gte('key', `${source}:`)
        .lt('key', `${source}:\uffff`),
    )
    .take(MAX_TARGETS);
  for (const row of old) {
    const parent = next.get(row.key);
    if (parent === undefined) await db.delete(row._id);
    else {
      next.delete(row.key);
      if (parent !== row.parent || position !== row.position) await db.patch(row._id, { parent, position });
    }
  }
  for (const [key, parent] of next)
    await db.insert('projectWorkDataRecords', {
      projectId,
      generationId,
      collection,
      key,
      parent,
      position,
      value: '',
    });
}

export async function changePlanningInbound(
  db: MutationCtx['db'],
  before: Root | null,
  after: Root | null,
  epochOf: (id: Id<'projectWorkGenerations'>) => Promise<string | null>,
) {
  if (before && after && (before.key !== after.key || before.generationId !== after.generationId)) {
    await changePlanningInbound(db, before, null, epochOf);
    await changePlanningInbound(db, null, after, epochOf);
    return;
  }
  const source = after ?? before;
  if (!source || (before?.value === after?.value && before?.position === after?.position)) return;
  const was = edges(before);
  const next = edges(after);
  if (
    was.size === next.size &&
    (!next.size || before?.position === after?.position) &&
    [...was].every(([key, parent]) => next.get(key) === parent)
  )
    return;
  const epoch = await epochOf(source.generationId);
  if (epoch !== null) await reconcile(db, source, epoch, next);
}

/** Owners merge the two ordered ranges; a reader never touches the shelved range. */
export async function* inboundPointers(
  ctx: QueryCtx,
  partition: Id<'projectWorkGenerations'>,
  epoch: string,
  itemId: string,
  position: number | undefined,
  owner: boolean,
) {
  const stream = (shelved: boolean) =>
    ctx.db
      .query('projectWorkDataRecords')
      .withIndex('by_generation_and_collection_and_parent_and_position', q => {
        const range = q
          .eq('generationId', partition)
          .eq('collection', planningInbound(epoch))
          .eq('parent', inboundParent(itemId, shelved));
        return position === undefined ? range : range.lt('position', position);
      })
      .order('desc');
  if (!owner) {
    yield* stream(false);
    return;
  }
  const live = stream(false)[Symbol.asyncIterator]();
  const shelf = stream(true)[Symbol.asyncIterator]();
  try {
    let [a, b] = await Promise.all([live.next(), shelf.next()]);
    while (!a.done || !b.done) {
      if (!a.done && (b.done || a.value.position >= b.value.position)) {
        yield a.value;
        a = await live.next();
      } else if (!b.done) {
        yield b.value;
        b = await shelf.next();
      }
    }
  } finally {
    await Promise.all([live.return?.(), shelf.return?.()]);
  }
}
