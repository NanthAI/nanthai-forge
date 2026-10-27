// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { convexSchemaErrors } from '../dist/integration-preview-schema.js';

test('duplicate indexes within a table are detected across quote styles and index kinds', () => {
  const errors = convexSchemaErrors(`export default defineSchema({
    a: defineTable({ value: v.string() }).index("by_value", ["value"])
      .searchIndex('by_value', { searchField: 'value' }).vectorIndex(\`by_value\`, {}),
    b: defineTable({}).index('by_value', []),
  });`);
  assert.equal(errors.length, 2);
  assert.ok(errors.every(error => /convex\/schema.ts:\d+:\d+: duplicate index name "by_value"/.test(error)));
});

test('same names in different tables and index-like comments/strings do not conflict', () => {
  assert.deepEqual(
    convexSchemaErrors(`
    // .index('same', []).index('same', [])
    const string = ".index('same', []).index('same', [])";
    defineSchema({ a: defineTable({}).index('same', []), b: defineTable({}).index('same', []) });
    other.index('same', []).index('same', []);
  `),
    [],
  );
});
