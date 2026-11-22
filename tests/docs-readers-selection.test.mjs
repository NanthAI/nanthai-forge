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
  // The retired-wording guard walks docs/agents/ by relative path (preflight-miss fix 4, d3357f40): a
  // reader of every document there. The bound on the other readers stays.
  const walker = at('tests', 'approve-land-wording.test.mjs');
  assert.ok(selection.tests.includes(walker), `${walker} walks docs/agents/`);
  const others = selection.tests.filter(test => test !== walker);
  assert.ok(others.length <= 6, `${others.length} readers`);
  // A document no test names adds only the repo-wide guards that scan its folder (Issue ec7960f9).
  const unnamed = at('docs', 'no-test-reads-this-document.md');
  const lonely = standardSelection({ files, paths: [unnamed] });
  assert.equal(lonely.scope, 'docs');
  assert.deepEqual(lonely.tests, [...scanReaders(files, [unnamed]).keys()].sort());
  for (const test of lonely.tests) assert.match(lonely.reasons[test].detail, /^Scans docs\//);
});

test('an extensionless document link read inside a test covers the corresponding split document', () => {
  const reader = at('tests', 'guide-links.test.mjs');
  const linkOnly = at('tests', 'guide-label.test.mjs');
  const files = new Map([
    ...fixture(),
    [
      reader,
      `test('linked heading', () => {
      // The guide is assembled from docs/workflow.md. See also docs/other.md.
      const links = ['/docs/workflow/#start'];
      for (const href of links) readDocument(root, href.split('#')[0].slice(1, -1) + '.md');
    });`,
    ],
    [linkOnly, "test('label', () => assert.ok('/docs/workflow/#start'));"],
  ]);
  const section = at('docs', 'workflow.d', 'sections', 'start.md');
  assert.deepEqual([...docsReaders(files, [section]).keys()], [reader]);
  assert.deepEqual([...docsReaders(files, [at('docs', 'unrelated.md')]).keys()], []);
  const mixed = selectPreflightTests({ files, paths: ['src/a.ts', at('docs', 'other.md'), section] });
  assert.ok(mixed.treeGuards.includes(reader));
  assert.ok(!mixed.tests.includes(linkOnly));
});
