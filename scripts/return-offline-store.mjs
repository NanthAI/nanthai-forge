// SPDX-License-Identifier: Apache-2.0
// SQLite is the provider boundary, separate from the constrained action process.
// Bodies and indexes stay on disk; each query decodes only its bounded page.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
const fields = [
  '_id',
  '_creationTime',
  'projectId',
  'generationId',
  'collection',
  'key',
  'parent',
  'position',
  'partitionId',
  'returnOperationId',
  'operationId',
  'digest',
  'status',
  'backupId',
  'revision',
];
const quote = field => {
  assert(fields.includes(field), `Unmodeled index field ${field}`);
  return `"${field}"`;
};
export function offlineStore(path) {
  rmSync(path, { force: true });
  const sql = new DatabaseSync(path);
  sql.exec(`PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF; PRAGMA cache_size=-4096;
    CREATE TABLE docs (tableName TEXT, body TEXT, bytes INTEGER, ${fields.map(field => `${quote(field)} ${['_creationTime', 'position', 'revision'].includes(field) ? 'REAL' : 'TEXT'}`).join(',')}, PRIMARY KEY(_id));
    CREATE INDEX generation_key ON docs(tableName,generationId,collection,key);
    CREATE INDEX generation_parent ON docs(tableName,generationId,collection,parent,position);
    CREATE INDEX generation_time ON docs(tableName,generationId,_creationTime);
    CREATE INDEX partition_key ON docs(tableName,partitionId,key,position);
    CREATE INDEX project_digest ON docs(tableName,projectId,digest);
    CREATE INDEX project_operation ON docs(tableName,projectId,operationId);
    CREATE INDEX project_return ON docs(tableName,projectId,returnOperationId);
    CREATE INDEX project_revision ON docs(tableName,projectId,revision);
    CREATE INDEX project ON docs(tableName,projectId);`);
  const upsert = sql.prepare(
    `INSERT OR REPLACE INTO docs VALUES (${Array(fields.length + 3)
      .fill('?')
      .join(',')})`,
  );
  let sequence = 0;
  const accounting = { reads: 0, readBytes: 0, writes: 0, writtenBytes: 0 };
  const decode = row => {
    if (!row) return null;
    accounting.reads++;
    accounting.readBytes += row.bytes;
    return JSON.parse(row.body);
  };
  const put = (table, row) => {
    const body = JSON.stringify(row),
      bytes = Buffer.byteLength(body);
    upsert.run(table, body, bytes, ...fields.map(field => row[field] ?? null));
    accounting.writes++;
    accounting.writtenBytes += bytes;
  };
  const db = {
    get: async id => decode(sql.prepare('SELECT body,bytes FROM docs WHERE _id=?').get(id)),
    insert: async (table, value) => {
      const id = `offline-${sequence++}`;
      put(table, { ...value, _id: id, _creationTime: Date.now() + sequence / 1000 });
      return id;
    },
    replace: async (id, value) => {
      const old = sql.prepare('SELECT tableName,body,bytes FROM docs WHERE _id=?').get(id);
      assert(old, `Missing replacement ${id}`);
      put(old.tableName, { ...value, _id: id, _creationTime: decode(old)._creationTime });
    },
    patch: async (id, value) => {
      const old = sql.prepare('SELECT tableName,body,bytes FROM docs WHERE _id=?').get(id);
      assert(old, `Missing patch ${id}`);
      const row = { ...decode(old), ...value };
      for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key];
      put(old.tableName, row);
    },
    delete: async id => {
      sql.prepare('DELETE FROM docs WHERE _id=?').run(id);
      accounting.writes++;
    },
    query: table => {
      const terms = ['tableName=?'],
        values = [table];
      let direction = 'ASC',
        sort = ['_creationTime'],
        indexHint = '';
      const bound = (field, operator, value) => {
        terms.push(`${quote(field)} ${operator} ?`);
        values.push(value ?? null);
        return q;
      };
      const q = {
        eq: (f, v) => bound(f, 'IS', v),
        gt: (f, v) => bound(f, '>', v),
        gte: (f, v) => bound(f, '>=', v),
        lt: (f, v) => bound(f, '<', v),
        lte: (f, v) => bound(f, '<=', v),
      };
      const statement = (limit, offset = 0, ordered = true) => ({
        stmt: sql.prepare(
          `SELECT body,bytes FROM docs ${indexHint} WHERE ${terms.join(' AND ')} ${ordered ? `ORDER BY ${sort.map(field => `${quote(field)} ${direction}`).join(',')}` : ''} LIMIT ? OFFSET ?`,
        ),
        args: [...values, limit, offset],
      });
      const take = (n, ordered = true) => {
        const { stmt, args } = statement(n, 0, ordered);
        return stmt.all(...args).map(decode);
      };
      const query = {
        withIndex: (index, build) => {
          const physical = {
            by_generation: 'generation_time',
            by_generation_and_collection_and_key: 'generation_key',
            by_generation_and_collection_and_parent_and_position: 'generation_parent',
            by_partition_and_key_and_position: 'partition_key',
            by_project_and_digest: 'project_digest',
            by_project_and_operation: 'project_operation',
            by_project_and_return_operation: 'project_return',
            by_project_and_revision: 'project_revision',
            by_project: 'project',
          }[index];
          assert(physical, `Unmodeled provider index ${index}`);
          indexHint = `INDEXED BY ${physical}`;
          sort = index.includes('position') ? ['position', '_creationTime'] : ['_creationTime'];
          build?.(q);
          return query;
        },
        order: order => {
          direction = order === 'desc' ? 'DESC' : 'ASC';
          return query;
        },
        take: async n => take(n),
        first: async () => take(1)[0] ?? null,
        unique: async () => {
          const rows = take(2, false);
          assert(rows.length <= 1, `Duplicate ${table}`);
          return rows[0] ?? null;
        },
        paginate: async ({ cursor, numItems, maximumRowsRead = numItems, maximumBytesRead = Infinity }) => {
          const offset = Number(cursor ?? 0),
            limit = Math.min(numItems, maximumRowsRead),
            page = [];
          let bytes = 0,
            more = false;
          const { stmt, args } = statement(limit + 1, offset);
          for (const row of stmt.iterate(...args)) {
            if (page.length === limit || (page.length && bytes + row.bytes > maximumBytesRead)) {
              more = true;
              break;
            }
            page.push(decode(row));
            bytes += row.bytes;
          }
          return { page, isDone: !more, continueCursor: String(offset + page.length) };
        },
      };
      return query;
    },
  };
  return {
    db,
    put,
    accounting,
    reset: () => {
      for (const key of Object.keys(accounting)) accounting[key] = 0;
    },
    transaction: async run => {
      sql.exec('BEGIN');
      try {
        const value = await run();
        sql.exec('COMMIT');
        return value;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => sql.close(),
  };
}
