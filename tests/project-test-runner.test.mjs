// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/portable-hash.js';
import { sourceTree } from '../dist/source-tree.js';
import { preflightPlan, preflightRuntime, runPreflight } from '../dist/agent-preflight.js';
import {
  projectTestRunner,
  runnerCommand,
  runnerSelection,
  runnerTestPath,
} from '../dist/project-test-runner.js';
import { intentContractSelection } from '../dist/intent-contract-selection.js';
import { contractTestPath } from '../dist/intent-test-contract.js';
import { semanticCheckCommand } from '../dist/semantic-check-command.js';

const laneId = '33333333-3333-4333-8333-333333333333';
const healthy = {
  ok: true,
  latencyMs: 1,
  fseventsdRssMb: null,
  fseventsdCpuPercent: null,
  reason: null,
  attempts: [],
};
test.beforeEach(t => t.mock.method(preflightRuntime, 'filesystemEventHealth', () => healthy));
const resolve = (manifest, paths = []) =>
  projectTestRunner(manifest === undefined ? undefined : JSON.stringify(manifest), () => paths);

/** A pnpm workspace with vitest-style tests beside their modules; no tests/ folder, no node --test. */
const pnpmVitest = {
  'package.json': JSON.stringify({
    name: 'fixture',
    packageManager: 'pnpm@9.12.0',
    scripts: { test: 'vitest' },
    devDependencies: { vitest: '3.2.4' },
  }),
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n  - apps/*\n',
  'packages/core/src/sum.ts': 'export const sum = (a: number, b: number) => a + b;\n',
  'packages/core/src/sum.test.ts': "import { sum } from './sum';\n",
  'packages/core/src/index.ts': "export * from './sum';\n",
  'packages/core/src/index.test.ts': "import './index';\n",
  'apps/web/src/index.ts': "import '@fixture/core';\n",
  'apps/web/src/__tests__/index.test.ts': "import '../index';\n",
  'apps/web/src/format.ts': 'export const format = String;\n',
  'apps/web/src/format.spec.tsx': "import './format';\n",
  'node_modules/vitest/dist/a.test.js': '',
  'docs/guide.md': '# Guide\n',
};

function lane(t, bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-project-runner-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, body] of Object.entries(bytes)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const files = () =>
    Object.entries(bytes)
      .filter(([path]) => !path.startsWith('node_modules/'))
      .map(([path, body]) => ({ path, blob: digest(body), mode: 'file' }));
  return {
    root,
    plan: (paths, options) =>
      preflightPlan(root, { paths, complete: true }, { laneId, files: files() }, options),
    run: plan => runPreflight(root, laneId, digest(JSON.stringify(files())), plan, sourceTree(files())),
  };
}

test("Forge's own package.json infers Forge's Node layout, so its preflight and tests read are unchanged", () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const resolved = resolve(manifest);
  assert.equal(resolved.status, 'available');
  assert.equal(resolved.runner.layout, 'forge-node');
  assert.equal(resolved.runner.source, 'test-script');
  assert.deepEqual(resolved.runner.globs, ['tests/*.test.mjs']);
  assert.deepEqual(resolved.runner.command, [
    'node',
    '--import',
    './tests/check-runtime.mjs',
    '--test',
    '{files}',
  ]);
});

test('the runner is inferred from the test script, then dependencies, then Node test files; never guessed', () => {
  const vitest = resolve(JSON.parse(pnpmVitest['package.json']), Object.keys(pnpmVitest));
  assert.equal(vitest.runner.program, 'vitest');
  assert.deepEqual(runnerCommand(vitest.runner, ['a.test.ts']), [
    'pnpm',
    'exec',
    'vitest',
    'run',
    'a.test.ts',
  ]);
  assert.equal(vitest.runner.layout, 'generic');

  const jest = resolve({ devDependencies: { jest: '30.0.0' } }, ['yarn.lock']);
  assert.equal(jest.runner.source, 'dependency');
  assert.deepEqual(runnerCommand(jest.runner, ['x.test.js']), [
    'yarn',
    'jest',
    '--runTestsByPath',
    'x.test.js',
  ]);
  assert.ok(runnerTestPath(jest.runner, 'src/__tests__/x.js'));

  const node = resolve({ scripts: { test: 'NODE_ENV=test node --test --test-reporter spec test/' } });
  assert.deepEqual(runnerCommand(node.runner, ['test/a.test.js']), [
    'node',
    '--test',
    '--test-reporter',
    'spec',
    'test/a.test.js',
  ]);
  assert.ok(runnerTestPath(node.runner, 'test/a.test.js'));
  assert.ok(!runnerTestPath(node.runner, 'src/a.test.js'));

  const files = resolve(undefined, ['lib/a.test.js', 'node_modules/x/b.test.js']);
  assert.equal(files.runner.source, 'files');
  assert.equal(files.runner.layout, 'generic');
  assert.equal(resolve({}, ['tests/a.test.mjs', 'tests/fixture.mjs']).runner.layout, 'forge-node');

  for (const script of ['turbo run test', 'make test', 'pnpm -r test', 'cargo test']) {
    const none = resolve({ scripts: { test: script }, devDependencies: { vitest: '3.2.4' } });
    assert.equal(none.status, 'unavailable', script);
    assert.match(none.reason, /no test runner declared/);
    assert.match(none.reason, /forge\.preflight\.tests/);
  }
  assert.equal(resolve({ name: 'x' }, ['README.md', 'src/a.ts']).status, 'unavailable');
});

test('a declared runner wins and a malformed declaration fails loudly instead of falling back', () => {
  const declared = resolve({
    scripts: { test: 'vitest' },
    forge: { preflight: { tests: { glob: 'spec/**/*.spec.ts', command: ['vp', 'test', 'run', '{files}'] } } },
  });
  assert.equal(declared.runner.source, 'declared');
  assert.deepEqual(runnerCommand(declared.runner, ['spec/a.spec.ts']), [
    'vp',
    'test',
    'run',
    'spec/a.spec.ts',
  ]);
  assert.throws(
    () => resolve({ forge: { preflight: { tests: { glob: '../x/*.ts', command: ['x'] } } } }),
    /forge\.preflight\.tests/,
  );
  assert.throws(
    () => resolve({ forge: { preflight: { tests: { glob: '*.ts' } } } }),
    /forge\.preflight\.tests/,
  );
  assert.throws(() => runnerCommand(declared.runner, []), /No test files selected/);
});

test('path selection: changed tests, then the closest tests named for a changed module; docs select none', () => {
  const { runner } = resolve(JSON.parse(pnpmVitest['package.json']), Object.keys(pnpmVitest));
  const paths = Object.keys(pnpmVitest);
  const selected = runnerSelection(runner, paths, ['apps/web/src/index.ts', 'apps/web/src/format.spec.tsx']);
  assert.deepEqual(selected.changedTests, ['apps/web/src/format.spec.tsx']);
  assert.deepEqual(
    selected.namedTests,
    ['apps/web/src/__tests__/index.test.ts'],
    'the closest index test only',
  );
  assert.ok(!selected.available.some(path => path.startsWith('node_modules/')));
  assert.equal(runnerSelection(runner, paths, ['docs/guide.md']).scope, 'docs');
  assert.deepEqual(runnerSelection(runner, paths, ['pnpm-lock.yaml']).tests, []);
});

test('preflight on a pnpm vitest workspace plans its own tests and runner command, not node --test', t => {
  const f = lane(t, pnpmVitest);
  const plan = f.plan(['packages/core/src/sum.ts']);
  assert.equal(plan.status, 'planned');
  assert.deepEqual(plan.tests, ['packages/core/src/sum.test.ts']);
  assert.equal(plan.command, 'pnpm exec vitest run packages/core/src/sum.test.ts');
  assert.equal(plan.runner.label, 'vitest (test-script)');
  assert.doesNotMatch(plan.command, /--test/);
  assert.match(plan.local.summary, /no import graph for this layout/);
});

test('preflight runs a project runner, records its pass or failure, and never runs node --test', t => {
  const runner = [
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync('ran.txt', JSON.stringify(process.argv.slice(2)) + '\\n');",
    "process.exit(process.argv.slice(2).some(file => file.includes('broken')) ? 1 : 0);",
  ].join('\n');
  const manifest = {
    scripts: {},
    forge: {
      preflight: {
        tests: { glob: 'src/**/*.spec.ts', command: [process.execPath, 'runner.mjs', '{files}'] },
      },
    },
  };
  const f = lane(t, {
    'package.json': JSON.stringify(manifest),
    'runner.mjs': runner,
    'src/ok.ts': '',
    'src/ok.spec.ts': '',
    'src/broken.ts': '',
    'src/broken.spec.ts': '',
  });
  const passed = f.run(f.plan(['src/ok.ts']));
  assert.equal(passed.passed, true);
  assert.equal(passed.tests, 1);
  const failed = f.run(f.plan(['src/broken.ts']));
  assert.equal(failed.passed, false);
  assert.equal(failed.exitCode, 1);
  assert.deepEqual(
    readFileSync(join(f.root, 'ran.txt'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line)),
    [['src/ok.spec.ts'], ['src/broken.spec.ts']],
  );
});

test('without a runner preflight says tests are unavailable; static checks still run when declared', t => {
  const none = lane(t, {
    'package.json': JSON.stringify({ scripts: { test: 'make test' } }),
    'lib/a.rb': '',
  });
  const plan = none.plan(['lib/a.rb']);
  assert.equal(plan.status, 'unavailable');
  assert.match(plan.reason, /^tests unavailable: no test runner declared/);
  const docs = none.plan(['README.md']);
  assert.deepEqual(
    [docs.status, docs.scope, docs.tests],
    ['planned', 'docs', []],
    'a docs-only change needs no runner',
  );
  const withStatic = lane(t, {
    'package.json': JSON.stringify({
      scripts: { test: 'make test' },
      forge: { preflight: { static: [{ name: 'ok', command: [process.execPath, '-e', ''] }] } },
    }),
    'lib/a.rb': '',
  });
  const checks = withStatic.plan(['lib/a.rb']);
  assert.equal(checks.status, 'planned');
  assert.deepEqual(checks.tests, []);
  assert.match(checks.testsUnavailable, /no test runner declared/);
  assert.equal(withStatic.run(checks).passed, true);
  const malformed = lane(t, {
    'package.json': JSON.stringify({ forge: { preflight: { tests: { command: ['x'] } } } }),
  });
  assert.match(malformed.plan(['package.json']).reason, /forge\.preflight\.tests needs/);
});

test("the tests read and contracts use the project's runner and test paths, or say unavailable", () => {
  const files = new Map([['package.json', pnpmVitest['package.json']]]);
  const selection = intentContractSelection(files, ['packages/core/src/sum.ts'], Object.keys(pnpmVitest));
  assert.deepEqual(selection.tests, ['packages/core/src/sum.test.ts']);
  assert.ok(selection.available.includes('apps/web/src/format.spec.tsx'));
  assert.equal(selection.command, 'pnpm exec vitest run packages/core/src/sum.test.ts');
  const none = intentContractSelection(
    new Map([['package.json', '{"scripts":{"test":"make"}}']]),
    ['a.c'],
    ['a.c'],
  );
  assert.equal(none.scope, 'unavailable');
  assert.deepEqual([none.tests, none.available], [[], []]);
  assert.match(none.reason, /no test runner declared/);

  for (const path of [
    'packages/core/src/sum.test.ts',
    'src/__tests__/a.tsx',
    'tests/a.test.mjs',
    'x_spec.js',
  ])
    assert.equal(contractTestPath.safeParse(path).success, true, path);
  for (const path of ['src/sum.ts', '../a.test.ts', '/a.test.ts', 'node_modules/x/a.test.js'])
    assert.equal(contractTestPath.safeParse(path).success, false, path);
});

test('semantic union tests run with the project runner; Forge layout keeps its command; none fails as unavailable', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-semantic-runner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'runner.mjs'), "process.exit(process.argv[2] === 'src/a.spec.ts' ? 0 : 1);");
  const plan = {
    primaryIntentId: '44444444-4444-4444-8444-444444444444',
    members: ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'].map(
      intentId => ({
        intentId,
        outcome: 'x',
        version: 1,
        tests: [{ path: 'src/a.spec.ts', durationMs: 5 }],
      }),
    ),
  };
  const base = [process.execPath, '-e', ''];
  const forge = resolve({}, ['tests/a.test.mjs']);
  assert.deepEqual(
    semanticCheckCommand(base, plan, process.execPath, [], forge),
    semanticCheckCommand(base, plan, process.execPath),
    'Forge layout: the same command bytes as before',
  );
  const run = command => spawnSync(command[0], command.slice(1), { cwd: dir, encoding: 'utf8' });
  const declared = resolve({
    forge: {
      preflight: { tests: { glob: 'src/*.spec.ts', command: [process.execPath, 'runner.mjs', '{files}'] } },
    },
  });
  const ok = run(semanticCheckCommand(base, plan, process.execPath, [], declared));
  assert.equal(ok.status, 0, ok.stderr);
  const report = JSON.parse(ok.stdout.split('__FORGE_TESTS__')[1]);
  assert.deepEqual([report.file, report.results[0].passed], ['src/a.spec.ts', true]);
  const missing = run(
    semanticCheckCommand(base, plan, process.execPath, [], { status: 'unavailable', reason: 'no runner' }),
  );
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /SEMANTIC_TESTS_UNAVAILABLE: src\/a\.spec\.ts: no runner/);
});
