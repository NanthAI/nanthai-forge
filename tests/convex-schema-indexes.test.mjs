// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { moduleUrl } from './convex-module.mjs';
function distinctIndexes(schema) {
  for (const [table, definition] of Object.entries(schema.tables)) {
    const fields = new Map();
    for (const index of definition.export().indexes) {
      const key = JSON.stringify(index.fields);
      if (fields.has(key))
        throw Error(`IndexNotUnique: ${table}.${index.indexDescriptor} duplicates ${fields.get(key)}`);
      fields.set(key, index.indexDescriptor);
    }
  }
}
test('Convex deployment contract: no table repeats an index field sequence under another name', async () => {
  const { default: schema } = await import(moduleUrl('../convex/schema.ts'));
  distinctIndexes(schema);
});
test('index deployment guard rejects duplicate fields and preserves distinct field order', () => {
  const table = () => defineTable({ a: v.string(), b: v.string() });
  assert.throws(
    () => distinctIndexes(defineSchema({ synthetic: table().index('first', ['a']).index('second', ['a']) })),
    /IndexNotUnique/,
  );
  distinctIndexes(defineSchema({ synthetic: table().index('ab', ['a', 'b']).index('ba', ['b', 'a']) }));
});

// Extend this existing Convex deployment guard: no parallel check or name allowlist.
const { indexInventory, indexIssues } = await import('../scripts/convex-index-inventory.mjs');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
function sourceFixture(t, schema, query, script = '') {
  const root = mkdtempSync(join(tmpdir(), 'forge-index-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'convex'));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'convex/schema.ts'), schema);
  writeFileSync(join(root, 'convex/queries.ts'), query);
  writeFileSync(join(root, 'scripts/read.mjs'), script);
  return indexInventory(root);
}
test('Convex deployment guard rejects unused indexes and prefixes without a local ordering reason', async () => {
  const inventory = indexInventory();
  assert.deepEqual(indexIssues(inventory), []);
  const { default: schema } = await import(moduleUrl('../convex/schema.ts'));
  assert.deepEqual(
    inventory.tables,
    Object.keys(schema.tables).sort(),
    'inventory covers every deployed table',
  );
  for (const [table, definition] of Object.entries(schema.tables)) {
    const deployed = definition.export();
    const database = deployed.indexes.map(i => ({ name: i.indexDescriptor, fields: i.fields }));
    assert.deepEqual(
      inventory.indexes
        .filter(i => i.table === table && i.kind === 'database')
        .map(({ name, fields }) => ({ name, fields })),
      database,
      `${table}: every deployed database index is inventoried`,
    );
    assert.deepEqual(
      inventory.indexes.filter(i => i.table === table && i.kind === 'search').map(i => i.name),
      deployed.searchIndexes.map(i => i.indexDescriptor),
      `${table}: every search index is inventoried`,
    );
  }
});
test('query use belongs to its resolved table, not another table sharing the index name', t => {
  const i = sourceFixture(
    t,
    `const tables = {
    used: defineTable({a: v.string()}).index('by_a', ['a']),
    unused: defineTable({a: v.string()}).index('by_a', ['a']),
  };`,
    `const q = ctx.db.query('used'); q.withIndex('by_a', q => q.eq('a', 'a')).first();`,
  );
  assert.equal(i.indexes.find(i => i.table === 'used').uses.length, 1);
  assert.match(indexIssues(i).join('\n'), /unused unused.by_a/);
});
test('computed literal index names and helper table arguments resolve without executing repository code', t => {
  const i = sourceFixture(
    t,
    `throw Error('must never execute'); const tables = {
    one: defineTable({a: v.string()}).index('by_a', ['a']),
    two: defineTable({a: v.string()}).index('by_a', ['a']),
  };`,
    `const indexed = (ctx, table) => ctx.db.query(table);
    const name = true ? 'by_a' : 'by_a'; indexed(ctx, 'one').withIndex(name).first();`,
    `const code = "return await ctx.db.query('two').withIndex('by_a').take(1)";`,
  );
  assert.deepEqual(indexIssues(i), []);
});
test('unresolved dynamic query expressions fail instead of claiming an index is unused', t => {
  const i = sourceFixture(
    t,
    `const tables = { one: defineTable({a: v.string()}).index('by_a', ['a']) };`,
    `ctx.db.query(input.table).withIndex(input.index).first();`,
  );
  assert.match(indexIssues(i).join('\n'), /input.index/);
});
test('same-table prefixes require a definition-local reason even when both have callers', t => {
  const schema = reason => `const tables = { one: defineTable({a: v.string(), b: v.string()})
    ${reason ? '// index-order: Creation-time pagination within a must not reorder by b.' : ''}
    .index('a', ['a']).index('ab', ['a', 'b']) };`;
  const queries = `ctx.db.query('one').withIndex('a').paginate(opts); ctx.db.query('one').withIndex('ab').first();`;
  assert.match(indexIssues(sourceFixture(t, schema(false), queries)).join('\n'), /index-order:/);
  assert.deepEqual(indexIssues(sourceFixture(t, schema(true), queries)), []);
});

test('sandbox query table arrays resolve to every finite table without running the script', t => {
  const i = sourceFixture(
    t,
    `const tables = {
    one: defineTable({a: v.string()}).index('a', ['a']),
    two: defineTable({a: v.string()}).index('a', ['a']),
  };`,
    '',
    "const tables = ['one', 'two']; const source = `return ctx.db.query(${JSON.stringify(tables[i])}).withIndex('a').first()`; throw Error('never run');",
  );
  assert.deepEqual(indexIssues(i), []);
});
