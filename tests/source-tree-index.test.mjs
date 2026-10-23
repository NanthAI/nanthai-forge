// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceTreeEntries } from '../dist/source-tree-index.js';
test('Code index retains every sorted path in bounded pages, with no source content', () => {
  const files = Array.from({ length: 251 }, (_, i) => ({
    path: `file-${250 - i}.ts`,
    blob: 'private bytes',
  }));
  const rows = sourceTreeEntries('head', files);
  const pages = rows.filter(r => r.collection === 'sourceTreePaths');
  assert.deepEqual(
    pages.map(r => JSON.parse(r.value).paths.length),
    [100, 100, 51],
  );
  assert.deepEqual(
    pages.flatMap(r => JSON.parse(r.value).paths),
    files.map(f => f.path).sort(),
  );
  assert(pages.every(r => r.parent === 'head'));
  assert(!JSON.stringify(rows).includes('private bytes'));
  assert.deepEqual(JSON.parse(rows.at(-1).value), { head: 'head', files: 251 });
  assert.equal(sourceTreeEntries('empty', []).length, 1);
});
