// SPDX-License-Identifier: Apache-2.0
// Issue ec7960f9 item 4: a repo-wide guard that lists a folder and checks every file in it is that
// folder's coverage, found from its own text, for any repository (synthetic inventories only).
import assert from 'node:assert/strict';
import test from 'node:test';
import { scanCovers, scanReaders, treeScanners } from '../scripts/test-tree-scanners.mjs';
import { selectPreflightTests, selectTests } from '../scripts/test-impact.mjs';

const header = "import { readdirSync, readFileSync } from 'node:fs';\nimport { join } from 'node:path';\n";
const scansOf = (text, path = 'tests/guard.test.mjs') =>
  treeScanners(new Map([[path, header + text]])).get(path) ?? [];
const folders = text =>
  scansOf(text)
    .map(scan => `${scan.folder}${scan.recursive ? '/**' : ''}`)
    .sort();

test('folder lists, callbacks, named walks, URLs and globs rooted at the repository are scans', () => {
  // A `for…of` folder list joined to the root, recursive by option.
  assert.deepEqual(
    folders(`const repo = new URL('..', import.meta.url).pathname;
      for (const dir of ['lib', 'app']) for (const e of readdirSync(join(repo, dir), { recursive: true })) readFileSync(e);`),
    ['app/**', 'lib/**'],
  );
  // A callback parameter takes the receiver's folders; the walk recurses by calling itself.
  assert.deepEqual(
    folders(`const root = new URL('..', import.meta.url).pathname;
      const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [e]);
      const found = ['web/src', 'server'].flatMap(dir => walk(join(root, dir)));`),
    ['server/**', 'web/src/**'],
  );
  // A named function's parameter takes every call site's folder.
  assert.deepEqual(
    folders(`const root = process.cwd();
      function scan(directory) { for (const e of readdirSync(directory)) if (e.isDirectory()) scan(join(directory, e.name)); }
      scan(join(root, 'pkg'));`),
    ['pkg/**'],
  );
  // `./` and `../` resolve against the test file; one listing is not recursive.
  assert.deepEqual(folders(`readdirSync(new URL('../modules', import.meta.url));`), ['modules']);
  assert.deepEqual(folders(`readdirSync(new URL('./', import.meta.url));`), ['tests']);
  // A glob scans below the part before its first wildcard.
  assert.deepEqual(folders(`globSync('src/**/*.py', { cwd: process.cwd() });`), ['src/**']);
  // The repository root itself, named only through import.meta.
  assert.deepEqual(folders(`readdirSync(new URL('..', import.meta.url));`), ['']);
});

test('temporary and fixture folders are not repository scans', () => {
  for (const text of [
    `import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os';
     const dir = mkdtempSync(join(tmpdir(), 'case-')); readdirSync(join(dir, 'src'));`,
    `export function list(root) { return readdirSync(join(root, 'src')); }`,
    `const cache = someHelper(); readdirSync(cache);`,
  ])
    assert.deepEqual(scansOf(text), [], text);
  // Only test files are parsed: a helper's own scan is not a test's coverage by itself.
  assert.equal(
    treeScanners(new Map([['tests/helper.mjs', header + "readdirSync(new URL('../src', import.meta.url));"]]))
      .size,
    0,
  );
});

test('a scan covers files in its folder: below it when recursive, directly in it when not', () => {
  assert.ok(scanCovers({ folder: 'src', recursive: true }, 'src/a/b.ts'));
  assert.ok(scanCovers({ folder: 'src', recursive: false }, 'src/b.ts'));
  assert.ok(!scanCovers({ folder: 'src', recursive: false }, 'src/a/b.ts'));
  assert.ok(!scanCovers({ folder: 'src', recursive: true }, 'srcs/b.ts'));
  assert.ok(scanCovers({ folder: '', recursive: false }, 'README.md'));
  assert.ok(!scanCovers({ folder: '', recursive: false }, 'docs/a.md'));
});

/** A small repository: one module, its own test, and a rules guard that scans `lib/`. */
const inventory = () =>
  new Map([
    ['package.json', '{"scripts":{"test":"node --test tests/*.test.mjs"}}'],
    ['src/lib-entry.ts', "export const entry = 'x';"],
    ['src/other.ts', "export const other = 'y';"],
    ['tests/lib-entry.test.mjs', "import '../dist/lib-entry.js';"],
    ['tests/other.test.mjs', "import '../dist/other.js';"],
    [
      'tests/rules.test.mjs',
      `${header}const repo = new URL('..', import.meta.url).pathname;
       for (const dir of ['src']) for (const e of readdirSync(join(repo, dir), { recursive: true })) readFileSync(join(repo, dir, e));`,
    ],
  ]);

test('selection makes the scanning guard explicit coverage and preflight runs it as mandatory', () => {
  const files = inventory();
  const selection = selectTests({ files, paths: ['src/lib-entry.ts'] });
  assert.ok(selection.tests.includes('tests/rules.test.mjs'));
  assert.deepEqual(selection.reasons['tests/rules.test.mjs'], {
    kind: 'explicit',
    changedPath: 'src/lib-entry.ts',
    detail: 'Scans src/, which holds changed src/lib-entry.ts',
  });
  const plan = selectPreflightTests({
    files,
    paths: ['src/lib-entry.ts'],
    hubBudget: { seconds: 1, secondsFor: () => 4 },
  });
  assert.ok(plan.tiers.find(item => item.tier === 'mandatory').tests.includes('tests/rules.test.mjs'));
  assert.ok(!plan.deferredTests.includes('tests/rules.test.mjs'));
  // A change outside the scanned folder does not select it.
  assert.deepEqual(scanReaders(files, ['tests/other.test.mjs', 'package.json']).size, 0);
});

test('a docs-only change selects the guards that scan the documents folder, and only those', () => {
  const files = new Map([
    ...inventory(),
    [
      'tests/docs-rules.test.mjs',
      `${header}for (const e of readdirSync(new URL('../docs', import.meta.url))) readFileSync(e);`,
    ],
  ]);
  const plan = selectPreflightTests({ files, paths: ['docs/guide.md'] });
  assert.deepEqual(plan.tests, ['tests/docs-rules.test.mjs']);
  assert.deepEqual(plan.docsReaders['tests/docs-rules.test.mjs'], {
    doc: 'docs/guide.md',
    via: 'tests/docs-rules.test.mjs',
    scan: 'docs',
  });
  assert.deepEqual(selectPreflightTests({ files, paths: ['README.md'] }).tests, []);
});
