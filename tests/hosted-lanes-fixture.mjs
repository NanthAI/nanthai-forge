// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { checkArgs, checkDocument, insertedDocument, updatedDocument } from './convex-args.mjs';
import { validateContext } from './convex-context.mjs';
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
const githubBindings = await import(moduleUrl('../convex/githubBindingStore.ts'));
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const encoded = rows => JSON.stringify(rows);

/** Snapshot transactions with indexed read-range OCC (including missing keys).
 * Concurrent commits retry only when a read document/range actually changed.
 * All counters describe matched provider ranges, never the fake's JS scans. */
export function lanesFixture() {
  const tables = Object.fromEntries(Object.keys(schema.tables).map(name => [name, new Map()]));
  const counts = [];
  let serial = 0,
    decorate;
  const insert = (table, value) => {
    const _id = `${table}-${++serial}`;
    tables[table].set(_id, insertedDocument(schema, table, value, _id, serial));
    return _id;
  };
  async function call(name, fn, input, actor = 'owner') {
    if (fn.exportArgs) checkArgs(fn, input, name);
    let retries = 0;
    for (;;) {
      const baseline = structuredClone(tables),
        // Reads return clones and writes replace rows. Share immutable snapshot
        // rows instead of cloning every unrelated document a second time.
        local = Object.fromEntries(Object.entries(baseline).map(([table, rows]) => [table, new Map(rows)])),
        reads = [],
        writes = [];
      const meter = {
        name,
        retries,
        ranges: 0,
        documents: 0,
        readBytes: 0,
        writes: 0,
        writeBytes: 0,
        touched: [],
        written: [],
      };
      const read = (table, select) => {
        meter.touched.push(table);
        const rows = select(local[table]);
        const original = encoded(select(baseline[table]));
        reads.push(() => encoded(select(tables[table])) === original);
        meter.ranges++;
        meter.documents += Math.max(1, rows.length);
        meter.readBytes += rows.reduce((n, row) => n + bytes(row), 0);
        assert(meter.documents <= 4096 && meter.ranges <= 4096, `${name}: Convex read budget`);
        assert(meter.readBytes < 16 * 1024 * 1024, `${name}: Convex read bytes`);
        return structuredClone(rows);
      };
      const put = (table, id, row) => {
        row = checkDocument(schema, table, row);
        assert(bytes(row) < 1024 * 1024, `${name}: document size`);
        local[table].set(id, structuredClone(row));
        writes.push([table, id, structuredClone(row)]);
        meter.written.push(table);
        meter.writes++;
        meter.writeBytes += bytes(row);
        assert(meter.writes <= 8192 && meter.writeBytes < 16 * 1024 * 1024, `${name}: Convex writes`);
      };
      const locate = id => Object.keys(local).find(table => local[table].has(id));
      const ctx = validateContext({
        auth: {
          getUserIdentity: async () =>
            actor === null ? null : typeof actor === 'object' ? actor : { subject: actor },
        },
        db: {
          get: async id => {
            const table = locate(id);
            if (!table) {
              meter.documents++;
              meter.ranges++;
              return null;
            }
            return read(table, rows => [rows.get(id) ?? null])[0];
          },
          delete: async id => {
            const table = locate(id);
            if (!table) return;
            local[table].delete(id);
            writes.push([table, id, null]);
            meter.writes++;
          },
          insert: async (table, value) => {
            const id = `${table}-${++serial}`;
            put(table, id, insertedDocument(schema, table, value, id, serial));
            return id;
          },
          replace: async (id, value) => {
            const table = locate(id),
              old = local[table].get(id);
            put(table, id, updatedDocument(old, value, true));
          },
          patch: async (id, value) => {
            const table = locate(id);
            put(table, id, updatedDocument(local[table].get(id), value));
          },
          query: table => {
            let match,
              indexFields,
              descending = false;
            const q = {
              withIndex: (name, build) => {
                const index = schema.tables[table].export().indexes.find(i => i.indexDescriptor === name);
                assert(index, `${table}.${name}`);
                indexFields = index.fields;
                const terms = [];
                let lower = null,
                  upper = null;
                const bounds = {
                  lte(field, value) {
                    assert.equal(field, index.fields[terms.length], 'index upper-bound order');
                    upper = [field, value];
                    return bounds;
                  },
                  gt(field, value) {
                    assert.equal(field, index.fields[terms.length], 'index lower-bound order');
                    lower = [field, value];
                    return bounds;
                  },
                  eq(field, value) {
                    assert.equal(field, index.fields[terms.length], 'index order');
                    terms.push([field, value]);
                    return bounds;
                  },
                };
                build(bounds);
                match = rows =>
                  [...rows.values()]
                    .filter(
                      row =>
                        terms.every(([k, v]) => row[k] === v) &&
                        (!lower || row[lower[0]] > lower[1]) &&
                        (!upper || row[upper[0]] <= upper[1]),
                    )
                    .sort((a, b) => {
                      for (const field of index.fields) {
                        if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
                      }
                      return a._creationTime - b._creationTime;
                    });
                return q;
              },
              order: direction => {
                descending = direction === 'desc';
                return q;
              },
              take: async n => {
                assert(match, 'indexed reads only');
                return read(table, rows =>
                  match(rows)
                    .sort((a, b) => {
                      for (const field of [...indexFields, '_creationTime']) {
                        if (a[field] === b[field]) continue;
                        return (a[field] < b[field] ? -1 : 1) * (descending ? -1 : 1);
                      }
                      return 0;
                    })
                    .slice(0, n),
                );
              },
              unique: async () => {
                assert(match, 'indexed reads only');
                const rows = read(table, match);
                assert(rows.length <= 1, 'unique index');
                return rows[0] ?? null;
              },
              paginate: async ({ cursor, numItems, maximumRowsRead, maximumBytesRead }) => {
                assert(match, 'indexed reads only');
                const start = Number(cursor ?? 0);
                const rows = read(table, all => {
                  const result = [];
                  let total = 0;
                  for (const row of match(all).slice(
                    start,
                    start + Math.min(numItems, maximumRowsRead ?? numItems),
                  )) {
                    if (result.length && total + bytes(row) > maximumBytesRead) break;
                    result.push(row);
                    total += bytes(row);
                  }
                  return result;
                });
                const length = match(local[table]).length;
                return {
                  page: rows,
                  isDone: start + rows.length >= length,
                  continueCursor: String(start + rows.length),
                };
              },
            };
            return q;
          },
        },
      });
      try {
        if (decorate) await decorate(ctx, input, name);
        const result = await fn._handler(ctx, input);
        if (reads.every(unchanged => unchanged())) {
          for (const [table, id, row] of writes) {
            if (row === null) tables[table].delete(id);
            else tables[table].set(id, row);
          }
          counts.push(meter);
          return result;
        }
      } catch (error) {
        counts.push(meter);
        throw error;
      }
      counts.push(meter);
      assert(++retries < 5, 'bounded fake OCC retries');
    }
  }
  // Synthetic owner proof uses the same retained operation and store as github connect.
  // Merely creating a Lane store leaves it unbound, including refusal-test fixtures.
  async function bindRepository(projectId, { repository, repoId, installationId = 9 }) {
    const state = randomUUID();
    await call('githubBindingStart', githubBindings.start, {
      projectId,
      operationId: randomUUID(),
      repository: repository.toLowerCase(),
      installationId,
      state,
      verifier: 'synthetic-owner-proof',
      authorizeUrl: `https://github.com/login/oauth/authorize?state=${state}`,
    });
    await call('githubBindingConsume', githubBindings.consume, { state });
    await call('githubBindingComplete', githubBindings.complete, {
      state,
      repoId,
      fullName: repository,
    });
  }
  return {
    bindRepository,
    tables,
    counts,
    insert,
    call,
    transaction: call,
    decorateContext(fn) {
      decorate = fn;
    },
    patch(table, id, value) {
      tables[table].set(id, checkDocument(schema, table, updatedDocument(tables[table].get(id), value)));
    },
  };
}
