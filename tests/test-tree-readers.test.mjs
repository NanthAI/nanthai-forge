// SPDX-License-Identifier: Apache-2.0
// Item 5dcfce75, preflight-miss fix 4: a repo-wide guard test (it lists a folder through a plain
// relative path, or reads every file an import walk reaches) is a consumer of every file in that
// folder, found from what the test does, for any repository. Incident shapes: a rules test walking
// ['src', 'convex', …] by relative path (approve-land-wording, 2026-11-19) and an import-closure
// reader started from '.' (control-runtime-deps, failed on a comment "import(" on 2026-11-19). Both
// failed landing checks while preflight never selected them. Synthetic inventories only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { treeReaders } from '../scripts/test-tree-readers.mjs';
import { scanReaders } from '../scripts/test-tree-scanners.mjs';
import { selectPreflightTests, selectTests } from '../scripts/test-impact.mjs';

const header =
  "import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';\n" +
  "import { dirname, join, resolve } from 'node:path';\nimport { tmpdir } from 'node:os';\n";
/** A small repository: product modules in src/ and convex/, each with its own test. */
const repository = (extra = {}) =>
  new Map(
    Object.entries({
      'package.json': '{"scripts":{"test":"node --test tests/*.test.mjs"}}',
      'src/entry.ts': "import { help } from './helper.js';\nexport const entry = help;",
      'src/helper.ts': 'export const help = 1;',
      'convex/store.ts': 'export const store = 2;',
      'tests/entry.test.mjs': "import '../dist/entry.js';",
      'tests/store.test.mjs': "import '../convex/store.ts';",
      ...extra,
    }),
  );
const isTest = path => path.startsWith('tests/') && path.endsWith('.test.mjs');
const folders = text => {
  const files = repository({ 'tests/guard.test.mjs': header + text });
  return (treeReaders(files, isTest).get('tests/guard.test.mjs') ?? [])
    .map(scan => `${scan.folder}${scan.recursive ? '/**' : ''}${scan.code ? ' (code)' : ''}`)
    .sort();
};

/** approve-land-wording's shape: a walk over a list of relative folders. */
const wordingGuard = `const roots = ['src', 'convex', 'docs/agents'];
const files = [];
const walk = path => {
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
};
for (const root of roots) walk(root);
test('no retired word', () => files.map(file => readFileSync(file, 'utf8')));`;
/** control-runtime-deps' shape: a reader that follows import specifiers from entries, from '.'. */
const closureGuard = `import { entries } from '../scripts/runtime-list.mjs';
function closure(root, starts) {
  const seen = new Set();
  const visit = file => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const [, spec] of text.matchAll(/from '([^']+)'/g)) if (spec.startsWith('.')) visit(resolve(dirname(file), spec));
  };
  for (const entry of starts) visit(resolve(root, entry));
  return seen;
}
test('live list', () => closure('.', entries));
test('fixture', () => closure(mkdtempSync(join(tmpdir(), 'deps-')), ['entry.mjs']));`;

test('a walk from relative folders and an import-closure reader from the root are scans', () => {
  assert.deepEqual(folders(wordingGuard), ['convex/**', 'docs/agents/**', 'src/**']);
  assert.deepEqual(folders(closureGuard), ['/** (code)']);
  // One listing of a relative folder is not recursive; `./` is the working directory here.
  assert.deepEqual(folders("for (const name of readdirSync('./src')) readFileSync(join('src', name));"), [
    'src',
  ]);
  assert.deepEqual(folders("readdirSync(join('convex', 'x'), { recursive: true });"), ['convex/x/**']);
});

test('the memo answers only for the same test rule and skip set', () => {
  const files = repository({ 'tests/guard.test.mjs': header + wordingGuard });
  assert.equal(treeReaders(files, isTest).has('tests/guard.test.mjs'), true);
  assert.equal(
    treeReaders(files, isTest, new Set(['tests/guard.test.mjs'])).has('tests/guard.test.mjs'),
    false,
  );
  assert.equal(treeReaders(files, () => false).size, 0);
  assert.equal(treeReaders(files, isTest).has('tests/guard.test.mjs'), true);
});

test('temporary, unbound, outside and single computed reads are not scans', () => {
  for (const text of [
    "const dir = mkdtempSync(join(tmpdir(), 'case-')); readdirSync(join(dir, 'src'));",
    "export function list(root) { return readdirSync(join(root, 'src')); }",
    "import { cache } from './helper.mjs'; readdirSync(join(cache, 'src'));",
    "readdirSync('/etc'); readdirSync('../outside/src');",
    // A test that moves its working directory lists something else.
    "process.chdir(mkdtempSync(join(tmpdir(), 'x-'))); readdirSync('src');",
    // One computed read is not a walk: a function that does not call itself.
    "const read = name => readFileSync(join('src', name)); read('entry.ts'); read('helper.ts');",
    "readFileSync('src/entry.ts');",
    // A literal piece that leaves the repository drops the alternative, never keeps the folder before it.
    "readdirSync(resolve(import.meta.dirname, '..', '..', 'x'), { recursive: true });",
    "readdirSync(join('src', '../..'), { recursive: true });",
    "readdirSync(resolve('src', '/etc'), { recursive: true });",
  ])
    assert.deepEqual(folders(text), [], text);
});

test('landing selection makes both guards consumers of every file in their folder', () => {
  const files = repository({
    'scripts/runtime-list.mjs': "export const entries = ['dist/entry.js'];",
    'tests/wording.test.mjs': header + wordingGuard,
    'tests/runtime-deps.test.mjs': header + closureGuard,
  });
  const helper = selectTests({ files, paths: ['src/helper.ts'] });
  assert.ok(helper.tests.includes('tests/wording.test.mjs'));
  assert.ok(helper.tests.includes('tests/runtime-deps.test.mjs'));
  assert.equal(
    helper.reasons['tests/runtime-deps.test.mjs'].detail.startsWith('Scans the repository root'),
    true,
  );
  const store = selectTests({ files, paths: ['convex/store.ts'] });
  assert.equal(
    store.reasons['tests/wording.test.mjs'].detail,
    'Scans convex/, which holds changed convex/store.ts',
  );
  // A docs edit in a walked folder selects the walker as that document's reader; an import walk reads
  // no document, so a docs-only change elsewhere selects nothing.
  assert.deepEqual(selectPreflightTests({ files, paths: ['docs/agents/guide.md'] }).tests, [
    'tests/wording.test.mjs',
  ]);
  assert.deepEqual(selectPreflightTests({ files, paths: ['docs/other.md'] }).tests, []);
  // A test that walks nothing gains no edge.
  assert.equal(scanReaders(files, ['src/helper.ts']).has('tests/store.test.mjs'), false);
});

test('a comment-only edit keeps the guards that read the file in the local plan (control-runtime-deps)', () => {
  const files = repository({
    'scripts/runtime-list.mjs': "export const entries = ['dist/entry.js'];",
    'tests/runtime-deps.test.mjs': header + closureGuard,
  });
  const plan = selectPreflightTests({
    files,
    paths: ['src/helper.ts'],
    commentOnly: ['src/helper.ts'],
    hubBudget: { seconds: 180, secondsFor: () => 4 },
  });
  const mandatory = plan.tiers.find(item => item.tier === 'mandatory').tests;
  assert.ok(mandatory.includes('tests/runtime-deps.test.mjs'), JSON.stringify(plan.tiers));
  assert.deepEqual(plan.treeGuards, ['tests/runtime-deps.test.mjs']);
  assert.ok(!plan.deferredTests.includes('tests/runtime-deps.test.mjs'));
});
