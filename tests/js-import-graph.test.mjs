// SPDX-License-Identifier: Apache-2.0
// Issue 63d241db: any JS/TS repository gets import-graph test selection in preflight, not only Forge.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/state/hash.js';
import { preflightPlan, preflightRuntime } from '../dist/agent-preflight.js';
import { importGraphTests, jsImportGraph } from '../dist/js-import-graph.js';
import { projectTestRunner, runnerSelection, runnerTestPath } from '../dist/project-test-runner.js';

const healthy = { status: 'healthy', checkedAt: new Date().toISOString(), probeMs: 1 };
test.beforeEach(t => t.mock.method(preflightRuntime, 'filesystemEventHealth', () => healthy));

/** A pnpm monorepo: a library with built exports, an app with a tsconfig alias, a computed import. */
const repo = {
  'package.json': JSON.stringify({
    name: 'mono',
    private: true,
    packageManager: 'pnpm@9.12.0',
    scripts: { test: 'vitest' },
    devDependencies: { vitest: '3.2.4', react: '19.0.0' },
  }),
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n  - apps/*\n',
  'tsconfig.base.json': '{ // comments are allowed\n "compilerOptions": { "strict": true } }\n',
  'packages/core/package.json': JSON.stringify({
    name: '@mono/core',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './math/*': './dist/math/*.js',
    },
  }),
  'packages/core/src/index.ts': "export * from './math/sum';\nexport { label } from './label';\n",
  'packages/core/src/math/sum.ts': 'export const sum = (a: number, b: number) => a + b;\n',
  'packages/core/src/math/sum.test.ts': "import { sum } from './sum';\n",
  'packages/core/src/label.ts': "export const label = 'x';\n",
  'packages/core/src/label.test.ts': "import { label } from './label.js';\n",
  'packages/ui/package.json': JSON.stringify({
    name: '@mono/ui',
    dependencies: { '@mono/core': 'workspace:*' },
  }),
  'packages/ui/index.tsx':
    "import React from 'react';\nimport { sum } from '@mono/core/math/sum';\nexport const Ui = () => sum(1, 2);\n",
  'packages/ui/ui.test.tsx': "import { Ui } from './index';\n",
  'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@mono/ui': 'workspace:*' } }),
  'apps/web/tsconfig.json':
    '{ "extends": "../../tsconfig.base.json", "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }\n',
  'apps/web/src/app.ts':
    "import { Ui } from '@mono/ui';\nimport { format } from '@/format';\nexport const app = [Ui, format];\n",
  'apps/web/src/app.test.ts': "import { app } from './app';\n",
  'apps/web/src/format.ts': 'export const format = String;\n',
  'apps/web/src/format.test.ts': "import { format } from '@/format';\n",
  'apps/web/src/plugins.ts': 'export const load = (name: string) => import(`./plugins/${name}`);\n',
  'apps/web/src/plugins.test.ts': "import { load } from './plugins';\n",
  'apps/web/src/standalone.test.ts': "import { expect } from 'vitest';\n",
  'docs/guide.md': '# Guide\n',
};
const paths = Object.keys(repo);
const graph = () => {
  const built = jsImportGraph(paths, path => repo[path]);
  assert(!('error' in built), built.error);
  return built;
};
const runner = projectTestRunner(repo['package.json'], () => paths).runner;
const tests = paths.filter(path => runnerTestPath(runner, path));

test('a change selects every test that imports it, through relative, workspace and alias imports', () => {
  const g = graph();
  assert.deepEqual(importGraphTests(g, tests, ['packages/core/src/math/sum.ts']).tests, [
    'apps/web/src/app.test.ts', // app → @mono/ui → @mono/core/math/sum (exports pattern, dist read as src)
    'apps/web/src/plugins.test.ts', // a computed import may load anything: selected for every code change
    'packages/core/src/math/sum.test.ts',
    'packages/ui/ui.test.tsx',
  ]);
  // The core entry is not reached from sum: label.ts alone selects label.test.ts and the open test.
  assert.deepEqual(importGraphTests(g, tests, ['packages/core/src/label.ts']).tests, [
    'apps/web/src/plugins.test.ts',
    'packages/core/src/label.test.ts',
  ]);
  // tsconfig `paths` alias through a relative `extends` chain.
  assert.deepEqual(importGraphTests(g, tests, ['apps/web/src/format.ts']).tests, [
    'apps/web/src/app.test.ts',
    'apps/web/src/format.test.ts',
    'apps/web/src/plugins.test.ts',
  ]);
  assert.deepEqual([...g.open], ['apps/web/src/plugins.ts']);
  assert.equal(g.unread, 0);
});

test('a bare import no manifest declares opens its importer; a package with no resolvable entry is whole', () => {
  const g = jsImportGraph(
    [
      ...paths,
      'apps/web/src/magic.ts',
      'apps/web/src/magic.test.ts',
      'packages/raw/package.json',
      'packages/raw/a.ts',
    ],
    path =>
      ({
        'apps/web/src/magic.ts': "import 'virtual:unknown';\nimport '@mono/raw';\n",
        'apps/web/src/magic.test.ts': "import './magic';\n",
        'packages/raw/package.json': JSON.stringify({ name: '@mono/raw', main: './missing.js' }),
        'packages/raw/a.ts': 'export {};\n',
      })[path] ?? repo[path],
  );
  assert(g.open.has('apps/web/src/magic.ts'));
  const all = [...tests, 'apps/web/src/magic.test.ts'];
  assert(importGraphTests(g, all, ['packages/raw/a.ts']).tests.includes('apps/web/src/magic.test.ts'));
  // Docs and untraced files: nothing in the graph reaches them.
  assert.deepEqual(importGraphTests(g, all, ['docs/guide.md']).tests, []);
  assert.deepEqual(importGraphTests(g, all, ['apps/web/src/new.ts']).untraced, ['apps/web/src/new.ts']);
});

test('runner selection adds the import-graph tests to the path-named ones and says so', () => {
  const imported = importGraphTests(graph(), tests, ['packages/core/src/math/sum.ts']);
  const selected = runnerSelection(runner, paths, ['packages/core/src/math/sum.ts'], imported);
  assert.deepEqual(selected.tests, [
    'apps/web/src/app.test.ts',
    'apps/web/src/plugins.test.ts',
    'packages/core/src/math/sum.test.ts',
    'packages/ui/ui.test.tsx',
  ]);
  assert.match(
    selected.reason,
    /1 named for a changed module and 3 more reached through imports \(1 through computed imports\)/,
  );
  // Without a graph (hosted reads) selection stays path-only, as before.
  assert.deepEqual(runnerSelection(runner, paths, ['packages/core/src/math/sum.ts']).tests, [
    'packages/core/src/math/sum.test.ts',
  ]);
});

test('preflight on a pnpm monorepo plans the tests that import the change, never Forge commands', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-js-graph-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'lane');
  for (const [path, body] of Object.entries(repo)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const files = paths.map(path => ({ path, blob: digest(repo[path]), mode: 'file' }));
  const plan = preflightPlan(
    root,
    { paths: ['packages/core/src/math/sum.ts'], complete: true },
    { laneId: '00000000-0000-4000-8000-000000000001', files },
  );
  assert.equal(plan.status, 'planned');
  // The import graph names exactly the tests that reach the change; the package tier then adds the
  // other test files of the affected packages (src/package-graph.ts).
  const tiers = plan.local.tierTests;
  assert.deepEqual([...(tiers.mandatory ?? []), ...tiers.direct].sort(), [
    'apps/web/src/app.test.ts',
    'apps/web/src/plugins.test.ts',
    'packages/core/src/math/sum.test.ts',
    'packages/ui/ui.test.tsx',
  ]);
  assert.deepEqual(plan.tests.slice(0, 4).sort(), [...tiers.direct].sort());
  assert.match(plan.command, /^pnpm exec vitest run /);
  assert.doesNotMatch(plan.command, /--test|check-runtime/);
  assert.match(plan.local.summary, /reached through imports/);
});

test('the graph stays inside its bounds and reads no file outside the inventory', () => {
  const many = Array.from({ length: 20_001 }, (_, i) => `src/m${i}.ts`);
  assert.match(jsImportGraph(many, () => '').error, /exceed the import graph bound/);
  const read = [];
  jsImportGraph(paths, path => (read.push(path), repo[path]));
  assert(read.every(path => paths.includes(path)));
  assert(!read.some(path => path.endsWith('.md') || path.endsWith('.yaml')));
});
