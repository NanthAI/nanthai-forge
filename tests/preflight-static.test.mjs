// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/portable-hash.js';
import { sourceTree } from '../dist/source-tree.js';
import {
  orderByHistory,
  preflightFileStats,
  preflightPlan,
  preflightRuntime,
  runPreflight,
} from '../dist/agent-preflight.js';
import {
  globRegExp,
  preflightGuards,
  runStaticChecks,
  selectGuards,
  selectStaticChecks,
  staticChecks,
} from '../dist/agent-preflight-static.js';

const laneId = '22222222-2222-4222-8222-222222222222';
const healthy = {
  ok: true,
  latencyMs: 1,
  fseventsdRssMb: null,
  fseventsdCpuPercent: null,
  reason: null,
  attempts: [],
};
test.beforeEach(t => t.mock.method(preflightRuntime, 'filesystemEventHealth', () => healthy));

const manifest = (staticChecks, scripts = {}) =>
  JSON.stringify({ type: 'module', scripts, forge: { preflight: { static: staticChecks } } });

test('without a declaration only a conventionally named formatter check runs; an unknown check script is never guessed', () => {
  assert.deepEqual(staticChecks('{"scripts":{"check":"npm test"}}'), []);
  const [format] = staticChecks('{"scripts":{"format:check":"oxfmt --check","check":"npm test"}}');
  assert.deepEqual(format.command, ['npm', 'run', '-s', 'format:check']);
  assert.equal(format.source, 'conventional');
  assert.deepEqual(staticChecks('not json'), []);
  assert.deepEqual(staticChecks(undefined), []);
});

test('a declaration is used as written, and a check the project no longer defines fails loudly', () => {
  const checks = staticChecks(
    manifest(
      [
        'check',
        { name: 'docs', command: ['node', 'x.mjs'], inputs: ['docs/**'] },
        { script: 'fmt', inputs: ['**/*.ts'] },
      ],
      { check: 'a', fmt: 'b' },
    ),
  );
  assert.deepEqual(
    checks.map(item => [item.name, item.command.join(' '), item.inputs]),
    [
      ['check', 'npm run -s check', null],
      ['docs', 'node x.mjs', ['docs/**']],
      ['fmt', 'npm run -s fmt', ['**/*.ts']],
    ],
  );
  assert.deepEqual(
    staticChecks(manifest([], { 'format:check': 'x' })),
    [],
    'an empty declaration turns the defaults off',
  );
  assert.throws(() => staticChecks(manifest(['gone'], {})), /cannot run/);
  assert.throws(() => staticChecks(manifest([{ inputs: ['a'] }])), /cannot run/);
});

test('inputs scope a check to the paths it reads; untouched checks are named', () => {
  const globs = {
    '**/*.{ts,mjs}': [
      ['a.ts', true],
      ['src/deep/b.mjs', true],
      ['a.md', false],
      ['src/a.tsx', false],
    ],
    'docs/**': [
      ['docs/a.md', true],
      ['docs/x/y.png', true],
      ['src/docs/a.md', false],
    ],
    '*.md': [
      ['README.md', true],
      ['docs/README.md', false],
    ],
    '.oxfmtrc.json': [
      ['.oxfmtrc.json', true],
      ['a/.oxfmtrc.json', false],
    ],
  };
  for (const [glob, cases] of Object.entries(globs))
    for (const [path, expected] of cases)
      assert.equal(globRegExp(glob).test(path), expected, `${glob} vs ${path}`);
  const checks = staticChecks(
    manifest(
      [
        'always',
        { name: 'ts', script: 'ts', inputs: ['**/*.ts'] },
        { name: 'md', script: 'md', inputs: ['*.md'] },
      ],
      {
        always: 'x',
        ts: 'x',
        md: 'x',
      },
    ),
  );
  const { selected, untouched } = selectStaticChecks(checks, ['src/a.ts']);
  assert.deepEqual(
    selected.map(item => item.name),
    ['always', 'ts'],
  );
  assert.deepEqual(untouched, ['md']);
});

test('a static check that fails fails preflight before any build or test and names itself; passes and timeouts are reported', () => {
  const results = runStaticChecks(
    process.cwd(),
    [
      { name: 'ok', command: [process.execPath, '-e', ''], inputs: null, source: 'declared' },
      { name: 'bad', command: [process.execPath, '-e', 'process.exit(3)'], inputs: null, source: 'declared' },
      {
        name: 'slow',
        command: [process.execPath, '-e', 'setTimeout(()=>{},5000)'],
        inputs: null,
        source: 'declared',
      },
    ],
    300,
  );
  assert.deepEqual(
    results.map(item => [item.name, item.outcome]),
    [
      ['ok', 'passed'],
      ['bad', 'failed'],
      ['slow', 'timed-out'],
    ],
  );
});

function fixture(t, checks, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-preflight-static-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = new Map([
    ['package.json', manifest(checks, { 'format:check': 'x' })],
    ['src/a.ts', 'export const n = 1;'],
    ['src/b.ts', 'export const n = 2;'],
    ['tests/a.test.mjs', "import test from 'node:test'; import '../src/a.ts'; test('a', () => {});"],
    ['tests/b.test.mjs', "import test from 'node:test'; import '../src/b.ts'; test('b', () => {});"],
    ...Object.entries(extra),
  ]);
  for (const [path, body] of bytes) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const files = () => [...bytes].map(([path, body]) => ({ path, blob: digest(body), mode: 'file' }));
  const plan = (paths, options) =>
    preflightPlan(root, { paths, complete: true }, { laneId, files: files() }, options);
  const run = p => runPreflight(root, laneId, digest(JSON.stringify(files())), p, sourceTree(files()));
  return { root, plan, run };
}

test('preflight runs the static checks a change triggers before tests, and a failure skips the tests', t => {
  const f = fixture(t, [
    {
      name: 'bad format',
      command: [process.execPath, '-e', 'console.error("unformatted"); process.exit(1)'],
      inputs: ['**/*.ts'],
    },
    { name: 'docs', command: [process.execPath, '-e', ''], inputs: ['docs/**'] },
  ]);
  const plan = f.plan(['src/a.ts']);
  assert.deepEqual(
    plan.static.selected.map(item => item.name),
    ['bad format'],
  );
  assert.deepEqual(plan.static.untouched, ['docs']);
  const receipt = f.run(plan);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.exitCode, 1);
  assert.deepEqual(
    receipt.static.map(item => [item.name, item.outcome]),
    [['bad format', 'failed']],
  );
  assert.equal(receipt.tests, plan.tests.length, 'planned tests are counted, none was started');
  assert.equal(receipt.testMs, undefined, 'no test process ran');
  assert.equal(receipt.buildMs, undefined);
  assert.deepEqual(preflightFileStats(f.root), {}, 'nothing was observed, so nothing is recorded');
});

test('a passing static check lets the tests run; a docs-only change still runs the checks that read docs', t => {
  const f = fixture(t, [{ name: 'ok', command: [process.execPath, '-e', ''], inputs: null }], {
    'docs/guide.md': '# Guide\n',
  });
  const code = f.plan(['src/a.ts']);
  const receipt = f.run(code);
  assert.equal(receipt.passed, true);
  assert.deepEqual(
    receipt.static.map(item => item.outcome),
    ['passed'],
  );
  assert.ok(receipt.testMs !== undefined);
  const docs = f.plan(['docs/guide.md']);
  assert.deepEqual(docs.tests, []);
  assert.deepEqual(
    docs.static.selected.map(item => item.name),
    ['ok'],
  );
  const docsReceipt = f.run(docs);
  assert.equal(docsReceipt.passed, true);
  assert.deepEqual(
    docsReceipt.static.map(item => item.outcome),
    ['passed'],
  );
});

test('a misdeclared static check makes the plan unavailable with its reason instead of silently skipping', t => {
  const f = fixture(t, ['missing-script']);
  const plan = f.plan(['src/a.ts']);
  assert.equal(plan.status, 'unavailable');
  assert.match(plan.reason, /cannot run/);
});

test('likely-failing tests run first, then the cheapest; the watch tier keeps its evidence order', () => {
  const tiers = [
    { tier: 'direct', tests: ['a', 'b', 'c', 'd'] },
    { tier: 'watch', tests: ['w1', 'w2', 'w3'] },
  ];
  const stats = {
    a: { ms: 9000, failed: false },
    b: { ms: 100, failed: false },
    c: { ms: 5000, failed: true },
    w2: { ms: 1, failed: true },
  };
  const [direct, watch] = orderByHistory(tiers, stats, 1000);
  // c failed last time; then b (100 ms), d (unknown = 1000 ms fallback), a (9000 ms).
  assert.deepEqual(direct.tests, ['c', 'b', 'd', 'a']);
  assert.deepEqual(watch.tests, ['w2', 'w1', 'w3']);
});

test('after a failure the remaining groups are not started and the receipt says so; passes are kept', t => {
  const f = fixture(t, [], {
    'tests/a.test.mjs':
      "import test from 'node:test'; import '../src/a.ts'; test('a', () => { throw new Error('boom'); });",
  });
  const agent = join(f.root + '.forge-client', 'agent');
  mkdirSync(agent, { recursive: true });
  // Slow, previously failing a runs first; each file is its own group at 40 s per file.
  writeFileSync(
    join(agent, 'preflight-files.json'),
    JSON.stringify({
      'tests/a.test.mjs': { ms: 40000, failed: true },
      'tests/b.test.mjs': { ms: 40000, failed: false },
    }),
  );
  const plan = f.plan(['src/a.ts', 'src/b.ts']);
  assert.deepEqual(plan.tests, ['tests/a.test.mjs', 'tests/b.test.mjs']);
  const receipt = f.run(plan);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.stoppedForFailure, 1);
  assert.equal(receipt.tests, 1);
  assert.equal(receipt.deferredTests, 1);
  assert.deepEqual(Object.keys(preflightFileStats(f.root)).sort(), ['tests/a.test.mjs', 'tests/b.test.mjs']);
  assert.equal(preflightFileStats(f.root)['tests/a.test.mjs'].failed, true);
});

test('observed per-file time and the slowest files are recorded for the next plan', t => {
  const f = fixture(t, []);
  const receipt = f.run(f.plan(['src/a.ts', 'src/b.ts']));
  assert.equal(receipt.passed, true);
  const stats = preflightFileStats(f.root);
  assert.deepEqual(Object.keys(stats).sort(), ['tests/a.test.mjs', 'tests/b.test.mjs']);
  assert.ok(stats['tests/a.test.mjs'].ms >= 0 && stats['tests/a.test.mjs'].failed === false);
  assert.ok(receipt.slowest.length >= 1 && receipt.slowest.length <= 3);
});

test('budget the ranked tiers leave over runs the cheapest timed tests the budget cut, last; unranked coverage never fills it', t => {
  const near = "import test from 'node:test'; import './near-fixture.mjs'; test('d', () => {});";
  const f = fixture(t, [], {
    // Two modules between src/a.ts and these tests: the trimmable near tier.
    'src/m1.ts': "import './a.ts';",
    'src/m2.ts': "import './m1.ts';",
    'tests/near-fixture.mjs': "import '../src/m2.ts';",
    'tests/d3.test.mjs': "import test from 'node:test'; import '../src/m2.ts'; test('d', () => {});",
    'tests/d1.test.mjs': near,
    'tests/d2.test.mjs': near,
    // Reaches src/a.ts only through a computed path: landing coverage, not evidence about this change.
    'tests/dynamic.test.mjs':
      "import test from 'node:test'; test('d', async () => { await import(process.argv[2] ?? 'node:fs'); });",
  });
  const agent = join(f.root + '.forge-client', 'agent');
  mkdirSync(agent, { recursive: true });
  writeFileSync(
    join(agent, 'preflight-files.json'),
    JSON.stringify({
      'tests/d1.test.mjs': { ms: 50, failed: false },
      'tests/d2.test.mjs': { ms: 10, failed: false },
      'tests/d3.test.mjs': { ms: 600000, failed: false },
      'tests/dynamic.test.mjs': { ms: 5, failed: false },
    }),
  );
  const plan = f.plan(['src/a.ts']);
  assert.deepEqual(plan.tests.slice(0, 1), ['tests/a.test.mjs']);
  // d3 is closest (no shared fixture) but takes ten minutes, so the budget cuts the near tier there;
  // the cut d2 (10 ms) and d1 (50 ms) fill the leftover, cheapest first.
  assert.deepEqual(plan.tests.slice(-2), ['tests/d2.test.mjs', 'tests/d1.test.mjs']);
  assert.ok(plan.deferredTests.includes('tests/d3.test.mjs'));
  assert.ok(plan.deferredTests.includes('tests/dynamic.test.mjs'), 'unranked coverage never fills');
  assert.equal(plan.local.filler, 2);
  assert.match(plan.local.summary, /2 cheap test file\(s\) timed in earlier runs use the leftover budget/);
  // The estimate is what the wall-time cap allows: at most the budget plus the longest planned file.
  assert.ok(plan.estimateMinutes >= 1);
  assert.ok(plan.estimateMinutes <= Math.ceil((plan.local.budgetSeconds + 4) / 60));
});

const guardManifest = guards =>
  JSON.stringify({ type: 'module', scripts: {}, forge: { preflight: { guards } } });
const runtimeGuard = {
  name: 'runtime',
  tests: ['tests/runtime-guard.test.mjs'],
  inputs: ['src/**'],
};
// Stands in for convex-runtime-imports: it finds the offence by reading source, not by importing it.
const runtimeGuardTest = `import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
test('no Node global in src', () => assert.doesNotMatch(readFileSync(new URL('../src/' + 'size.ts', import.meta.url), 'utf8'), /Buffer\\./));`;

test('guards are declared once with path rules; a malformed one or a missing test fails loudly', () => {
  const has = path => path === 'tests/runtime-guard.test.mjs';
  const guards = preflightGuards(guardManifest([runtimeGuard]), has);
  assert.deepEqual(guards, [runtimeGuard]);
  assert.deepEqual(selectGuards(guards, ['src/x.ts']).selected, guards);
  assert.deepEqual(selectGuards(guards, ['docs/x.json']), { selected: [], untouched: ['runtime'] });
  assert.deepEqual(preflightGuards('{"scripts":{}}', has), []);
  assert.deepEqual(preflightGuards('not json', has), []);
  assert.throws(
    () => preflightGuards(guardManifest([{ name: 'gone', tests: ['tests/gone.test.mjs'] }]), has),
    /cannot run/,
  );
  assert.throws(
    () => preflightGuards(guardManifest([{ tests: ['tests/runtime-guard.test.mjs'] }]), has),
    /cannot run/,
  );
});

test('a triggered guard runs first and the time budget never trims it, even where no import reaches it', t => {
  const f = fixture(t, [], {
    'package.json': guardManifest([
      runtimeGuard,
      { name: 'docs only', tests: ['tests/b.test.mjs'], inputs: ['docs/**'] },
    ]),
    'src/size.ts': 'export const size = (s: string) => s.length;',
    'tests/runtime-guard.test.mjs': runtimeGuardTest,
  });
  const plan = f.plan(['src/a.ts'], { budgetSeconds: 0 });
  assert.equal(plan.tests[0], 'tests/runtime-guard.test.mjs');
  assert.ok(plan.tests.includes('tests/a.test.mjs') || plan.deferredTests.includes('tests/a.test.mjs'));
  assert.equal(plan.local.mandatory >= 1, true);
  assert.deepEqual(
    plan.local.guards.map(item => item.name),
    ['runtime'],
  );
  assert.equal(typeof plan.local.guards[0].seconds, 'number');
  assert.match(plan.local.summary, /Guards always run first, never trimmed: runtime ~\d/);
  assert.ok(!plan.local.tierTests.mandatory.includes('tests/b.test.mjs'), 'an untouched guard stays out');
});

test('replay (b78ca196): a Node global in a Convex-loaded src file fails preflight locally, before the budget', t => {
  const f = fixture(t, [], {
    'package.json': guardManifest([runtimeGuard]),
    'src/size.ts': 'export const size = (s: string) => Buffer.byteLength(s);',
    'tests/runtime-guard.test.mjs': runtimeGuardTest,
  });
  const plan = f.plan(['src/size.ts'], { budgetSeconds: 0 });
  assert.deepEqual(plan.tests, ['tests/runtime-guard.test.mjs']);
  const receipt = f.run(plan);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.stoppedForTime, undefined);
  assert.deepEqual(
    receipt.slowest.map(item => item.file),
    ['tests/runtime-guard.test.mjs'],
  );
});
