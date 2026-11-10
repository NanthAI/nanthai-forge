// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import {
  recordTablesLayout,
  splitRecordTable,
  shareRecordTableCache,
  rememberRecordTables,
  type WorkRecordTable,
} from './projectWorkRecordTables';

const tag = Symbol('workRecordWriter');
const originals = new WeakMap<object, () => MutationCtx['db']>();
export const workRecordOriginalDb = (db: MutationCtx['db']) => originals.get(db)?.() ?? db;
type Row = Omit<Doc<'projectWorkRecords'>, '_id' | '_creationTime'>;
/** Migration-only mirrors commit with the original write. Ready generations write one table once.
 * The wrapper is lazy, like finishReadWriter: retired endpoints never touch their context. */
export function workRecordWriter(ctx: MutationCtx): MutationCtx {
  let source: MutationCtx['db'] | undefined;
  const db = () => {
    if (!source) {
      source = ctx.db;
      shareRecordTableCache(source, writer);
    }
    return source;
  };
  const original = new Map<PropertyKey, unknown>();
  const rows = new Map<string, Doc<'projectWorkRecords'>>();
  const remember = (value: unknown): unknown => {
    if (Array.isArray(value)) value.forEach(remember);
    else if (value && typeof value === 'object') {
      if ('page' in value) remember(value.page);
      else if ('generationId' in value && 'collection' in value && 'value' in value)
        rows.set((value as Doc<'projectWorkRecords'>)._id, value as Doc<'projectWorkRecords'>);
      else if ('initialRevision' in value && 'nextBatch' in value)
        rememberRecordTables({ db: writer }, value as Doc<'projectWorkGenerations'>);
    }
    return value;
  };
  const track = <T extends object>(query: T): T =>
    new Proxy(query, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          return ['unique', 'first', 'take', 'paginate', 'collect'].includes(String(key))
            ? Promise.resolve(result).then(remember)
            : result && typeof result === 'object'
              ? track(result)
              : result;
        };
      },
    });
  const writer = new Proxy({} as MutationCtx['db'], {
    has(_target, key) {
      return original.has(key) || Reflect.has(db(), key);
    },
    get(_target, method) {
      if (method === tag) return true;
      if (Reflect.get(db(), tag)) {
        const value = Reflect.get(db(), method);
        return typeof value === 'function' ? value.bind(db()) : value;
      }
      if (original.has(method)) return original.get(method);
      if (method === 'get') return async (id: Id<'projectWorkRecords'>) => remember(await db().get(id));
      if (method === 'query')
        return (table: WorkRecordTable) => {
          // oxlint-disable-next-line forge/convex-bounded-query -- bounded chains are supplied by callers
          const query = db().query(table);
          return [
            'projectWorkRecords',
            'projectPlanningRecords',
            'projectWorkDataRecords',
            'projectWorkGenerations',
          ].includes(table)
            ? track(query)
            : query;
        };
      if (method === 'insert')
        return async (table: WorkRecordTable, row: Row) => {
          if (table !== 'projectWorkRecords') return db().insert(table, row);
          const target = splitRecordTable(row.collection);
          if (target === table) return db().insert(table, row);
          const layout = await recordTablesLayout({ db: writer }, row.generationId);
          if (layout === 'split') return db().insert(target, row);
          const id = await db().insert(table, row);
          if (layout === 'copying') await db().insert(target, row);
          return id;
        };
      if (method === 'patch' || method === 'replace' || method === 'delete')
        return async (id: string, value?: Partial<Row>) => {
          const isRecord = ['projectWorkRecords', 'projectPlanningRecords', 'projectWorkDataRecords'].some(
            table => db().normalizeId(table as WorkRecordTable, id) !== null,
          );
          const mutate = (key: string) =>
            method === 'delete'
              ? db().delete(key as Id<'projectWorkRecords'>)
              : method === 'replace'
                ? db().replace(key as Id<'projectWorkRecords'>, value as Row)
                : db().patch(key as Id<'projectWorkRecords'>, value!);
          if (!isRecord) return mutate(id);
          const row = rows.get(id) ?? (await db().get(id as Id<'projectWorkRecords'>));
          if (!row) return mutate(id);
          const target = splitRecordTable(row.collection);
          if (
            target === 'projectWorkRecords' ||
            (await recordTablesLayout({ db: writer }, row.generationId)) !== 'copying'
          )
            return mutate(id);
          const other = db().normalizeId('projectWorkRecords', id) !== null ? target : 'projectWorkRecords';
          const peer = await db()
            .query(other)
            .withIndex('by_generation_and_collection_and_key', q =>
              q.eq('generationId', row.generationId).eq('collection', row.collection).eq('key', row.key),
            )
            .unique();
          await mutate(id);
          if (peer) await mutate(peer._id);
          else if (method !== 'delete') {
            const { _id: _id, _creationTime: _time, ...fields } = row;
            void _id;
            void _time;
            await db().insert(other, method === 'replace' ? (value as Row) : { ...fields, ...value });
          }
        };
      const value = Reflect.get(db(), method);
      return typeof value === 'function' ? value.bind(db()) : value;
    },
    set(_target, key, value) {
      original.set(key, value);
      return true;
    },
  });
  originals.set(writer, db);
  return new Proxy(ctx, {
    get(target, key, receiver) {
      return key === 'db' ? writer : Reflect.get(target, key, receiver);
    },
  });
}
