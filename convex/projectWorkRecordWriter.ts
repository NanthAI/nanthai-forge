// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { splitRecordTable, type WorkRecordTable } from './projectWorkRecordTables';

const tag = Symbol('workRecordWriter');
const originals = new WeakMap<object, () => MutationCtx['db']>();
export const workRecordOriginalDb = (db: MutationCtx['db']) => originals.get(db)?.() ?? db;
type Row = Omit<Doc<'projectWorkRecords'>, '_id' | '_creationTime'>;
/** Route existing logical inserts once, with no layout reads or migration mirrors. The wrapper
 * remains lazy: constructing a retired endpoint must never touch its context. */
export function workRecordWriter(ctx: MutationCtx): MutationCtx {
  const db = () => ctx.db;
  const overrides = new Map<PropertyKey, unknown>();
  const writer = new Proxy({} as MutationCtx['db'], {
    has(_target, key) {
      return overrides.has(key) || Reflect.has(db(), key);
    },
    get(_target, method) {
      if (method === tag) return true;
      if (overrides.has(method)) return overrides.get(method);
      if (method === 'insert' && !Reflect.get(db(), tag))
        return (table: WorkRecordTable, row: Row) =>
          db().insert(table === 'projectWorkRecords' ? splitRecordTable(row.collection) : table, row);
      const value = Reflect.get(db(), method);
      return typeof value === 'function' ? value.bind(db()) : value;
    },
    set(_target, key, value) {
      overrides.set(key, value);
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
