// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Convex rejects a table with two indexes of the same name only at deploy time; catch merge duplicates here.
test('every Convex table defines each index name once', () => {
  const source = readFileSync(new URL('../convex/schema.ts', import.meta.url), 'utf8');
  const tables = source.split(/\n\s*[A-Za-z0-9_]+:\s*defineTable\(/).slice(1);
  assert.ok(tables.length > 10);
  for (const table of tables) {
    const chain = table.split(/\),\n/)[0];
    const names = [...chain.matchAll(/\.(?:index|searchIndex|vectorIndex)\(\s*'([^']+)'/g)].map(m => m[1]);
    const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
    assert.deepEqual(duplicates, [], `duplicate index in table chain: ${chain.slice(0, 80)}`);
  }
});
