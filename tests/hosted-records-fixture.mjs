// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { checkArgs, checkDocument, insertedDocument, updatedDocument } from './convex-args.mjs';
import { validateContext } from './convex-context.mjs';
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
const size = value => (value === null ? 0 : Buffer.byteLength(JSON.stringify(value)));

/** Indexed metadata fake. Counts the matched provider range, not a JS table scan.
 * Index names and equality order are checked against the actual Convex schema.
 * No OCC simulation: race tests interleave transactions at their CAS boundary. */
export function recordsFixture() {
  const tables = Object.fromEntries(Object.keys(schema.tables).map(name => [name, new Map()]));
  const locations = new Map(),
    indexes = new Map(),
    counts = [];
  let serial = 0,
    meter = null,
    undo = null;
  const invalidate = table => {
    for (const key of indexes.keys()) if (key.startsWith(`${table}:`)) indexes.delete(key);
  };
  const updateIndexes = (table, old, row) => {
    for (const [cacheKey, cache] of indexes) {
      if (!cacheKey.startsWith(`${table}:`)) continue;
      if (old) {
        const key = JSON.stringify(cache.fields.map(k => old[k]));
        const group = cache.groups.get(key);
        if (group) {
          const i = group.findIndex(r => r._id === old._id);
          if (i >= 0) group.splice(i, 1);
        }
      }
      const key = JSON.stringify(cache.fields.map(k => row[k]));
      if (!cache.groups.has(key)) cache.groups.set(key, []);
      const group = cache.groups.get(key);
      group.push(row);
      group.sort(cache.compare);
    }
  };
  const read = rows => {
    if (meter) {
      meter.documents += Math.max(1, rows.length); // Include missing point lookups conservatively.
      meter.readBytes += rows.reduce((n, row) => n + size(row), 0);
      assert(meter.documents <= 4096, `${meter.name}: document budget`);
      assert(meter.readBytes < 16 * 1024 * 1024, `${meter.name}: read bytes`);
    }
    return structuredClone(rows);
  };
  const range = () => {
    if (meter) {
      meter.ranges++;
      assert(meter.ranges <= 4096, `${meter.name}: index ranges`);
    }
  };
  const write = (id, table, value) => {
    value = checkDocument(schema, table, value);
    const old = tables[table].get(id);
    undo?.push(() => {
      if (old) tables[table].set(id, old);
      else {
        tables[table].delete(id);
        locations.delete(id);
      }
      invalidate(table);
    });
    if (meter) {
      meter.writes++;
      meter.writeBytes += size(value);
      assert(meter.writes <= 8192 && meter.writeBytes < 16 * 1024 * 1024, `${meter.name}: writes`);
    }
    assert(size(value) < 1024 * 1024, 'Convex document size');
    tables[table].set(id, structuredClone(value));
    locations.set(id, table);
    updateIndexes(table, old, tables[table].get(id));
  };
  const ctx = validateContext({
    db: {
      get: async id => {
        range();
        return read([tables[locations.get(id)]?.get(id) ?? null])[0];
      },
      insert: async (table, row) => {
        const id = `record-${serial++}`;
        write(id, table, insertedDocument(schema, table, row, id, serial));
        return id;
      },
      replace: async (id, row) => {
        const table = locations.get(id),
          old = tables[table].get(id);
        write(id, table, updatedDocument(old, row, true));
      },
      patch: async (id, patch) => {
        const table = locations.get(id),
          old = tables[table].get(id);
        write(id, table, updatedDocument(old, patch));
      },
      query: table => {
        range();
        let selected,
          direction = 1;
        const q = {
          withIndex: (index, build) => {
            const definition = schema.tables[table].export().indexes.find(x => x.indexDescriptor === index);
            assert(definition, `${table}.${index} exists`);
            const equalities = [];
            let upper = null;
            const bounds = {
              eq: (field, value) => {
                assert.equal(field, definition.fields[equalities.length], 'index equality order');
                equalities.push(value);
                return bounds;
              },
              lte: (field, value) => {
                assert.equal(field, definition.fields[equalities.length], 'index range follows equalities');
                upper = { field, value };
                return bounds;
              },
            };
            build(bounds);
            const cacheKey = `${table}:${index}:${equalities.length}`;
            if (!indexes.has(cacheKey)) {
              const groups = new Map();
              for (const row of tables[table].values()) {
                const key = JSON.stringify(definition.fields.slice(0, equalities.length).map(k => row[k]));
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(row);
              }
              const compare = (a, b) => {
                for (const k of [...definition.fields, '_creationTime']) {
                  if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
                }
                return 0;
              };
              for (const rows of groups.values()) rows.sort(compare);
              indexes.set(cacheKey, {
                groups,
                fields: definition.fields.slice(0, equalities.length),
                compare,
              });
            }
            selected = indexes.get(cacheKey).groups.get(JSON.stringify(equalities)) ?? [];
            if (upper) selected = selected.filter(row => row[upper.field] <= upper.value);
            return q;
          },
          order: order => {
            direction = order === 'desc' ? -1 : 1;
            return q;
          },
          unique: async () => {
            assert(selected, 'indexed reads only');
            assert(selected.length <= 1);
            return read([selected[0] ?? null])[0];
          },
          take: async n => read((direction === 1 ? selected : selected.toReversed()).slice(0, n)),
          paginate: async ({ cursor, numItems, maximumBytesRead, maximumRowsRead }) => {
            assert(selected, 'indexed reads only');
            const rows = direction === 1 ? selected : selected.toReversed();
            const start = Number(cursor ?? 0),
              page = [];
            let bytes = 0;
            for (const row of rows.slice(start, start + Math.min(numItems, maximumRowsRead ?? numItems))) {
              if (page.length && maximumBytesRead && bytes + size(row) > maximumBytesRead) break;
              page.push(row);
              bytes += size(row);
            }
            return {
              page: read(page),
              isDone: start + page.length >= rows.length,
              continueCursor: String(start + page.length),
              pageStatus: null,
              splitCursor: null,
            };
          },
        };
        return q;
      },
    },
  });
  const run = async (name, action) => {
    assert.equal(meter, null);
    meter = { name, ranges: 0, documents: 0, readBytes: 0, writes: 0, writeBytes: 0 };
    undo = [];
    try {
      return await action();
    } catch (error) {
      for (const rollback of undo.reverse()) rollback();
      throw error;
    } finally {
      counts.push(meter);
      meter = null;
      undo = null;
    }
  };
  const call = (name, fn, input) =>
    run(name, () => {
      if (fn.exportArgs) checkArgs(fn, input, name);
      return fn._handler(ctx, input);
    });
  return {
    ctx,
    tables,
    counts,
    run,
    call,
    async setup() {
      const projectId = await ctx.db.insert('hostedProjects', {
        key: 'synthetic',
        name: 'Synthetic',
        currentBackup: null,
        revision: 0,
        owner: 'owner',
        visibility: 'private',
        sourceAuthority: { mode: 'server-shadow', epoch: 1 },
      });
      return { projectId, actor: 'owner', authorityEpoch: 1 };
    },
  };
}
