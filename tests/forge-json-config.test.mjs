// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/state/hash.js';
import { sourceTree } from '../dist/source-tree.js';
import { preflightPlan, preflightRuntime, runPreflight } from '../dist/agent-preflight.js';
import { preflightGuards, staticChecks } from '../dist/agent-preflight-static.js';
import { projectTestRunner } from '../dist/project-test-runner.js';
import { intentContractSelection } from '../dist/intent-contract-selection.js';
import { confirmTestContract } from '../dist/intent-test-contract.js';

const laneId = '44444444-4444-4444-8444-444444444444';
const healthy = {
  ok: true,
  latencyMs: 1,
  fseventsdRssMb: null,
  fseventsdCpuPercent: null,
  reason: null,
  attempts: [],
};
test.beforeEach(t => t.mock.method(preflightRuntime, 'filesystemEventHealth', () => healthy));

function lane(t, bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-json-config-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, body] of Object.entries(bytes)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const files = () => Object.keys(bytes).map(path => ({ path, blob: digest(bytes[path]), mode: 'file' }));
  return {
    plan: paths => preflightPlan(root, { paths, complete: true }, { laneId, files: files() }),
    run: plan => runPreflight(root, laneId, digest(JSON.stringify(files())), plan, sourceTree(files())),
  };
}

// A runner that passes when every named file exists: stands in for `go test`, pytest or Gradle.
const runner =
  "import { existsSync } from 'node:fs'; process.exit(process.argv.slice(2).every(existsSync) ? 0 : 1);";
const goConfig = JSON.stringify({
  preflight: {
    tests: { glob: '**/*_test.go', command: ['node', 'run-tests.mjs', '{files}'] },
    static: [{ name: 'vet', command: ['node', '-e', ''], inputs: ['**/*.go'] }],
    guards: [{ name: 'api', tests: ['api/api_test.go'], inputs: ['api/**'] }],
  },
  futureSetting: { ignored: true },
});
/** A Go module with no package.json: everything Forge needs is in forge.json. */
const goRepo = {
  'go.mod': 'module example.com/sum\n\ngo 1.22\n',
  'forge.json': goConfig,
  'run-tests.mjs': runner,
  'sum/sum.go': 'package sum\n',
  'sum/sum_test.go': 'package sum\n',
  'api/api.go': 'package api\n',
  'api/api_test.go': 'package api\n',
  'README.md': '# sum\n',
};

test('a Go repository declares tests, static checks and guards in forge.json, and preflight plans and runs them', t => {
  const repo = lane(t, goRepo);
  const plan = repo.plan(['sum/sum_test.go', 'api/api.go']);
  assert.equal(plan.status, 'planned');
  assert.deepEqual(plan.tests, ['api/api_test.go', 'sum/sum_test.go'].sort());
  assert.match(plan.runner.label, /forge\.json/);
  assert.deepEqual(plan.runner.command, ['node', 'run-tests.mjs', '{files}']);
  assert.deepEqual(
    plan.static.selected.map(check => check.name),
    ['vet'],
  );
  assert.deepEqual(
    plan.local.guards.map(guard => guard.name),
    ['api'],
  );
  const receipt = repo.run(plan);
  assert.equal(receipt.passed, true);
  // A change the guard's inputs do not cover leaves it out, named.
  const other = repo.plan(['sum/sum_test.go']);
  assert.deepEqual(other.tests, ['sum/sum_test.go']);
  assert.equal(other.local.guards, undefined);
});

test('a project build:core script runs only for Forge’s own Node layout, never before another runner', t => {
  const repo = lane(t, {
    ...goRepo,
    'package.json': JSON.stringify({ scripts: { 'build:core': 'node -e "process.exit(1)"' } }),
  });
  const plan = repo.plan(['sum/sum_test.go']);
  assert.equal(plan.status, 'planned');
  const receipt = repo.run(plan);
  assert.equal(receipt.passed, true);
  assert.equal(receipt.buildMs, undefined);
});

test('a Python repository with JS fixtures under test/ and no package.json never gets node --test', t => {
  const paths = ['pyproject.toml', 'src/app/__init__.py', 'tests/test_app.py', 'test/fixtures/a.js'];
  const resolved = projectTestRunner(undefined, () => paths);
  assert.equal(resolved.status, 'unavailable');
  assert.match(resolved.reason, /forge\.json/);
  const repo = lane(t, {
    'pyproject.toml': '[project]\nname = "app"\n',
    'src/app/__init__.py': '',
    'tests/test_app.py': 'def test_app(): pass\n',
    'test/fixtures/a.js': 'module.exports = 1;\n',
  });
  const plan = repo.plan(['src/app/__init__.py']);
  const command = plan.runner?.command ?? [];
  assert.ok(!command.includes('--test'), JSON.stringify(plan));
  assert.ok(!(plan.tests ?? []).includes('test/fixtures/a.js'), JSON.stringify(plan));
  // A Node project keeps rule 3.
  assert.equal(projectTestRunner('{}', () => ['test/a.js']).runner.command[0], 'node');
});

test('Intent contract tests for Go, Python and Java test files are proposed and stored', () => {
  const config = JSON.stringify({
    preflight: {
      tests: {
        glob: ['**/*_test.go', '**/test_*.py', '**/*Test.java'],
        command: ['run-tests', '{files}'],
      },
    },
  });
  const paths = [
    'forge.json',
    'sum/sum.go',
    'sum/x_test.go',
    'py/test_x.py',
    'src/test/java/com/acme/XTest.java',
  ];
  const selection = intentContractSelection(new Map([['forge.json', config]]), ['sum/x_test.go'], paths);
  assert.deepEqual(selection.available, [
    'py/test_x.py',
    'src/test/java/com/acme/XTest.java',
    'sum/x_test.go',
  ]);
  const head = 'a'.repeat(40);
  const contract = confirmTestContract({
    command: {
      operationId: '55555555-5555-4555-8555-555555555555',
      runId: '66666666-6666-4666-8666-666666666666',
      expectedHead: head,
      expectedVersion: 0,
      tests: selection.available,
    },
    candidateId: '77777777-7777-4777-8777-777777777777',
    head,
    required: selection.tests,
    available: selection.available,
    timings: Object.fromEntries(selection.available.map(path => [path, 10])),
    version: 0,
    request: 'b'.repeat(64),
    at: '2026-11-08T00:00:00.000Z',
  });
  assert.deepEqual(
    contract.tests.map(item => item.path),
    selection.available,
  );
});

test("Forge's own package.json preflight config reads unchanged", () => {
  const manifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const declared = JSON.parse(manifest).forge.preflight;
  assert.deepEqual(
    staticChecks(manifest).map(check => check.name),
    declared.static.map(check => check.name),
  );
  assert.deepEqual(
    preflightGuards(manifest, () => true).map(guard => guard.name),
    declared.guards.map(guard => guard.name),
  );
  const runner = projectTestRunner(manifest, () => [
    'scripts/forge-check.mjs',
    'tests/a.test.mjs',
    'src/a.ts',
  ]);
  assert.equal(runner.runner.layout, 'forge-node');
});
