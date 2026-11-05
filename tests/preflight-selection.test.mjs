// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { selectTests, selectPreflightTests, sourceFiles } from '../scripts/test-impact.mjs';

const partition = (files, paths) => {
  const complete = selectTests({ files, paths });
  const plan = selectPreflightTests({ files, paths });
  assert.deepEqual([...plan.tests, ...plan.deferredTests].sort(), complete.tests);
  assert.equal(new Set([...plan.tests, ...plan.deferredTests]).size, complete.tests.length);
  return plan;
};
test('local selection follows import distance; every distant and uncertain consumer stays covered', () => {
  const files = new Map(
    Object.entries({
      'package.json': '{"scripts":{}}',
      'src/shared.ts': 'export const n = 1;',
      'src/near.ts': "import './shared.js';",
      'src/far.ts': "import './near.js';",
      'tests/direct.test.mjs': "import '../dist/shared.js';",
      'tests/near.test.mjs': "import '../dist/near.js';",
      'tests/far.test.mjs': "import '../dist/far.js';",
      'tests/dynamic.test.mjs': 'await import(process.argv[2]);',
      'tests/changed.test.mjs': '',
      'tests/unrelated.test.mjs': '',
    }),
  );
  const plan = partition(files, ['src/shared.ts', 'tests/changed.test.mjs']);
  assert.deepEqual(plan.tests, ['tests/changed.test.mjs', 'tests/direct.test.mjs', 'tests/near.test.mjs']);
  assert.deepEqual(plan.deferredTests, ['tests/dynamic.test.mjs', 'tests/far.test.mjs']);
  // Adding distant consumers does not increase local work. All remain in landing coverage.
  for (let i = 0; i < 10000; i++) files.set(`tests/far-${i}.test.mjs`, "import '../dist/far.js';");
  const started = performance.now(),
    heap = process.memoryUsage().heapUsed;
  const grown = partition(files, ['src/shared.ts', 'tests/changed.test.mjs']);
  assert.ok(performance.now() - started < 30_000, '10k-file selection wall budget');
  assert.ok(process.memoryUsage().heapUsed - heap < 512 * 2 ** 20, '10k-file selection heap budget');
  assert.deepEqual(grown.tests, plan.tests);
  assert.equal(grown.deferredTests.length, 10002);
});
test('wide direct-consumer hubs rank local work without discarding overflow or changed tests', () => {
  const files = new Map([
    ['package.json', '{"scripts":{}}'],
    ['src/hub.ts', 'export {};'],
  ]);
  for (let i = 0; i < 300; i++) files.set(`tests/consumer-${i}.test.mjs`, "import '../dist/hub.js';");
  const changed = ['src/hub.ts', 'tests/consumer-299.test.mjs'];
  const plan = partition(files, changed);
  assert.equal(plan.tests.length, 25);
  assert.ok(plan.tests.includes('tests/consumer-299.test.mjs'));
  assert.equal(plan.deferredTests.length, 275);
  // More than 25 changed tests all execute: the budget cannot hide new/edited regressions.
  const many = partition(files, ['src/hub.ts', ...plan.deferredTests.slice(0, 40)]);
  assert.equal(many.tests.length, 40);
});
test('unknown and infrastructure changes retain complete landing coverage and changed tests locally', () => {
  const files = new Map([
    ['package.json', '{"scripts":{}}'],
    ['tests/changed.test.mjs', ''],
    ['tests/other.test.mjs', ''],
  ]);
  for (const path of ['docs/runtime.json', 'evals/run.py', 'package.json', 'src/deleted.ts']) {
    const plan = partition(files, [path, 'tests/changed.test.mjs']);
    assert.equal(plan.scope, 'full');
    assert.deepEqual(plan.tests, ['tests/changed.test.mjs']);
    assert.deepEqual(plan.deferredTests, ['tests/other.test.mjs']);
  }
});
test('real bench, incident and pull slices cannot regress into near-full local runs', t => {
  const files = sourceFiles(new URL('..', import.meta.url).pathname);
  const cases = [
    {
      name: 'bench-folder',
      paths: [...files.keys()].filter(path => path.startsWith('scripts/bench-t3code/')),
      consumer: 'tests/bench-t3code-filesystem-health.test.mjs',
    },
    {
      name: 'shared-incident',
      paths: [
        'convex/projectConvexSourceTask.ts',
        'convex/projectSourceStepFields.ts',
        'docs/operations/hosted-source-worker.md',
        'docs/status.md',
        'scripts/check-convex-bundle.mjs',
        'scripts/check-convex-runtime.mjs',
        'src/hosted-source-io-error.ts',
        'src/hosted-source-merge-journal.ts',
        'src/hosted-source-retry.ts',
        'src/native-import-merge.ts',
        'tests/convex-bundle-resolution.test.mjs',
        'tests/convex-source-failure-classification.test.mjs',
        'tests/native-import-merge.test.mjs',
        'tests/source-worker-diagnostics.test.mjs',
      ],
      consumer: 'tests/native-import-merge.test.mjs',
    },
    {
      name: 'pull-slice',
      paths: [
        'docs/agents/workflow.md',
        'docs/architecture.md',
        'docs/operations/source-exchange.md',
        'docs/quickstart.md',
        'docs/status.md',
        'src/agent-brief-render.ts',
        'src/agent-verbs.ts',
        'src/cli-entry.ts',
        'src/cli.ts',
        'src/hosted-address.ts',
        'src/hosted-agent-cli.ts',
        'src/hosted-agent-contract.ts',
        'src/hosted-agent-help.ts',
        'src/hosted-agent-transport.ts',
        'src/hosted-cli-status.ts',
        'src/hosted-main-checkout.ts',
        'src/hosted-main-marker.ts',
        'src/hosted-main-reuse.ts',
        'src/hosted-pull-cli.ts',
        'src/hosted-pull.ts',
        'src/mcp-hosted-agent.ts',
        'src/shell-quote.ts',
        'tests/hosted-clone-imports.test.mjs',
        'tests/hosted-pull-budget.test.mjs',
        'tests/hosted-pull-fixture.mjs',
        'tests/hosted-pull-scale.mjs',
        'tests/hosted-pull-transport.test.mjs',
        'tests/hosted-pull.test.mjs',
      ],
      consumer: 'tests/hosted-pull.test.mjs',
    },
  ];
  for (const { name, paths, consumer } of cases) {
    const plan = partition(files, paths);
    assert.ok(plan.tests.includes(consumer), `${consumer} must run locally`);
    assert.ok(plan.tests.length <= 25, `${name}: ${plan.tests.length} local test files`);
    t.diagnostic(
      `${name}: ${plan.tests.length + plan.deferredTests.length} complete -> ${plan.tests.length} local + ${plan.deferredTests.length} deferred`,
    );
  }
});
