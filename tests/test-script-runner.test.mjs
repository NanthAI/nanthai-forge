// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/state/hash.js';
import { sourceTree } from '../dist/source-tree.js';
import { preflightPlan, preflightRuntime, runPreflight } from '../dist/agent-preflight.js';
import {
  resolveTestRunner,
  runnerCommand,
  runnerSelection,
  runnerTestPath,
} from '../dist/project-test-runner.js';
import { semanticCheckCommand } from '../dist/semantic-check-command.js';

const laneId = '66666666-6666-4666-8666-666666666666';
test.beforeEach(t =>
  t.mock.method(preflightRuntime, 'filesystemEventHealth', () => ({
    ok: true,
    latencyMs: 1,
    fseventsdRssMb: null,
    fseventsdCpuPercent: null,
    reason: null,
    attempts: [],
  })),
);
const runnerOf = (scripts, paths = []) => resolveTestRunner(JSON.stringify({ scripts }), () => paths);

/** The polyglot shape: `test` chains named scripts that use tsx --test and node --test. */
const chained = {
  test: 'npm run app:test && npm run scripts:test',
  'app:test': 'tsx --test app/tests/*.test.ts',
  'scripts:test': 'node --test scripts/*.test.mjs',
};
const chainedPaths = [
  'app/src/sum.ts',
  'app/tests/sum.test.ts',
  'scripts/build.mjs',
  'scripts/build.test.mjs',
  'package-lock.json',
];

test('npm run indirection keeps every runner of a chained script and selects per file from both globs', () => {
  const resolved = runnerOf(chained, chainedPaths);
  assert.equal(resolved.status, 'available', resolved.reason);
  const { runner } = resolved;
  assert.equal(runner.source, 'test-script');
  assert.equal(runner.layout, 'generic');
  assert.deepEqual(
    runner.parts.map(part => [part.program, part.globs, part.command]),
    [
      ['tsx', ['app/tests/*.test.ts'], ['npx', '--no-install', 'tsx', '--test', '{files}']],
      ['node', ['scripts/*.test.mjs'], ['node', '--test', '{files}']],
    ],
  );
  assert.ok(runnerTestPath(runner, 'app/tests/sum.test.ts'));
  assert.ok(runnerTestPath(runner, 'scripts/build.test.mjs'));
  const selected = runnerSelection(runner, chainedPaths, ['app/src/sum.ts', 'scripts/build.mjs']);
  assert.deepEqual(selected.tests, ['app/tests/sum.test.ts', 'scripts/build.test.mjs']);
  // Each file runs with the runner whose globs own it; files of both run as one line.
  assert.deepEqual(runnerCommand(runner, ['scripts/build.test.mjs']), [
    'node',
    '--test',
    'scripts/build.test.mjs',
  ]);
  assert.deepEqual(runnerCommand(runner, ['app/tests/sum.test.ts']), [
    'npx',
    '--no-install',
    'tsx',
    '--test',
    'app/tests/sum.test.ts',
  ]);
  assert.deepEqual(runnerCommand(runner, ['app/tests/sum.test.ts', 'scripts/build.test.mjs']), [
    'sh',
    '-c',
    'npx --no-install tsx --test app/tests/sum.test.ts && node --test scripts/build.test.mjs',
  ]);
});

test('tsx --test alone is a runner with its own command; Node loaders via --import stay node flags', () => {
  const tsx = runnerOf({ test: 'tsx --test src/*.test.ts' }, ['pnpm-lock.yaml']);
  assert.equal(tsx.status, 'available');
  assert.equal(tsx.runner.program, 'tsx');
  assert.deepEqual(tsx.runner.globs, ['src/*.test.ts']);
  assert.deepEqual(tsx.runner.command, ['pnpm', 'exec', 'tsx', '--test', '{files}']);
  assert.equal(tsx.runner.parts, undefined);
  // No path: Node's own patterns, with TypeScript extensions; never Forge's own node layout.
  const bare = runnerOf({ test: 'tsx --test' }, ['tests/a.test.mjs']);
  assert.equal(bare.runner.layout, 'generic');
  assert.ok(runnerTestPath(bare.runner, 'src/sum.test.ts'));
  const loader = runnerOf({ test: 'node --import tsx --test test/**/*.test.ts' });
  assert.deepEqual(loader.runner.command, ['node', '--import', 'tsx', '--test', '{files}']);
});

test('package-manager script forms resolve: npm test, pnpm NAME, yarn NAME, run-s globs, appended args', () => {
  const pnpm = runnerOf({ test: 'pnpm unit', unit: 'vitest run' }, ['pnpm-lock.yaml']);
  assert.equal(pnpm.runner.program, 'vitest');
  const yarn = runnerOf({ test: 'yarn run unit', unit: 'jest' }, ['yarn.lock']);
  assert.equal(yarn.runner.program, 'jest');
  const all = runnerOf({
    test: 'run-s test:*',
    'test:a': 'node --test a/*.test.mjs',
    'test:b': 'node --test b/*.test.mjs',
    'test:b:slow': 'mocha',
  });
  // `test:*` stays in one `:` segment: test:b:slow (mocha) is not part of it.
  assert.equal(all.status, 'available', all.reason);
  assert.deepEqual(all.runner.globs, ['a/*.test.mjs', 'b/*.test.mjs']);
  assert.equal(all.runner.parts, undefined, 'one command with both globs');
  const args = runnerOf({ test: 'npm run unit -- --test-concurrency=1', unit: 'node --test' });
  assert.deepEqual(args.runner.command, ['node', '--test', '--test-concurrency=1', '{files}']);
  const build = runnerOf({ test: 'npm run build && npm test:unit', build: 'tsc', 'test:unit': 'x' });
  assert.equal(build.status, 'unavailable', 'npm test:unit is not npm test');
});

test('a script cycle, too deep indirection, a folder change or another runner refuse with the reason', () => {
  const cycle = runnerOf({ test: 'npm run a', a: 'npm run b', b: 'npm test' });
  assert.equal(cycle.status, 'unavailable');
  assert.match(cycle.reason, /runs itself: test → a → b → test/);
  const deep = { test: 'npm run a', a: 'npm run b', b: 'npm run c', c: 'npm run d', d: 'npm run e' };
  assert.match(runnerOf({ ...deep, e: 'node --test' }).reason, /more than 4 named scripts/);
  assert.equal(runnerOf({ ...deep, d: 'node --test' }).status, 'available', 'four scripts deep is read');
  assert.match(runnerOf({ test: 'node --test && cd web && npm test' }).reason, /changes folder \(cd web\)/);
  assert.match(
    runnerOf({ test: 'node --test && npm --prefix web test' }).reason,
    /another package's scripts/,
  );
  // A second runner Forge cannot run per file is named, never dropped.
  const mocha = runnerOf({ test: 'node --test a/*.test.mjs && mocha' });
  assert.equal(mocha.status, 'unavailable');
  assert.match(mocha.reason, /runs mocha, which Forge cannot run per file/);
  const e2e = runnerOf({ test: 'vitest run && npm run e2e', e2e: 'playwright test' });
  assert.match(e2e.reason, /the e2e script runs playwright.*\(test → e2e\)/);
  assert.match(runnerOf({ test: 'node --test && go test ./...' }).reason, /runs go … test/);
  // Build and lint steps are not runners and do not refuse.
  const steps = runnerOf({ test: 'npm run build && node --test', build: 'tsc -p . && eslint src' });
  assert.equal(steps.status, 'available');
});

test('semantic union tests of a chained runner each run with the part that owns them', () => {
  const resolved = runnerOf(chained, chainedPaths);
  const plan = {
    primaryIntentId: '44444444-4444-4444-8444-444444444444',
    members: ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'].map(
      intentId => ({
        intentId,
        outcome: 'x',
        version: 1,
        tests: [
          { path: 'app/tests/sum.test.ts', durationMs: 5 },
          { path: 'scripts/build.test.mjs', durationMs: 5 },
        ],
      }),
    ),
  };
  const command = semanticCheckCommand(['true'], plan, 'node', [], resolved);
  const input = JSON.parse(command.at(-1));
  assert.deepEqual(input.runner, {
    'app/tests/sum.test.ts': ['npx', '--no-install', 'tsx', '--test', 'app/tests/sum.test.ts'],
    'scripts/build.test.mjs': ['node', '--test', 'scripts/build.test.mjs'],
  });
});

test('preflight plans and runs both runners of a chained script', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-chained-runner-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pass = "import test from 'node:test';\ntest('ok', () => {});\n";
  const bytes = {
    'package.json': JSON.stringify({
      scripts: {
        test: 'npm run unit && npm run tools',
        unit: 'node --test --test-concurrency=1 unit/*.test.mjs',
        tools: 'node --test tools/*.test.mjs',
      },
    }),
    'unit/a.mjs': '',
    'unit/a.test.mjs': pass,
    'tools/b.mjs': '',
    'tools/b.test.mjs': pass,
  };
  for (const [path, body] of Object.entries(bytes)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const files = Object.entries(bytes).map(([path, body]) => ({ path, blob: digest(body), mode: 'file' }));
  const plan = preflightPlan(
    root,
    { paths: ['unit/a.mjs', 'tools/b.mjs'], complete: true },
    { laneId, files },
  );
  assert.equal(plan.status, 'planned', plan.reason);
  assert.deepEqual([...plan.tests].sort(), ['tools/b.test.mjs', 'unit/a.test.mjs']);
  assert.equal(plan.runner.label, 'node + node (test-script)');
  assert.equal(plan.runner.parts.length, 2);
  const run = runPreflight(root, laneId, digest(JSON.stringify(files)), plan, sourceTree(files));
  assert.equal(run.passed, true);
  assert.equal(run.tests, 2);
});
