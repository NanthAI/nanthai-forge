// SPDX-License-Identifier: Apache-2.0
// The hosted and machine check selects, for a docs-only change, the tests local preflight selects
// (Issue d90e0a2d): the readers of the changed documents (scripts/docs-readers.mjs), nothing more.
import assert from 'node:assert/strict';
import test from 'node:test';
import { docsReaders } from '../scripts/docs-readers.mjs';
import { scanReaders } from '../scripts/test-tree-scanners.mjs';
import { selectPreflightTests, sourceFiles, standardSelection } from '../scripts/test-impact.mjs';

// Paths are built at run time: a literal repo path here would make this file a reader of it.
const at = (...parts) => parts.join('/');

// Synthetic inventory: one document a test reads, one nothing reads, one code file.
const fixture = () =>
  new Map(
    Object.entries({
      'package.json': '{"type":"module","scripts":{}}',
      'package-lock.json': '{}',
      'src/a.ts': 'export const n = 1;',
      'tests/a.test.mjs': "import '../dist/a.js';",
      'tests/reads-guide.test.mjs': "readFileSync(new URL('../docs/x/guide.md', import.meta.url));",
      'tests/unrelated.test.mjs': '',
    }),
  );

test('a docs-only standard selection keeps the docs scope and runs the tests that read the change', () => {
  const files = fixture();
  const selection = standardSelection({ files, paths: ['docs/x/guide.md'] });
  assert.equal(selection.scope, 'docs');
  assert.deepEqual(selection.tests, ['tests/reads-guide.test.mjs']);
  assert.deepEqual(selection.reasons['tests/reads-guide.test.mjs'], {
    kind: 'explicit',
    changedPath: 'docs/x/guide.md',
    detail: 'Reads changed document docs/x/guide.md',
  });
  assert.match(
    selection.reason,
    /^Only Markdown documentation changed .*; plus the 1 test file\(s\) that read/,
  );
  // The same selector as local preflight, so the two cannot drift apart.
  assert.deepEqual(selection.tests, selectPreflightTests({ files, paths: ['docs/x/guide.md'] }).tests);
});

test('a document no test reads still runs 0 test files', () => {
  const files = fixture();
  const selection = standardSelection({ files, paths: ['docs/y.md'] });
  assert.equal(selection.scope, 'docs');
  assert.deepEqual(selection.tests, []);
  assert.equal(selection.reasons, undefined);
  assert.doesNotMatch(selection.reason, /plus the/);
});

test('the main audit and an explicit full run are not narrowed by the readers', () => {
  const files = fixture();
  for (const input of [{ mainCheck: { channel: 'main' } }, { env: { FORGE_CHECK_FULL: '1' } }]) {
    const full = standardSelection({ files, paths: ['docs/x/guide.md'], ...input });
    assert.equal(full.scope, 'full');
    assert.deepEqual(full.tests, [...files.keys()].filter(p => /^tests\/[^/]+\.test\.mjs$/.test(p)).sort());
  }
});

test('replay: a docs-only change to the brief rules selects the check-brief fixture test', () => {
  const files = sourceFiles(new URL('..', import.meta.url).pathname);
  const doc = at('docs', 'agents', 'briefings.md');
  const selection = standardSelection({ files, paths: [doc] });
  assert.equal(selection.scope, 'docs');
  for (const reader of [at('tests', 'check-brief.test.mjs'), at('tests', 'planning-search.test.mjs')])
    assert.ok(selection.tests.includes(reader), `${reader} reads ${doc}`);
  assert.deepEqual(selection.tests, [...docsReaders(files, [doc]).keys()].sort());
  assert.ok(selection.tests.length <= 6, `${selection.tests.length} readers`);
  // A document no test names adds only the repo-wide guards that scan its folder (Issue ec7960f9).
  const unnamed = at('docs', 'no-test-reads-this-document.md');
  const lonely = standardSelection({ files, paths: [unnamed] });
  assert.equal(lonely.scope, 'docs');
  assert.deepEqual(lonely.tests, [...scanReaders(files, [unnamed]).keys()].sort());
  for (const test of lonely.tests) assert.match(lonely.reasons[test].detail, /^Scans docs\//);
});
