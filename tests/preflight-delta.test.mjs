// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/portable-hash.js';
import { sourceTree } from '../dist/source-tree.js';
import {
  preflightPlan,
  runPreflight,
  preflightRuntime,
  preflightSecondsPerFile,
} from '../dist/agent-preflight.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { parsePeakRssMb } from '../dist/agent-preflight-measure.js';
import { deltaPaths, savedInventory } from '../dist/agent-preflight-evidence.js';
const laneId = '11111111-1111-4111-8111-111111111111';
const healthy = {
  ok: true,
  latencyMs: 1,
  fseventsdRssMb: null,
  fseventsdCpuPercent: null,
  reason: null,
  attempts: [],
};
test.beforeEach(t => t.mock.method(preflightRuntime, 'filesystemEventHealth', () => healthy));

function fixture(t, fail = false) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-preflight-delta-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = new Map([
    ['package.json', '{"type":"module","scripts":{}}'],
    ['scripts/forge-check.mjs', ''],
    ['src/a.ts', `export const n = ${fail ? 0 : 1};`],
    ['src/b.ts', 'export const n = 1;'],
    [
      'tests/a.test.mjs',
      "import test from 'node:test'; import assert from 'node:assert/strict'; import {n} from '../src/a.ts'; test('a', () => assert.equal(n,1));",
    ],
    ['tests/b.test.mjs', "import test from 'node:test'; import {n} from '../src/b.ts'; test('b', () => n);"],
  ]);
  const put = (path, body) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
    bytes.set(path, body);
  };
  for (const [path, body] of bytes) put(path, body);
  const files = () =>
    [...bytes].map(([path, body]) => ({
      path,
      blob: digest(body),
      mode: 'file',
    }));
  const plan = (extraPaths = [], options) =>
    preflightPlan(
      root,
      { paths: ['src/a.ts', 'src/b.ts', ...extraPaths], complete: true },
      { laneId, files: files() },
      options,
    );
  const run = p => runPreflight(root, laneId, digest(JSON.stringify(files())), p, sourceTree(files()));
  return { root, files, bytes, put, plan, run };
}
test('a small saved delta reruns its consumers and reuses passes for the unchanged tree', t => {
  const f = fixture(t);
  const initial = f.plan();
  assert.deepEqual([...initial.tests].sort(), ['tests/a.test.mjs', 'tests/b.test.mjs']);
  const firstReceipt = f.run(initial);
  assert.equal(firstReceipt.passed, true);
  f.put('src/a.ts', 'export const n = 1; // small correction');
  const delta = f.plan();
  assert.deepEqual(delta.deltaPaths, ['src/a.ts']);
  assert.equal(delta.reusedFrom.tree, firstReceipt.tree);
  assert.equal(delta.reusedFrom.evidence, firstReceipt.evidence);
  assert.deepEqual(delta.tests, ['tests/a.test.mjs']);
  assert.deepEqual(delta.reusedTests, ['tests/b.test.mjs']);
  const result = f.run(delta);
  assert.equal(result.passed, true);
  assert.equal(result.tests, 1);
  assert.equal(result.reusedTests, 1);
  const unchanged = f.plan();
  assert.deepEqual(unchanged.tests, []);
  assert.deepEqual([...unchanged.reusedTests].sort(), ['tests/a.test.mjs', 'tests/b.test.mjs']);
});
test('an added regression test runs without invalidating unrelated prior passes', t => {
  const f = fixture(t);
  assert.equal(f.run(f.plan()).passed, true);
  f.put('tests/new.test.mjs', "import test from 'node:test'; test('new', () => {});");
  const delta = f.plan(['tests/new.test.mjs']);
  assert.deepEqual(delta.tests, ['tests/new.test.mjs']);
  assert.deepEqual([...delta.reusedTests].sort(), ['tests/a.test.mjs', 'tests/b.test.mjs']);
  assert.equal(f.run(delta).passed, true);
});
test('a failed run retains passing files; failed and newly affected files must execute', t => {
  const f = fixture(t, true);
  assert.equal(f.run(f.plan()).passed, false);
  const retry = f.plan();
  assert.deepEqual(retry.tests, ['tests/a.test.mjs']);
  assert.deepEqual(retry.reusedTests, ['tests/b.test.mjs']);
  f.put('src/a.ts', 'export const n = 1;');
  const corrected = f.plan();
  assert.deepEqual(corrected.tests, ['tests/a.test.mjs']);
  assert.deepEqual(corrected.reusedTests, ['tests/b.test.mjs']);
  assert.equal(f.run(corrected).passed, true);
});
test('the old graph still invalidates consumers when a dependency edge is removed', t => {
  const f = fixture(t);
  f.put('src/b.ts', "import './a.ts'; export const n = 1;");
  assert.equal(f.run(f.plan()).passed, true);
  f.put('src/b.ts', 'export const n = 1;');
  f.put('src/a.ts', 'export const n = 1; // changed');
  const delta = f.plan();
  assert.deepEqual([...delta.tests].sort(), ['tests/a.test.mjs', 'tests/b.test.mjs']);
  assert.deepEqual(delta.reusedTests, []);
});
test('missing/tampered evidence and root configuration changes never transfer a pass', t => {
  const f = fixture(t);
  const result = f.run(f.plan());
  f.put('package.json', '{"type":"module","scripts":{},"config":1}');
  const config = f.plan();
  assert.deepEqual(config.reusedTests, []);
  // Full coverage is explicitly deferred to landing; it is never a reused local pass.
  assert.deepEqual([...config.tests].sort(), ['tests/a.test.mjs', 'tests/b.test.mjs']);
  const evidence = join(clientCacheRoot(f.root), 'agent/preflight/evidence', `${result.evidence}.gz`);
  writeFileSync(evidence, 'corrupt');
  const fallback = f.plan();
  assert.deepEqual(fallback.reusedTests, []);
  assert.deepEqual([...fallback.tests].sort(), ['tests/a.test.mjs', 'tests/b.test.mjs']);
  const receiptPath = join(clientCacheRoot(f.root), 'agent/preflight', `${laneId}.json`);
  const old = JSON.parse(readFileSync(receiptPath, 'utf8'));
  delete old.evidence;
  writeFileSync(receiptPath, JSON.stringify(old));
  assert.deepEqual(f.plan().reusedTests, []);
});
test('delta identity includes addition, deletion and mode changes; unavailable base paths stay unavailable', t => {
  const f = fixture(t);
  const before = f.files();
  const after = before
    .filter(file => file.path !== 'src/a.ts')
    .map(file => (file.path === 'src/b.ts' ? { ...file, mode: 'executable' } : file));
  after.push({ path: 'src/new.ts', blob: digest('new'), mode: 'file' });
  assert.deepEqual(deltaPaths(before, after), ['src/a.ts', 'src/b.ts', 'src/new.ts']);
  assert.equal(
    preflightPlan(f.root, { paths: [], complete: false }, { laneId, files: after }).status,
    'unavailable',
  );
});

test('a receipt labels deferred full coverage as local execution', t => {
  const f = fixture(t);
  const receipt = f.run({
    status: 'planned',
    scope: 'full',
    tests: [],
    deferredTests: ['tests/a.test.mjs', 'tests/b.test.mjs'],
    estimateMinutes: 0,
    command: null,
  });
  assert.equal(receipt.selection, 'local');
  assert.equal(receipt.tests, 0);
  assert.equal(receipt.deferredTests, 2);
});

test('a sparse selector inventory defers unseen consumers and never reuses partial source evidence', t => {
  const f = fixture(t);
  assert.equal(savedInventory(f.files(), new Map(f.bytes)), true);
  const partial = new Map(f.bytes);
  partial.delete('tests/b.test.mjs');
  assert.equal(savedInventory(f.files(), partial), false);
  rmSync(join(f.root, 'tests/b.test.mjs'));
  const plan = f.plan();
  assert.equal(plan.scope, 'full');
  assert.ok(plan.deferredTests.includes('tests/b.test.mjs'));
  assert.deepEqual(plan.reusedTests, []);
});

test('environment failure before execution cannot create reusable per-file passes and recovery runs the tests', t => {
  const f = fixture(t);
  t.mock.method(preflightRuntime, 'filesystemEventHealth', () => ({
    ...healthy,
    ok: false,
    reason: 'watcher close timed out',
  }));
  const receipt = f.run(f.plan());
  assert.equal(receipt.passed, false);
  assert.equal(receipt.exitCode, null);
  assert.equal(receipt.environment.code, 'FILESYSTEM_EVENTS_UNHEALTHY');
  const retry = f.plan();
  assert.deepEqual(retry.reusedTests, []);
  assert.deepEqual([...retry.tests].sort(), ['tests/a.test.mjs', 'tests/b.test.mjs']);
  t.mock.method(preflightRuntime, 'filesystemEventHealth', () => healthy);
  assert.equal(f.run(retry).passed, true);
  assert.deepEqual([...f.plan().reusedTests].sort(), ['tests/a.test.mjs', 'tests/b.test.mjs']);
});

test('environment classification after a failed run preserves only the reporter actual passes', t => {
  const f = fixture(t, true);
  let checks = 0;
  t.mock.method(preflightRuntime, 'filesystemEventHealth', () =>
    ++checks === 1 ? healthy : { ...healthy, ok: false, reason: 'watcher process timed out' },
  );
  const receipt = f.run(f.plan());
  assert.equal(checks, 2);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.exitCode, 1);
  assert.equal(receipt.environment.category, 'ENVIRONMENT');
  assert.match(receipt.environment.next, /land --save/);
  const retry = f.plan();
  assert.deepEqual(retry.tests, ['tests/a.test.mjs']);
  assert.deepEqual(retry.reusedTests, ['tests/b.test.mjs']);
  f.put('src/a.ts', 'export const n = 1;');
  t.mock.method(preflightRuntime, 'filesystemEventHealth', () => healthy);
  assert.equal(f.run(f.plan()).passed, true);
});

test('a real run records the rule, deferral target and measured wall time; peak RSS parses BSD and GNU reports', t => {
  const f = fixture(t);
  const plan = f.plan();
  assert.match(
    plan.local.summary,
    /Local rule: changed tests, explicit coverage and smoke; then tests that failed for these paths before; then tests that run a changed module directly, through a test fixture or through one module that imports it, or are named for it \(never trimmed, most specific first\)/,
  );
  assert.equal(plan.local.budgetSeconds, 180);
  const receipt = f.run(plan);
  assert.equal(receipt.passed, true);
  assert.match(receipt.rule, /run a changed module directly, through a test fixture/);
  assert.equal(receipt.budgetSeconds, 180);
  assert.equal(typeof receipt.testMs, 'number');
  assert.ok(receipt.peakRssMb === undefined || receipt.peakRssMb > 0);
  assert.equal(parsePeakRssMb('  1048576  maximum resident set size\n'), 1);
  assert.equal(parsePeakRssMb('Maximum resident set size (kbytes): 2048\n'), 2);
  assert.equal(parsePeakRssMb('nothing'), null);
});

/** tests/far.test.mjs reaches the changed src/b.ts through two modules: a `near` test the budget may
 * trim, unlike the direct tests/a.test.mjs. */
function distant(f) {
  rmSync(join(f.root, 'tests/b.test.mjs'));
  f.bytes.delete('tests/b.test.mjs');
  f.put('src/d.ts', "export { n } from './b.ts';");
  f.put('src/c.ts', "export { n } from './d.ts';");
  f.put(
    'tests/far.test.mjs',
    "import test from 'node:test'; import {n} from '../src/c.ts'; test('far', () => n);",
  );
}
test('a tiny budget trims by time, names the trimmed files and the one command that runs them', t => {
  const f = fixture(t);
  distant(f);
  const plan = f.plan([], { budgetSeconds: 5 });
  // Cold default is 4 s per file: the direct test runs, the near one is scheduled, not dropped.
  assert.deepEqual(plan.tests, ['tests/a.test.mjs']);
  assert.deepEqual(plan.deferredTests, ['tests/far.test.mjs']);
  assert.deepEqual(plan.local.trimmed, [{ tier: 'near', kept: 0, total: 1 }]);
  assert.deepEqual(plan.local.trimmedTests, ['tests/far.test.mjs']);
  assert.match(plan.local.rerun, /preflight '\{"laneId":"[^"]+","trim":false\}'$/);
  assert.match(plan.local.summary, /Trimmed near 0 of 1/);
  assert.match(plan.local.summary, /1 trimmed file\(s\) are named in trimmedTests; run them: nforge agent /);
  assert.match(plan.local.summary, /1 test file\(s\) deferred; they run in the pre-queue Lane check/);
  const receipt = f.run(plan);
  assert.equal(receipt.deferredTests, 1);
  assert.equal(receipt.deferredTo, 'pre-queue');
  assert.deepEqual(receipt.trimmedTiers, ['near']);
  assert.deepEqual(receipt.skipped, ['tests/far.test.mjs']);
  assert.equal(receipt.rerun, plan.local.rerun);
  assert.equal(receipt.budgetSeconds, 5);
  // The rerun runs every ranked tier with no budget, and reuses the pass it already has.
  const rerun = f.plan([], { budgetSeconds: 5, trim: false });
  assert.deepEqual(rerun.tests, ['tests/far.test.mjs']);
  assert.deepEqual(rerun.reusedTests, ['tests/a.test.mjs']);
  assert.equal(rerun.local.trim, false);
  assert.equal(rerun.local.trimmedTests, undefined);
  const second = f.run(rerun);
  assert.equal(second.passed, true);
  assert.equal(second.tests, 1);
  assert.equal(second.skipped, undefined);
});

test('direct tests are never trimmed by an estimate; the wall-time cap names the ones it did not start (8288e7f5)', t => {
  const f = fixture(t);
  // Both tests import a changed module directly: protected from the plan's trim, whatever the budget.
  const plan = f.plan([], { budgetSeconds: 1 });
  // Equally close: a stable hash orders them, not their names.
  assert.deepEqual([...plan.tests].sort(), ['tests/a.test.mjs', 'tests/b.test.mjs']);
  const [first, last] = plan.tests;
  assert.equal(plan.local.protected, 2);
  assert.equal(plan.local.protectedOverBudget, true);
  assert.equal(plan.local.trimmedTests, undefined);
  // The budget is a wall-time cap: with none left, the first (most relevant) file still runs and no
  // other starts; the receipt names the stopped file with a rerun of just those.
  plan.local.budgetSeconds = 0;
  const receipt = f.run(plan);
  // A stopped must-run file is never a pass (ec7960f9): NOT COMPLETE, with the one finish command.
  assert.equal(receipt.passed, false);
  assert.equal(receipt.exitCode, 0);
  assert.deepEqual(receipt.incomplete, {
    mustRun: 1,
    finish: `nforge agent '${f.root}' preflight '{"laneId":"${laneId}","retry":true,"trim":false}'`,
    estimateMinutes: 1,
  });
  assert.equal(receipt.tests, 1);
  assert.equal(receipt.stoppedForTime, 1);
  assert.deepEqual(receipt.stopped, [last]);
  assert.match(receipt.stoppedRerun, /preflight '\{"laneId":"[0-9a-f-]+","retry":true\}'/);
  // The finish command plans exactly the stopped files with no wall-time cap.
  const finish = f.plan([], { trim: false, only: receipt.stopped });
  assert.deepEqual(finish.tests, [last]);
  assert.equal(finish.local.trim, false);
  // That rerun plans exactly the stopped files; the passed one is reused, nothing else is added.
  const rerun = f.plan([], { budgetSeconds: 180, trim: true, only: receipt.stopped });
  assert.deepEqual(rerun.tests, [last]);
  assert.deepEqual(rerun.reusedTests, [first]);
  assert.ok(!rerun.local.filler, 'a rerun of stopped files adds no filler');
  const second = f.run(rerun);
  assert.equal(second.passed, true);
  assert.equal(second.tests, 1);
  assert.equal(second.stopped, undefined);
});

test('the run stops between groups when the local budget is spent and reports what it did not start', t => {
  const f = fixture(t);
  distant(f);
  const plan = f.plan([], { budgetSeconds: 100 });
  assert.deepEqual(plan.tests, ['tests/a.test.mjs', 'tests/far.test.mjs']);
  // A wrong estimate must not overrun: pretend the budget is already gone after the mandatory group.
  plan.local.budgetSeconds = 0;
  plan.local.mandatory = 1;
  const receipt = f.run(plan);
  assert.equal(receipt.passed, true);
  assert.equal(receipt.tests, 1);
  assert.equal(receipt.stoppedForTime, 1);
  assert.deepEqual(receipt.skipped, ['tests/far.test.mjs']);
  assert.deepEqual(receipt.stopped, ['tests/far.test.mjs']);
  assert.match(receipt.rerun, /"trim":false/);
  assert.equal(receipt.deferredTests, 1);
  assert.equal(receipt.deferredTo, 'pre-queue');
  assert.equal(f.plan().reusedTests.includes('tests/far.test.mjs'), false);
});

test('timing estimates average the last runs instead of trusting one sample', t => {
  const f = fixture(t);
  assert.deepEqual(preflightSecondsPerFile(f.root), { secondsPerFile: 4, basis: 'default' });
  const agent = join(f.root + '.forge-client', 'agent');
  mkdirSync(agent, { recursive: true });
  writeFileSync(
    join(agent, 'preflight-timings.json'),
    JSON.stringify([
      { tests: 10, ms: 6_000 },
      { tests: 30, ms: 90_000 },
    ]),
  );
  assert.deepEqual(preflightSecondsPerFile(f.root), { secondsPerFile: 2.4, basis: 'measured' });
  writeFileSync(join(agent, 'preflight-timings.json'), 'not json');
  assert.equal(preflightSecondsPerFile(f.root).basis, 'default');
});
