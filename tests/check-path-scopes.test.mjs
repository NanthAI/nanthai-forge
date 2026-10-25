// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectTests, standardSelection } from '../scripts/test-impact.mjs';

const files = new Map(
  Object.entries({
    'src/plugin-config.ts': 'export const config = 1;',
    'web/src/App.tsx': 'export const App = 1;',
    'convex/schema.ts': 'export const schema = 1;',
    'convex/first.ts': 'export const first = 1;',
    'convex/second.ts': 'export const second = 1;',
    'convex/_generated/api.d.ts': 'export declare const api: unknown;',
    'tests/core.test.mjs': "import '../dist/plugin-config.js'",
    'tests/ui-flow.test.mjs': "readFileSync('../web/src/App.tsx')",
    'tests/first.test.mjs': "await import(moduleUrl('../convex/first.ts'))",
    'tests/second.test.mjs': "await import(moduleUrl('../convex/second.ts'))",
    'tests/boundaries.test.mjs': '',
    'tests/unrelated.test.mjs': '',
    'tests/files.test.mjs': '',
    'tests/ci-scope.test.mjs': '',
    'tests/test-impact.test.mjs': '',
    'tests/check-path-scopes.test.mjs': '',
  }),
);
const select = (paths, extra = {}) => selectTests({ files, paths, ...extra });

test('a pinned Markdown-only change reaches the docs path without enabling behavior scoping', () => {
  const docs = standardSelection({ files, paths: ['docs/development.md'], env: {} });
  assert.equal(docs.scope, 'docs');
  assert.deepEqual(docs.tests, []);
  assert.equal(standardSelection({ files, paths: null, env: {} }).scope, 'full');
  for (const paths of [['../docs/hidden.md'], ['docs/development.md', 'package.json']])
    assert.equal(standardSelection({ files, paths, env: {} }).scope, 'full');
  assert.equal(
    standardSelection({ files, paths: ['docs/development.md'], env: { FORGE_CHECK_FULL: '1' } }).scope,
    'full',
  );
});

test('ignore/tool configuration selects ignore regressions while static checks remain required', () => {
  const result = select(['.gitignore', '.prettierignore']);
  assert.equal(result.scope, 'scoped');
  assert.equal(result.domain, 'tooling');
  assert.ok(result.tests.includes('tests/boundaries.test.mjs'));
  assert.ok(!result.tests.includes('tests/unrelated.test.mjs'));
  assert.match(result.reason, /Repository ignore rules/);
});

test('Oxc configuration changes retain static checks without widening behavior scope', () => {
  for (const path of ['.oxlintrc.json', '.oxfmtrc.json']) {
    const result = select([path]);
    assert.equal(result.scope, 'scoped');
    assert.equal(result.domain, 'tooling');
    assert.match(result.reason, /Formatting\/lint config/);
  }
});

test('manual QA/browser fixtures, including deletions, select UI regression coverage', () => {
  for (const path of [
    'tests/browser/planning-code.html',
    'tests/fixtures/qa-m-code.tsx',
    'scripts/qa-h-preview.mjs',
  ]) {
    const result = select([path]);
    assert.equal(result.scope, 'scoped', path);
    assert.equal(result.domain, 'web', path);
    assert.ok(result.tests.includes('tests/ui-flow.test.mjs'), path);
    assert.ok(!result.tests.includes('tests/core.test.mjs'), path);
  }
});

test('Convex schema/functions share backend coverage; generated API includes web consumers', () => {
  for (const path of ['convex/schema.ts', 'convex/first.ts', 'convex/_generated/api.js']) {
    const result = select([path]);
    assert.equal(result.scope, 'scoped');
    assert.equal(result.domain, 'convex');
    assert.ok(result.tests.includes('tests/first.test.mjs'));
    assert.ok(result.tests.includes('tests/second.test.mjs'));
    assert.ok(!result.tests.includes('tests/core.test.mjs'));
    if (path.includes('_generated')) assert.ok(result.tests.includes('tests/ui-flow.test.mjs'));
  }
});

test('core config-named modules stay core; TypeScript/Vite config widens only to its domain', () => {
  for (const path of ['src/plugin-config.ts', 'tsconfig.json']) {
    const result = select([path]);
    assert.equal(result.scope, 'scoped');
    assert.equal(result.domain, 'core');
    assert.ok(result.tests.includes('tests/core.test.mjs'));
    assert.ok(!result.tests.includes('tests/first.test.mjs'));
  }
  for (const path of ['web/vite.config.ts', 'web/tsconfig.json']) {
    const result = select([path]);
    assert.equal(result.domain, 'web');
    assert.ok(result.tests.includes('tests/ui-flow.test.mjs'));
    assert.ok(!result.tests.includes('tests/core.test.mjs'));
  }
});

test('helper/data fixtures follow consuming tests and an orphan still forces full', () => {
  const consumers = new Map([
    ...files,
    ['tests/helper.mjs', 'export const value = 1;'],
    ['tests/fixtures/input.json', '{}'],
    [
      'tests/helper.test.mjs',
      "import './helper.mjs'; readFileSync(new URL('./fixtures/input.json', import.meta.url))",
    ],
  ]);
  for (const path of ['tests/helper.mjs', 'tests/fixtures/input.json']) {
    const result = select([path], { files: consumers });
    assert.equal(result.scope, 'scoped');
    assert.ok(result.tests.includes('tests/helper.test.mjs'));
    assert.ok(!result.tests.includes('tests/core.test.mjs'));
  }
  consumers.set('tests/fixtures/orphan.json', '{}');
  assert.equal(select(['tests/fixtures/orphan.json'], { files: consumers }).scope, 'full');
  assert.equal(select(['src/deleted.ts']).scope, 'full');
  assert.equal(select(['unknown.txt']).scope, 'full');
});

test('a separate changed test cannot disguise a fixture with no consuming test', () => {
  const orphan = new Map([...files, ['tests/fixtures/orphan.json', '{}']]);
  assert.equal(
    select(['tests/fixtures/orphan.json', 'tests/core.test.mjs'], { files: orphan }).scope,
    'full',
  );
});

test('shared test runtime/scheduler changes select every test; mixed domains are explicit', () => {
  for (const path of ['tests/check-runtime.mjs', 'tests/worker-budget.mjs'])
    assert.deepEqual(select([path]).tests, [...files.keys()].filter(p => p.endsWith('.test.mjs')).sort());
  const mixed = select(['src/plugin-config.ts', 'web/src/App.tsx']);
  assert.equal(mixed.domain, 'mixed');
  assert.match(mixed.reason, /core\+web scope/);
});
