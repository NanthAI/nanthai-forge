// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
const field = (row, path) => path.split('.').reduce((v, k) => v?.[k], row);
const tokens = text => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Provider search fake: schema-checked filters, token overlap ranking and paged returned-row IO.
 * This deliberately does not claim to reproduce Tantivy/BM25 or real billed/index bytes. */
export function installPlanningSearch(s) {
  const dbQuery = s.ctx.db.query;
  const reads = [];
  reads.db = { documents: 0, bytes: 0 };
  const meter = rows => {
    for (const row of rows.filter(Boolean)) {
      reads.db.documents++;
      reads.db.bytes += Buffer.byteLength(JSON.stringify(row));
    }
  };
  reads.reset = () => {
    reads.db.documents = 0;
    reads.db.bytes = 0;
  };
  const get = s.ctx.db.get;
  s.ctx.db.get = async (...args) => {
    const row = await get(...args);
    meter([row]);
    return row;
  };
  s.ctx.db.query = table => {
    const ordinary = dbQuery(table);
    for (const method of ['unique', 'take', 'paginate']) {
      const run = ordinary[method];
      ordinary[method] = async (...args) => {
        const result = await run(...args);
        meter(Array.isArray(result) ? result : (result?.page ?? [result]));
        return result;
      };
    }
    return {
      ...ordinary,
      withSearchIndex(name, build) {
        const definition = schema.tables[table].export().searchIndexes.find(i => i.indexDescriptor === name);
        assert(definition, `missing search index ${table}.${name}`);
        const filters = [];
        let terms;
        const q = {
          search(path, text) {
            assert.equal(path, definition.searchField);
            terms = tokens(text);
            assert(terms.length <= 16);
            return q;
          },
          eq(path, value) {
            assert(definition.filterFields.includes(path), `unindexed filter ${path}`);
            filters.push([path, value]);
            return q;
          },
        };
        build(q);
        return {
          async take(n) {
            return (
              await this.paginate({ cursor: null, numItems: n, maximumRowsRead: n, maximumBytesRead: 512000 })
            ).page;
          },
          async paginate({ cursor, numItems, maximumRowsRead, maximumBytesRead }) {
            assert(maximumRowsRead <= 100);
            assert(maximumBytesRead <= 512000);
            const matches = [...s.tables[table].values()]
              .filter(row => filters.every(([k, v]) => field(row, k) === v))
              .map(row => ({
                row,
                score: terms.reduce(
                  (n, term, i) =>
                    n +
                    tokens(field(row, definition.searchField) ?? '').filter(t =>
                      i === terms.length - 1 ? t.startsWith(term) : t === term,
                    ).length,
                  0,
                ),
              }))
              .filter(item => item.score > 0)
              .sort((a, b) => b.score - a.score || b.row._creationTime - a.row._creationTime);
            const start = Number(cursor ?? 0);
            const page = [];
            let bytes = 0;
            for (const { row } of matches.slice(start)) {
              if (page.length >= numItems || page.length >= maximumRowsRead || bytes >= maximumBytesRead)
                break;
              page.push(structuredClone(row));
              bytes += Buffer.byteLength(JSON.stringify(row));
            }
            meter(page);
            reads.push({ filters, documents: page.length, bytes });
            return {
              page,
              isDone: start + page.length >= matches.length,
              continueCursor: String(start + page.length),
            };
          },
        };
      },
    };
  };
  return reads;
}
