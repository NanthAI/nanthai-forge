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
