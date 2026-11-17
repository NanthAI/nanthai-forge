// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import { planRowsWriter } from './projectPlanRowsWriter';
import type { Doc } from './_generated/dataModel';
import { splitRecordTable } from './projectWorkRecordTables';

const tag = Symbol('workRecordWriter');
const originals = new WeakMap<object, () => MutationCtx['db']>();
export const workRecordOriginalDb = (db: MutationCtx['db']) => originals.get(db)?.() ?? db;
type Row = Omit<Doc<'projectWorkRecords'>, '_id' | '_creationTime'>;
const flushers = new WeakMap<object, () => Promise<boolean | undefined> | undefined>();
export const finishWorkRecordWrites = (ctx: MutationCtx) => flushers.get(ctx)?.();
/** Route existing logical inserts once, with no layout reads or migration mirrors. The wrapper
 * remains lazy: constructing a retired endpoint must never touch its context. */
export function workRecordWriter(ctx: MutationCtx): MutationCtx {
  const db = () => ctx.db;
  const overrides = new Map<PropertyKey, unknown>();
  const roots = new Map<string, Doc<'projectPlanningRecords'>>();
  const remember = <T>(row: T): T => {
    if (
      row &&
      typeof row === 'object' &&
      'collection' in row &&
      row.collection === 'planningSearch' &&
      '_id' in row
    )
      roots.set(String(row._id), { ...row } as unknown as Doc<'projectPlanningRecords'>);
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
  const plan = () => (projection ??= planRowsWriter(db()));
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
          return table === 'projectPlanningRecords' ? observed(query) : query;
        };
      if (method === 'insert' && !Reflect.get(db(), tag))
        return async (table: string, input: Record<string, unknown>) => {
          // A fresh partition is projection-aware from birth, including paged builds. Shared
          // legacy partitions retain their existing coverage marker until explicit preparation.
          if (table === 'projectWorkGenerations' && !input.recordsGenerationId)
            return db().insert('projectWorkGenerations', { ...input, planRowsVersion: 1 } as never);
          if (table === 'projectWorkRecords') table = splitRecordTable(String(input.collection));
          const id = await db().insert(table as never, input as never);
          if (
            (table === 'projectWorkRecords' || table === 'projectPlanningRecords') &&
            input.collection === 'planningSearch'
          )
            await serial(async () => {
              remember({ ...input, _id: id });
              await plan().change(null, input as Row);
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
          if (
            !db().normalizeId('projectPlanningRecords', id) ||
            (value?.collection && value.collection !== 'planningSearch')
          )
            return mutate();
          return serial(async () => {
            const old =
              roots.get(id) ?? ((await db().get(id as never)) as Doc<'projectPlanningRecords'> | null);
            await mutate();
            if (old?.collection === 'planningSearch') {
              const next =
                method === 'delete' ? null : ({ ...(method === 'patch' ? old : {}), ...value } as Row);
              roots.delete(id);
              if (next) remember({ ...next, _id: id });
              await plan().change(old, next);
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
  flushers.set(context, () => (pending ? tail.then(() => projection?.flush()) : undefined));
  return context;
}
