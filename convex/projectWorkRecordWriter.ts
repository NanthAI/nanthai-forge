// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './_generated/server';
import { planRowsWriter } from './projectPlanRowsWriter';
import { exactChildTally, planCountsBirth, planCountsWriter } from './projectPlanCountsStore';
import { requestPlanRepair } from './projectPlanPreparationStore';
import type { Doc, Id } from './_generated/dataModel';
import { layoutRecordTable, splitRecordTable } from './projectWorkRecordTables';
import { isDataRouted, layoutMarkerFields, noteLayout, partitionLayout } from './projectWorkRecordLayout';
import { initiativeWorkPlanning } from './projectInitiativeWorkPlanning';

const tag = Symbol('workRecordWriter');
const workTables = new Set(['projectWorkRecords', 'projectPlanningRecords', 'projectWorkDataRecords']);
const originals = new WeakMap<object, () => MutationCtx['db']>();
export const workRecordOriginalDb = (db: MutationCtx['db']) => originals.get(db)?.() ?? db;
type Row = Omit<Doc<'projectWorkRecords'>, '_id' | '_creationTime'>;
const flushers = new WeakMap<object, () => Promise<boolean | undefined> | undefined>();
const preparations = new WeakMap<object, () => void>();
const childCounts = new WeakMap<object, ReturnType<typeof planCountsWriter>['children']>();
export async function workChildCount(
  ctx: MutationCtx,
  partition: Id<'projectWorkGenerations'>,
  itemId: string,
) {
  const read = childCounts.get(ctx.db);
  return read ? read(partition, itemId) : ((await exactChildTally(ctx.db, partition, itemId))?.total ?? null);
}
export const finishWorkRecordWrites = (ctx: MutationCtx) => flushers.get(ctx)?.();
/** Replacement preparation has already cleared the old layout; never schedule itself recursively. */
export const preparePlanRowsWrites = (ctx: MutationCtx) => preparations.get(ctx)?.();
/** Route existing logical inserts once, without migration mirrors. The wrapper
 * remains lazy: constructing a retired endpoint must never touch its context. */
export function workRecordWriter(ctx: MutationCtx): MutationCtx {
  const db = () => ctx.db;
  const overrides = new Map<PropertyKey, unknown>();
  const roots = new Map<string, Doc<'projectPlanningRecords'>>();
  const collections = new Map<string, string>();
  // Row identity for the history move (Item 411727ba row 3): a write to a legacy row of a copying
  // partition is mirrored to its data-table copy, found by key.
  const identities = new Map<string, { generationId: string; collection: string; key: string }>();
  const layouts = new Map<string, boolean>();
  const waitingRepairs = new Set<string>();
  const repairs = new Set<Id<'projectWorkGenerations'>>();
  let preparing = false;
  // Only generation-shaped records need table discrimination. Unrelated reads
  // retain their narrow DB port and never acquire a normalization dependency.
  const remember = <T>(row: T): T => {
    if (
      row &&
      typeof row === 'object' &&
      '_id' in row &&
      'backupId' in row &&
      'metadata' in row &&
      db().normalizeId('projectWorkGenerations', String(row._id))
    ) {
      const state =
        'planRowsPreparation' in row
          ? (row.planRowsPreparation as { phase?: string } | undefined)
          : undefined;
      if (state?.phase === 'rows' || state?.phase === 'blocked') layouts.set(String(row._id), true);
      else if (state?.phase === 'clear' || !('planRowsVersion' in row) || !row.planRowsVersion)
        layouts.set(String(row._id), false);
      else layouts.delete(String(row._id));
      if (
        'planRowsPreparation' in row &&
        row.planRowsPreparation &&
        !(row.planRowsPreparation as { task?: string }).task
      )
        waitingRepairs.add(String(row._id));
      else waitingRepairs.delete(String(row._id));
    }
    if (row && typeof row === 'object' && 'collection' in row && '_id' in row) {
      const id = String(row._id);
      collections.set(id, String(row.collection));
      if ('generationId' in row && 'key' in row)
        identities.set(id, {
          generationId: String(row.generationId),
          collection: String(row.collection),
          key: String(row.key),
        });
      if (row.collection === 'planningSearch')
        roots.set(id, { ...row } as unknown as Doc<'projectPlanningRecords'>);
      else roots.delete(id);
    }
    return row;
  };
  // Keep the exact root the caller already read; upkeep must not bill that same body-bearing row twice.
  const observed = (target: object): object =>
    new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key);
        if (key === Symbol.asyncIterator)
          return async function* () {
            for await (const row of object as AsyncIterable<Doc<'projectPlanningRecords'>>)
              yield remember(row);
          };
        if (typeof value !== 'function') return value;
        if (key === 'withIndex' || key === 'withSearchIndex' || key === 'order' || key === 'filter')
          return (...args: unknown[]) => observed(Reflect.apply(value, object, args));
        if (key === 'unique' || key === 'first')
          return async (...args: unknown[]) => remember(await Reflect.apply(value, object, args));
        if (key === 'take' || key === 'collect')
          return async (...args: unknown[]) => {
            const rows = (await Reflect.apply(value, object, args)) as unknown[];
            rows.forEach(remember);
            return rows;
          };
        if (key === 'paginate')
          return async (...args: unknown[]) => {
            const page = (await Reflect.apply(value, object, args)) as { page: unknown[] };
            page.page.forEach(remember);
            return page;
          };
        return value.bind(object);
      },
    });
  let projection: ReturnType<typeof planRowsWriter> | undefined;
  const plan = () =>
    (projection ??= planRowsWriter(
      db(),
      id => (preparing ? true : layouts.get(id)),
      id => {
        repairs.add(id);
      },
    ));
  let tally: ReturnType<typeof planCountsWriter> | undefined;
  const counts = () => (tally ??= planCountsWriter(db()));
  let initiativeWork: ReturnType<typeof initiativeWorkPlanning> | undefined;
  const work = () => (initiativeWork ??= initiativeWorkPlanning());
  let tail = Promise.resolve();
  let pending = false;
  const serial = <T>(work: () => Promise<T>) => {
    pending = true;
    const next = tail.then(work);
    tail = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  const layoutOf = (partition: string) =>
    partitionLayout({ db: writer }, partition as Id<'projectWorkGenerations'>);
  // Only rows of a copying partition have a mirror: a legacy row's copy in the data table, or a
  // data-table copy's legacy row. Rows this transaction read are known; a legacy id it never read
  // is fetched once (the planning branch below reuses that read). A data-table id of Item history
  // is only reached through a read, so an unknown one is never fetched.
  const mirrorOf = async (id: string, data = false) => {
    if (!data && !identities.has(id)) remember(await db().get(id as never));
    const identity = identities.get(id);
    if (!identity || !isDataRouted(identity.collection)) return null;
    if ((await layoutOf(identity.generationId)) !== 'copying') return null;
    const copy = await db()
      .query(data ? splitRecordTable(identity.collection) : 'projectWorkDataRecords')
      .withIndex('by_generation_and_collection_and_key', q =>
        q
          .eq('generationId', identity.generationId as Id<'projectWorkGenerations'>)
          .eq('collection', identity.collection)
          .eq('key', identity.key),
      )
      .unique();
    return copy?._id ?? null;
  };
  const writer = new Proxy({} as MutationCtx['db'], {
    has(_target, key) {
      return overrides.has(key) || Reflect.has(db(), key);
    },
    get(_target, method) {
      if (method === tag) return true;
      if (overrides.has(method)) return overrides.get(method);
      if (method === 'get' && !Reflect.get(db(), tag))
        return async (id: string) => remember(await db().get(id as never));
      if (method === 'query' && !Reflect.get(db(), tag))
        return (table: string) => {
          const query = db().query(table as never);
          return workTables.has(table) ? observed(query) : query;
        };
      if (method === 'insert' && !Reflect.get(db(), tag))
        return async (table: string, input: Record<string, unknown>) => {
          // A fresh partition is projection-aware from birth, including paged builds. Shared
          // legacy partitions retain their existing coverage marker until explicit preparation.
          if (table === 'projectWorkGenerations' && !input.recordsGenerationId) {
            const id = await db().insert('projectWorkGenerations', {
              ...input,
              planRowsVersion: 1,
            } as never);
            layouts.set(id, true);
            // Its planning counts start complete: every root of this partition passes through this writer.
            await db().insert('projectWorkDataRecords', planCountsBirth(input.projectId as never, id));
            // Its Item history and Work events live in the 8-copy data table from birth.
            await db().insert(
              'projectWorkDataRecords',
              layoutMarkerFields(input.projectId as never, id, 'moved'),
            );
            noteLayout(writer, id, 'moved');
            return id;
          }
          if (table === 'projectWorkGenerations') {
            // Repair state belongs to the shared record partition, never its aliases.
            const alias = { ...input };
            delete alias.planRowsPreparation;
            return db().insert('projectWorkGenerations', alias as never);
          }
          if (table === 'projectWorkRecords') table = splitRecordTable(String(input.collection));
          if (workTables.has(table) && isDataRouted(String(input.collection))) {
            const layout = await layoutOf(String(input.generationId));
            table = layoutRecordTable(layout, String(input.collection));
            if (layout === 'copying') await db().insert('projectWorkDataRecords', input as never);
          }
          const id = await db().insert(table as never, input as never);
          if (table === 'projectPlanningRecords' || table === 'projectWorkRecords')
            remember({ ...input, _id: id });
          if (
            (table === 'projectWorkRecords' || table === 'projectPlanningRecords') &&
            input.collection === 'planningSearch'
          )
            await serial(async () => {
              remember({ ...input, _id: id });
              await plan().change(null, input as Row);
              counts().change(null, input as Row);
              if (!preparing) work().change(null, input as Row);
            });
          return id;
        };
      if (['patch', 'replace', 'delete'].includes(String(method)) && !Reflect.get(db(), tag))
        return async (id: string, value?: Record<string, unknown>) => {
          const mutate = () =>
            method === 'delete'
              ? db().delete(id as never)
              : method === 'replace'
                ? db().replace(id as never, value as never)
                : db().patch(id as never, value as never);
          if (db().normalizeId('projectWorkGenerations', id)) {
            if (value && 'planRowsPreparation' in value) {
              if (value.planRowsPreparation && !(value.planRowsPreparation as { task?: string }).task)
                waitingRepairs.add(id);
              else waitingRepairs.delete(id);
            }
            if (method === 'delete') layouts.delete(id);
            else if (
              method === 'replace' ||
              (value && ('planRowsVersion' in value || 'planRowsPreparation' in value))
            ) {
              const phase = (value?.planRowsPreparation as { phase?: string } | undefined)?.phase;
              if (phase === 'rows' || phase === 'blocked') layouts.set(id, true);
              else if (phase === 'clear' || (value && 'planRowsVersion' in value && !value.planRowsVersion))
                layouts.set(id, false);
              else layouts.delete(id);
            }
            await mutate();
            if (!preparing && value?.planningSearchVersion === 2 && waitingRepairs.has(id))
              await requestPlanRepair(context, id as Id<'projectWorkGenerations'>);
            return;
          }
          const planningId = db().normalizeId('projectPlanningRecords', id);
          const dataId = !planningId && db().normalizeId('projectWorkDataRecords', id);
          if (!planningId && !dataId && !db().normalizeId('projectWorkRecords', id)) return mutate();
          const copy = await mirrorOf(id, !!dataId);
          const mirrored = async () => {
            if (method === 'delete') identities.delete(id);
            if (!copy) return;
            if (method === 'delete') await db().delete(copy);
            else if (method === 'replace') await db().replace(copy, value as never);
            else await db().patch(copy, value as never);
          };
          if (!planningId) {
            await mutate();
            return mirrored();
          }
          return serial(async () => {
            await mirrored();
            if (
              collections.has(id) &&
              collections.get(id) !== 'planningSearch' &&
              value?.collection !== 'planningSearch'
            ) {
              await mutate();
              if (method === 'delete') collections.delete(id);
              else if (value?.collection) collections.set(id, String(value.collection));
              return;
            }
            const old =
              roots.get(id) ?? ((await db().get(id as never)) as Doc<'projectPlanningRecords'> | null);
            await mutate();
            if (old) {
              const next =
                method === 'delete' ? null : ({ ...(method === 'patch' ? old : {}), ...value } as Row);
              roots.delete(id);
              collections.delete(id);
              if (next) remember({ ...next, _id: id });
              if (old.collection === 'planningSearch' || next?.collection === 'planningSearch') {
                await plan().change(old, next);
                counts().change(old, next);
                if (!preparing) work().change(old, next);
              }
            }
          });
        };
      const value = Reflect.get(db(), method);
      return typeof value === 'function' ? value.bind(db()) : value;
    },
    set(_target, key, value) {
      overrides.set(key, value);
      return true;
    },
  });
  originals.set(writer, db);
  const context = new Proxy(ctx, {
    get(target, key, receiver) {
      return key === 'db' ? writer : Reflect.get(target, key, receiver);
    },
  });
  childCounts.set(writer, (partition, id) => counts().children(partition, id));
  preparations.set(context, () => {
    preparing = true;
  });
  flushers.set(context, () =>
    pending
      ? tail.then(async () => {
          await tally?.flush();
          await initiativeWork?.flush(context);
          const result = await projection?.flush();
          if (!preparing) for (const id of repairs) await requestPlanRepair(context, id);
          repairs.clear();
          return result;
        })
      : undefined,
  );
  return context;
}
