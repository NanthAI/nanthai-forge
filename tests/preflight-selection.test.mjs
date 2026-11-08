// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  fitPreflightBudget,
  protectedTiers,
  selectTests,
  selectPreflightTests,
  sourceFiles,
} from '../scripts/test-impact.mjs';

// The default 180 s budget at the default 4 s per file.
const budget = { seconds: 180, secondsFor: () => 4 };
const partition = (files, paths, hubBudget = budget) => {
  // Both selections read one inventory and path list, so they share a single parsed import graph.
  const graphCache = {};
  const complete = selectTests({ files, paths }, graphCache);
  const plan = selectPreflightTests({ files, paths, hubBudget }, graphCache);
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
      'src/farther.ts': "import './far.js';",
      'tests/direct.test.mjs': "import '../dist/shared.js';",
      'tests/near.test.mjs': "import '../dist/near.js';",
      'tests/far.test.mjs': "import '../dist/far.js';",
      'tests/farther.test.mjs': "import '../dist/farther.js';",
      'tests/dynamic.test.mjs': 'await import(process.argv[2]);',
      'tests/changed.test.mjs': '',
      'tests/unrelated.test.mjs': '',
    }),
  );
  const plan = partition(files, ['src/shared.ts', 'tests/changed.test.mjs']);
  // One module between (near.ts) is still direct; two (far.ts) is the trimmable near tier; three
  // and a computed path stay in landing coverage only.
  assert.deepEqual(plan.tests, [
    'tests/changed.test.mjs',
    'tests/direct.test.mjs',
    'tests/near.test.mjs',
    'tests/far.test.mjs',
  ]);
  assert.deepEqual(plan.tiers.find(item => item.tier === 'near').tests, ['tests/far.test.mjs']);
  assert.deepEqual(plan.deferredTests, ['tests/dynamic.test.mjs', 'tests/farther.test.mjs']);
  // Adding distant consumers does not increase local work. All remain in landing coverage.
  for (let i = 0; i < 10000; i++) files.set(`tests/far-${i}.test.mjs`, "import '../dist/farther.js';");
  const started = performance.now(),
    heap = process.memoryUsage().heapUsed;
  const grown = partition(files, ['src/shared.ts', 'tests/changed.test.mjs']);
  assert.ok(performance.now() - started < 30_000, '10k-file selection wall budget');
  assert.ok(process.memoryUsage().heapUsed - heap < 512 * 2 ** 20, '10k-file selection heap budget');
  assert.deepEqual(grown.tests, plan.tests);
  assert.equal(grown.deferredTests.length, 10002);
});
test('hub direct consumers stay whole in the ranked set; the time budget, not a count, trims them', () => {
  const files = new Map([
    ['package.json', '{"scripts":{}}'],
    ['src/hub.ts', 'export {};'],
  ]);
  for (let i = 0; i < 300; i++) files.set(`tests/consumer-${i}.test.mjs`, "import '../dist/hub.js';");
  const changed = ['src/hub.ts', 'tests/consumer-299.test.mjs'];
  const plan = partition(files, changed);
  // The hub's direct tests alone overrun the budget, so they are ranked (`wide`), not protected; no
  // count drops one silently.
  assert.equal(plan.tiers.find(item => item.tier === 'wide').tests.length, 299);
  assert.equal(plan.tiers.find(item => item.tier === 'direct').tests.length, 0);
  assert.ok(plan.tests.includes('tests/consumer-299.test.mjs'));
  const fit = fitPreflightBudget({
    tiers: plan.tiers,
    budgetSeconds: 180,
    secondsPerFile: 4,
  });
  // 180 s at 4 s per file is 45 files in total, mandatory first.
  assert.equal(fit.tests.length, 45);
  assert.deepEqual(
    fit.trimmed.map(item => item.tier),
    ['wide'],
  );
  const [direct] = fit.trimmed;
  assert.equal(direct.kept + direct.deferred.length, direct.total);
  assert.equal(new Set([...fit.tests, ...direct.deferred, ...plan.deferredTests]).size, plan.tests.length);
  // A faster machine runs more of the same ranking; the order is unchanged.
  const fast = fitPreflightBudget({
    tiers: plan.tiers,
    budgetSeconds: 180,
    secondsPerFile: 1,
  });
  assert.equal(fast.tests.length, 180);
  assert.deepEqual(fast.tests.slice(0, 45), fit.tests);
  // Mandatory tests never trim, even over budget, and the report says so.
  const many = partition(files, [
    'src/hub.ts',
    ...plan.tiers.find(item => item.tier === 'wide').tests.slice(0, 60),
  ]);
  const over = fitPreflightBudget({
    tiers: many.tiers,
    budgetSeconds: 180,
    secondsPerFile: 4,
  });
  assert.equal(over.mandatoryOverBudget, true);
  assert.equal(over.tests.length, many.tiers[0].tests.length);
  assert.deepEqual(
    over.trimmed.map(item => item.tier),
    ['wide'],
  );
  assert.equal(over.trimmed[0].kept, 0);
});
test('a farther tier never runs while a nearer consumer is deferred; reused passes cost nothing', () => {
  const tiers = [
    { tier: 'mandatory', tests: ['m'] },
    { tier: 'wide', tests: ['d1', 'd2', 'd3'] },
    { tier: 'near', tests: ['n1', 'n2'] },
  ];
  const fit = fitPreflightBudget({
    tiers,
    budgetSeconds: 8,
    secondsPerFile: 4,
  });
  assert.deepEqual(fit.tests, ['m', 'd1']);
  assert.deepEqual(
    fit.trimmed.map(item => [item.tier, item.kept, item.deferred.length]),
    [
      ['wide', 1, 2],
      ['near', 0, 2],
    ],
  );
  const free = fitPreflightBudget({
    tiers,
    budgetSeconds: 8,
    secondsPerFile: 4,
    free: new Set(['d1', 'd2', 'n1']),
  });
  assert.deepEqual(free.tests, ['m', 'd1', 'd2', 'd3', 'n1']);
  assert.deepEqual(
    free.trimmed.map(item => item.tier),
    ['near'],
  );
});
test('protected tiers (mandatory, learned, direct) are never trimmed, even far over budget', () => {
  assert.deepEqual([...protectedTiers].sort(), ['direct', 'learned', 'mandatory']);
  const tiers = [
    { tier: 'mandatory', tests: ['m'] },
    { tier: 'learned', tests: ['l'] },
    { tier: 'direct', tests: ['d1', 'd2', 'd3'] },
    { tier: 'wide', tests: ['w'] },
    { tier: 'near', tests: ['n'] },
  ];
  const fit = fitPreflightBudget({ tiers, budgetSeconds: 1, secondsPerFile: 4 });
  assert.deepEqual(fit.tests, ['m', 'l', 'd1', 'd2', 'd3']);
  assert.equal(fit.protectedOverBudget, true);
  assert.deepEqual(
    fit.trimmed.map(item => item.tier),
    ['wide', 'near'],
  );
});
test('behaviour tests that reach a changed module through a test fixture, or are named for it, are direct (b8b53ea0)', () => {
  const files = new Map(
    Object.entries({
      'package.json': '{"scripts":{}}',
      'src/delta.ts': 'export const n = 1;',
      'src/sync.ts': "import './delta.js';",
      'src/store.ts': "import './sync.js';",
      'tests/delta-fixture.mjs': "import '../dist/delta.js';",
      'tests/through-fixture.test.mjs': "import './delta-fixture.mjs';",
      'tests/delta.test.mjs': "import '../dist/sync.js';",
      'tests/near.test.mjs': "import '../dist/store.js';",
      'tests/unrelated.test.mjs': '',
    }),
  );
  const plan = partition(files, ['src/delta.ts']);
  const tier = name => plan.tiers.find(item => item.tier === name).tests;
  assert.deepEqual(tier('direct'), ['tests/delta.test.mjs', 'tests/through-fixture.test.mjs']);
  assert.deepEqual(tier('near'), ['tests/near.test.mjs']);
  const fit = fitPreflightBudget({ tiers: plan.tiers, budgetSeconds: 1, secondsPerFile: 4 });
  assert.ok(fit.tests.includes('tests/through-fixture.test.mjs'), 'never trimmed under budget pressure');
  assert.ok(fit.tests.includes('tests/delta.test.mjs'));
  assert.ok(!fit.tests.includes('tests/near.test.mjs'));
});
test('a module is broad only when its direct tests overrun the budget; its named test stays protected', () => {
  const build = consumers => {
    const files = new Map([
      ['package.json', '{"scripts":{}}'],
      ['src/shared.ts', 'export {};'],
      ['tests/shared.test.mjs', "import '../dist/shared.js';"],
    ]);
    for (let i = 0; i < 100; i++)
      files.set(`tests/t-${i}.test.mjs`, i < consumers ? "import '../dist/shared.js';" : '');
    return partition(files, ['src/shared.ts'], { seconds: 40, secondsFor: () => 4 });
  };
  const tier = (plan, name) => plan.tiers.find(item => item.tier === name).tests;
  // Small projects never have hubs: a few direct tests always fit.
  const at = build(9);
  assert.equal(tier(at, 'direct').length, 10);
  assert.deepEqual(tier(at, 'wide'), []);
  const past = build(10);
  assert.deepEqual(tier(past, 'direct'), ['tests/shared.test.mjs']);
  assert.equal(tier(past, 'wide').length, 10);
  // Without a budget (preflight trim:false) nothing is broad.
  const files = new Map([...Array(30)].map((_, i) => [`tests/t-${i}.test.mjs`, "import '../dist/s.js';"]));
  files.set('package.json', '{"scripts":{}}').set('src/s.ts', 'export {};');
  assert.equal(
    selectPreflightTests({ files, paths: ['src/s.ts'] }).tiers.find(item => item.tier === 'direct').tests
      .length,
    30,
  );
});
test('the most specific changed modules keep their direct tests protected; the broadest are ranked', () => {
  const files = new Map([
    ['package.json', '{"scripts":{}}'],
    ['src/dirty.ts', 'export {};'],
    ['src/transport.ts', 'export {};'],
    ['tests/fixture.mjs', "import '../dist/transport.js';"],
    ['tests/hygiene.test.mjs', "import '../dist/dirty.js'; import './fixture.mjs';"],
  ]);
  for (let i = 0; i < 40; i++) files.set(`tests/agent-${i}.test.mjs`, "import './fixture.mjs';");
  // Real costs: the hygiene test is slow, the harness users are quick, yet transport is broader.
  const secondsFor = test => (test === 'tests/hygiene.test.mjs' ? 60 : 3);
  const plan = partition(files, ['src/transport.ts', 'src/dirty.ts'], { seconds: 100, secondsFor });
  const tier = name => plan.tiers.find(item => item.tier === name).tests;
  assert.deepEqual(tier('direct'), ['tests/hygiene.test.mjs']);
  assert.equal(tier('wide').length, 40);
  assert.deepEqual(plan.broadModules, ['src/transport.ts']);
  const fit = fitPreflightBudget({ tiers: plan.tiers, budgetSeconds: 100, secondsPerFile: 3, secondsFor });
  assert.ok(fit.tests.includes('tests/hygiene.test.mjs'));
  assert.equal(fit.trimmed[0].tier, 'wide');
});
test('learned tests run locally and protected, even where the import graph does not reach them', () => {
  const files = new Map(
    Object.entries({
      'package.json': '{"scripts":{}}',
      'src/a.ts': 'export const n = 1;',
      'tests/a.test.mjs': "import '../dist/a.js';",
      'tests/watches-paths.test.mjs': '',
      'tests/gone.test.mjs': '',
    }),
  );
  const plan = selectPreflightTests({
    files,
    paths: ['src/a.ts'],
    learned: ['tests/watches-paths.test.mjs', 'tests/missing.test.mjs'],
  });
  assert.deepEqual(plan.tiers.find(item => item.tier === 'learned').tests, ['tests/watches-paths.test.mjs']);
  assert.ok(!plan.deferredTests.includes('tests/watches-paths.test.mjs'));
  const fit = fitPreflightBudget({ tiers: plan.tiers, budgetSeconds: 1, secondsPerFile: 4 });
  assert.ok(fit.tests.includes('tests/watches-paths.test.mjs'));
});
test('a recent landing failure runs first among equally close tests and never ahead of closer ones (0d403d25)', () => {
  const files = new Map([
    ['package.json', '{"scripts":{}}'],
    ['src/hub.ts', 'export {};'],
    ['src/mid.ts', "import './hub.js';"],
    ['src/top.ts', "import './mid.js';"],
    ['tests/shared.test.mjs', "import '../dist/hub.js';"],
    ['tests/top.test.mjs', "import '../dist/top.js';"],
  ]);
  for (let i = 0; i < 30; i++)
    files.set(`tests/t-${String(i).padStart(2, '0')}.test.mjs`, "import '../dist/hub.js';");
  const hubBudget = { seconds: 40, secondsFor: () => 4 };
  const input = { files, paths: ['src/hub.ts'], hubBudget };
  const plain = partition(files, ['src/hub.ts'], hubBudget);
  const tier = (plan, name) => plan.tiers.find(item => item.tier === name).tests;
  // Equally close tests order by a stable hash, not by name: take whichever sorts last.
  const last = tier(plain, 'wide').at(-1);
  assert.notEqual(tier(plain, 'wide')[0], last);
  assert.deepEqual(tier(plain, 'near'), ['tests/top.test.mjs']);
  const plan = selectPreflightTests({
    ...input,
    // Unreached by this change (not a consumer) and missing files never join.
    recent: [last, 'tests/top.test.mjs', 'tests/unrelated.test.mjs', 'tests/gone.test.mjs'],
  });
  assert.deepEqual(
    plan.tiers.map(item => item.tier),
    ['mandatory', 'learned', 'direct', 'wide', 'recent', 'watch', 'near'],
  );
  // A wide consumer that failed lately stays wide, first among its equally close peers.
  assert.equal(tier(plan, 'wide')[0], last);
  assert.deepEqual(plan.recentFailed, [last, 'tests/top.test.mjs']);
  // A failure two modules away moves up from near to recent: after wide, never before it.
  assert.deepEqual(tier(plan, 'recent'), ['tests/top.test.mjs']);
  assert.deepEqual(tier(plan, 'near'), []);
  assert.ok(!protectedTiers.has('recent'));
  const fit = fitPreflightBudget({
    tiers: plan.tiers,
    budgetSeconds: 8,
    secondsPerFile: 4,
    secondsFor: () => 4,
  });
  assert.ok(fit.tests.includes(last));
  assert.ok(!fit.tests.includes('tests/top.test.mjs'));
  // A test learned for this very path stays learned, not recent.
  const both = selectPreflightTests({ ...input, learned: [last], recent: [last] });
  assert.deepEqual(tier(both, 'learned'), [last]);
  assert.deepEqual(tier(both, 'recent'), []);
});
test('no hardcoded local file count remains in the selector or the preflight planner', () => {
  for (const file of ['../scripts/test-impact.mjs', '../src/agent-preflight.ts'])
    assert.doesNotMatch(
      readFileSync(new URL(file, import.meta.url), 'utf8'),
      /\b25\b|slice\(0, *Math\.max/,
      `${file}: local selection is by time, never a file count`,
    );
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
    {
      // Friction 8288e7f5: the stat-index write in hosted-lane-dirty broke the disk-hygiene prune
      // test, which imports that module directly, and the budget had trimmed it.
      name: 'delta-followups',
      paths: [
        'docs/architecture.md',
        'docs/status.md',
        'src/checkout-stat-index.ts',
        'src/hosted-agent-transport.ts',
        'src/hosted-checkout-clean.ts',
        'src/hosted-checkout-delta-settle.ts',
        'src/hosted-checkout-delta.ts',
        'src/hosted-lane-checkout.ts',
        'src/hosted-lane-dirty.ts',
        'src/hosted-main-checkout.ts',
        'src/hosted-main-publish.ts',
        'tests/checkout-stat-index-refresh.test.mjs',
        'tests/hosted-main-delta-recovery.test.mjs',
        'tests/hosted-pull.test.mjs',
      ],
      consumer: 'tests/client-disk-hygiene.test.mjs',
      protect: ['tests/client-disk-hygiene.test.mjs'],
    },
    {
      // Friction b8b53ea0: the behaviour tests of the new delta modules sat in the trimmed near tier.
      name: 'deltafix',
      paths: [
        'src/hosted-checkout-delta-settle.ts',
        'src/hosted-checkout-delta.ts',
        'src/hosted-lane-checkout.ts',
      ],
      consumer: 'tests/hosted-checkout-delta.test.mjs',
      protect: ['tests/hosted-checkout-delta.test.mjs', 'tests/hosted-checkout-preservation.test.mjs'],
    },
  ];
  for (const { name, paths, consumer, protect = [] } of cases) {
    const plan = partition(files, paths);
    assert.ok(plan.tests.includes(consumer), `${consumer} must be in the ranked local set`);
    // Replay: every protected test runs locally even under budget pressure, every ranked consumer
    // is local or in the named deferred set, and the budget cut (if any) names the tier it trimmed.
    const guarded = plan.tiers.filter(item => protectedTiers.has(item.tier)).flatMap(item => item.tests);
    for (const test of protect) assert.ok(guarded.includes(test), `${name}: ${test} must be protected`);
    const fit = fitPreflightBudget({
      tiers: plan.tiers,
      budgetSeconds: 180,
      secondsPerFile: 4,
    });
    const cut = fit.trimmed.flatMap(item => item.deferred);
    for (const test of guarded) assert.ok(fit.tests.includes(test), `${name}: ${test} was trimmed`);
    const direct = plan.tiers.find(item => item.tier === 'direct').tests;
    for (const test of plan.tests)
      assert.ok(
        fit.tests.includes(test) || cut.includes(test),
        `${name}: ${test} neither local nor scheduled`,
      );
    t.diagnostic(
      `${name}: ${plan.tests.length + plan.deferredTests.length} complete -> ${fit.tests.length} local + ${cut.length + plan.deferredTests.length} pre-queue (${direct.length} direct; trimmed: ${fit.trimmed.map(item => `${item.tier} ${item.kept}/${item.total}`).join(', ') || 'none'})`,
    );
  }
});
test('a manifest that makes coverage full still leaves the other paths ranked; recent needs a short chain', () => {
  const files = new Map(
    Object.entries({
      'package.json': '{"scripts":{}}',
      'src/a.ts': 'export const n = 1;',
      'src/wrapper.ts': "import './a.js';",
      'src/server.ts': "import './wrapper.js';",
      'src/far.ts': "import './server.js';",
      'tests/a.test.mjs': "import '../dist/a.js';",
      'tests/far.test.mjs': "import '../dist/far.js';",
      'tests/unrelated.test.mjs': '',
    }),
  );
  const paths = ['package.json', 'src/a.ts'];
  const graphCache = {};
  const complete = selectTests({ files, paths }, graphCache);
  assert.equal(complete.scope, 'full');
  const plan = selectPreflightTests(
    { files, paths, hubBudget: budget, recent: ['tests/far.test.mjs', 'tests/unrelated.test.mjs'] },
    graphCache,
  );
  const tier = name => plan.tiers.find(item => item.tier === name).tests;
  assert.deepEqual(tier('direct'), ['tests/a.test.mjs']);
  // Three modules between and no edge at all: coverage only, never a recent local file.
  assert.deepEqual(tier('recent'), []);
  assert.deepEqual(plan.recentFailed, []);
  assert.ok(plan.deferredTests.includes('tests/far.test.mjs'));
  assert.ok(plan.deferredTests.includes('tests/unrelated.test.mjs'));
});
