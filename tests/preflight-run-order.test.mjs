// SPDX-License-Identifier: Apache-2.0
// Item 5dcfce75, preflight-miss fixes 3 and 4: when the protected tiers outlast the wall-time
// budget, the files the clock stops must be the least likely to fail. The landing-check failures
// preflight had selected but never started (9 between 2026-11-18 and 11-19) sat behind smoke and
// explicit-coverage files in the mandatory tier, or deep in the direct tier. Now cheap repo-wide
// guards, guards, the change's own and named tests run first, the rest by learned saving per second
// (p x C / r, the 13ea93bf formula), smoke and explicit coverage last; the same files run.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protectedRunOrder } from '../dist/preflight-run-order.js';
import { preflightPlan, preflightRuntime } from '../dist/agent-preflight.js';
import { protectedTiers, selectPreflightTests } from '../scripts/test-impact.mjs';
import { digest } from '../dist/state/hash.js';

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

/** Files the wall clock starts within `budget` seconds, in run order. */
const started = (order, secondsFor, budget) => {
  const out = [];
  let used = 0;
  for (const test of order) {
    if (used >= budget) break;
    out.push(test);
    used += secondsFor(test);
  }
  return out;
};

test('fast guards and fast saving files, guards, own tests, learned, named, then saving per second; smoke last', () => {
  const tiers = [
    {
      tier: 'mandatory',
      tests: ['g.test', 'smoke.test', 'docs-reader.test', 'slow-scan.test', 'fast-scan.test', 'own.test'],
    },
    { tier: 'learned', tests: ['learned-a.test', 'learned-b.test'] },
    {
      tier: 'direct',
      tests: ['near-1.test', 'named.test', 'flaky.test', 'near-2.test', 'costly.test', 'cheap.test'],
    },
    { tier: 'wide', tests: ['wide.test'] },
  ];
  const seconds = {
    'g.test': 50,
    'fast-scan.test': 0.5,
    'slow-scan.test': 9,
    'flaky.test': 3,
    'learned-b.test': 20,
    'costly.test': 40,
    'cheap.test': 0.5,
  };
  // p x C / r: a run of flaky saves 30 s for 3 s of time, learned-b 30 s for 20 s; costly's 10 s
  // saving is less than its 40 s, so it keeps its place; cheap saves 25 s for 0.5 s.
  const saving = { 'flaky.test': 30, 'learned-b.test': 30, 'costly.test': 10, 'cheap.test': 25 };
  const order = protectedRunOrder({
    tiers,
    isProtected: tier => protectedTiers.has(tier),
    guards: new Set(['g.test']),
    treeGuards: ['slow-scan.test', 'fast-scan.test'],
    leadTests: ['own.test', 'named.test'],
    ownTests: ['own.test'],
    budgetSeconds: 180,
    measuredSeconds: test => seconds[test],
    secondsFor: test => seconds[test] ?? 4,
    failureSeconds: test => saving[test] ?? 0,
  });
  assert.deepEqual(order, [
    // Ahead of the guard, which the clock never stops, so the cheap scan and the cheap file that keeps
    // failing always start.
    'fast-scan.test',
    'cheap.test',
    'g.test',
    // The change's own test right after the guards, as before; then the learned tier, by saving.
    'own.test',
    'learned-b.test',
    'learned-a.test',
    'named.test',
    'flaky.test',
    // No positive saving: the earlier order, closest first.
    'near-1.test',
    'near-2.test',
    'costly.test',
    // Smoke and explicit coverage (a slow scan is explicit coverage), in their earlier order.
    'smoke.test',
    'docs-reader.test',
    'slow-scan.test',
    'wide.test',
  ]);
  // Membership never changes.
  assert.deepEqual([...order].sort(), tiers.flatMap(item => item.tests).sort());
});

test('an untimed repo-wide guard runs after the lead tests, and fast guards stop at 30 s together', () => {
  const order = protectedRunOrder({
    tiers: [{ tier: 'mandatory', tests: ['smoke.test', 'scan.test', 'own.test'] }],
    isProtected: () => true,
    guards: new Set(),
    treeGuards: ['scan.test'],
    leadTests: ['own.test'],
    ownTests: ['own.test'],
    budgetSeconds: 180,
    measuredSeconds: () => undefined,
    secondsFor: () => 4,
    failureSeconds: () => 0,
  });
  assert.deepEqual(order, ['own.test', 'scan.test', 'smoke.test']);
  // Each scan also keeps failing (a positive saving): it still counts once toward the 30 s.
  const scans = Array.from({ length: 20 }, (_, i) => `scan-${String(i).padStart(2, '0')}.test`);
  const capped = protectedRunOrder({
    tiers: [{ tier: 'mandatory', tests: ['g.test', ...scans] }],
    isProtected: () => true,
    guards: new Set(['g.test']),
    treeGuards: scans,
    leadTests: [],
    ownTests: [],
    budgetSeconds: 180,
    measuredSeconds: () => 2,
    secondsFor: () => 2,
    failureSeconds: () => 10,
  });
  assert.deepEqual(capped, [...scans.slice(0, 15), 'g.test', ...scans.slice(15)]);
});

/** Seconds from the run's start to `test`'s start, in `order`. */
const startsAt = (order, secondsFor, test) =>
  order.slice(0, order.indexOf(test)).reduce((sum, item) => sum + secondsFor(item), 0);

test("fast files never push the change's own tests past the budget the guards leave them", () => {
  const scans = Array.from({ length: 10 }, (_, i) => `scan-${i}.test`);
  const secondsFor = test => (test === 'guard.test' ? 150 : test === 'own.test' ? 20 : 2);
  const input = budgetSeconds => ({
    tiers: [{ tier: 'mandatory', tests: ['guard.test', 'own.test', ...scans] }],
    isProtected: () => true,
    guards: new Set(['guard.test']),
    treeGuards: scans,
    leadTests: ['own.test'],
    ownTests: ['own.test'],
    budgetSeconds,
    measuredSeconds: secondsFor,
    secondsFor,
    failureSeconds: () => 0,
  });
  // 180 - 150 - 20 leaves 10 s: five 2 s scans go first, the change's test still starts by 170 s.
  const order = protectedRunOrder(input(180));
  assert.deepEqual(order.slice(0, 7), [...scans.slice(0, 5), 'guard.test', 'own.test']);
  assert.ok(startsAt(order, secondsFor, 'own.test') + secondsFor('own.test') <= 180);
  // Guards alone outlast a 120 s budget: nothing after them starts, so the scans keep their 30 s.
  assert.deepEqual(protectedRunOrder(input(120)).slice(0, 11), [...scans, 'guard.test']);
});

test('fast files never push a file that failed before past the budget; the rest of them run right after it', () => {
  // Review probe (bc16584b): guard 100 s, own test 50 s, fifteen 2 s repo-wide guards, one 10 s file
  // that failed for these paths (on main it starts at 150 s and runs).
  const scans = Array.from({ length: 15 }, (_, i) => `scan-${String(i).padStart(2, '0')}.test`);
  const secondsFor = test =>
    ({ 'guard.test': 100, 'own.test': 50, 'red.test': 10, 'named.test': 4 })[test] ?? 2;
  const input = tiers => ({
    tiers,
    isProtected: () => true,
    guards: new Set(['guard.test']),
    treeGuards: scans,
    leadTests: ['own.test', 'named.test'],
    ownTests: ['own.test'],
    failing: new Set(['red.test']),
    budgetSeconds: 180,
    measuredSeconds: secondsFor,
    secondsFor,
    failureSeconds: () => 0,
  });
  // 180 - 100 - 50 - 10 leaves 20 s: ten scans first; the failing file starts at 170 s.
  const expected = [
    ...scans.slice(0, 10),
    'guard.test',
    'own.test',
    'red.test',
    ...scans.slice(10),
    'named.test',
  ];
  // The same for a file in the learned tier and for a mandatory file that failed in the last run here.
  for (const tiers of [
    [
      { tier: 'mandatory', tests: ['guard.test', 'own.test', ...scans] },
      { tier: 'learned', tests: ['red.test'] },
      { tier: 'direct', tests: ['named.test'] },
    ],
    [
      { tier: 'mandatory', tests: ['guard.test', 'own.test', 'red.test', ...scans] },
      { tier: 'direct', tests: ['named.test'] },
    ],
  ]) {
    const order = protectedRunOrder(input(tiers));
    assert.deepEqual(order, expected);
    assert.ok(startsAt(order, secondsFor, 'red.test') < 180);
  }
});

test('the first 10 s of fast files always start, even when files that failed before fill the budget', () => {
  const scans = Array.from({ length: 10 }, (_, i) => `scan-${i}.test`);
  const secondsFor = test => (test === 'guard.test' ? 60 : test.startsWith('red-') ? 50 : 2);
  const order = protectedRunOrder({
    tiers: [
      { tier: 'mandatory', tests: ['guard.test', ...scans] },
      { tier: 'learned', tests: ['red-1.test', 'red-2.test', 'red-3.test'] },
    ],
    isProtected: () => true,
    guards: new Set(['guard.test']),
    treeGuards: scans,
    leadTests: [],
    ownTests: [],
    budgetSeconds: 180,
    measuredSeconds: secondsFor,
    secondsFor,
    failureSeconds: () => 0,
  });
  // 60 + 150 s already outlast 180 s: five scans (10 s) still go first, the rest follow the learned tier.
  assert.deepEqual(order, [
    ...scans.slice(0, 5),
    'guard.test',
    'red-1.test',
    'red-2.test',
    'red-3.test',
    ...scans.slice(5),
  ]);
});

test('a slow mandatory file that failed for these paths or last run keeps its early slot; fast guards use no room', () => {
  const secondsFor = test => ({ 'g.test': 1, 'fast.test': 1 })[test] ?? 9;
  const order = protectedRunOrder({
    tiers: [
      { tier: 'mandatory', tests: ['g.test', 'smoke.test', 'reader.test', 'red-reader.test', 'fast.test'] },
      { tier: 'direct', tests: ['near.test', 'named.test', 'red-near.test'] },
    ],
    isProtected: () => true,
    guards: new Set(['g.test']),
    treeGuards: ['fast.test'],
    leadTests: ['named.test'],
    ownTests: [],
    // red-reader failed for these paths (the learned tier leaves out mandatory files); red-near failed
    // in the last run here.
    failing: new Set(['red-reader.test', 'red-near.test']),
    budgetSeconds: 180,
    measuredSeconds: secondsFor,
    secondsFor,
    // The guard also keeps failing: it still runs with the guards, not in the fast room.
    failureSeconds: test => (test === 'g.test' ? 20 : 0),
  });
  assert.deepEqual(order, [
    'fast.test',
    'g.test',
    'red-reader.test',
    'red-near.test',
    'named.test',
    'near.test',
    'smoke.test',
    'reader.test',
  ]);
});

/** A Lane checkout whose mandatory tier holds 40 slow document readers ahead of the change's own test
 * by name, the budget-cut shape (the failing file sat at mandatory position 9 to 61). */
function lane(t, record = false) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-run-order-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = new Map([
    ['package.json', '{"type":"module","scripts":{}}'],
    ['scripts/forge-check.mjs', ''],
    ['src/queue.ts', 'export const queue = [];'],
    ['tests/queue.test.mjs', "import '../dist/queue.js';"],
    ['tests/zz-queue-order.test.mjs', "import '../dist/queue.js';"],
    ['tests/files.test.mjs', ''],
    ['tests/aa-near.test.mjs', "import '../dist/queue.js';"],
    ['tests/zz-far.test.mjs', "import '../dist/queue.js';"],
    [
      'tests/src-rules.test.mjs',
      "import { readdirSync } from 'node:fs';\nreaddirSync(new URL('../src', import.meta.url), { recursive: true });",
    ],
  ]);
  for (let i = 0; i < 40; i++)
    files.set(
      `tests/a-reader-${i}.test.mjs`,
      // test-signal: allow fixture source of a synthetic document reader, never read here
      "readFileSync(new URL('../docs/queue.md', import.meta.url));",
    );
  for (const [path, body] of files) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  // This machine timed the scan and the readers before.
  const stats = { 'tests/src-rules.test.mjs': { ms: 300, failed: false } };
  for (let i = 0; i < 40; i++) stats[`tests/a-reader-${i}.test.mjs`] = { ms: 5000, failed: false };
  mkdirSync(join(`${root}.forge-client`, 'agent'), { recursive: true });
  writeFileSync(join(`${root}.forge-client`, 'agent', 'preflight-files.json'), JSON.stringify(stats));
  if (record) {
    // The project's own record: aa-near failed two landing checks (for other paths, so it is not in
    // this change's learned tier), and the server's window says a failure costs C / r = 100 s.
    const now = Date.now();
    const learned = {
      'src/a.ts': { 'tests/aa-near.test.mjs': now - 60_000 },
      'src/b.ts': { 'tests/aa-near.test.mjs': now - 120_000 },
    };
    writeFileSync(
      join(`${root}.forge-client`, 'agent', 'preflight-learned.json'),
      JSON.stringify({ learned, lanes: {} }),
    );
    writeFileSync(
      join(`${root}.forge-client`, 'agent', 'preflight-guards.json'),
      JSON.stringify({ rev: 'r1', outcomes: 10, failed: 2, C: 200, r: 2, runnerMinutes: null, files: [] }),
    );
  }
  const head = [...files].map(([path, body]) => ({ path, blob: digest(body), mode: 'file' }));
  return { root, files, head };
}

test('a long mandatory tier starts the change, its named test and the fast scan inside the budget', t => {
  const { root, head } = lane(t);
  const paths = ['src/queue.ts', 'docs/queue.md', 'tests/zz-queue-order.test.mjs'];
  const plan = preflightPlan(
    root,
    { paths, complete: true },
    { laneId: '33333333-3333-4333-8333-333333333333', files: head },
  );
  assert.equal(plan.status, 'planned', plan.reason);
  const secondsFor = test =>
    test.startsWith('tests/a-reader-') ? 5 : test.endsWith('src-rules.test.mjs') ? 0.3 : 4;
  const first = started(plan.tests, secondsFor, 180);
  for (const test of ['tests/src-rules.test.mjs', 'tests/zz-queue-order.test.mjs', 'tests/queue.test.mjs'])
    assert.ok(first.includes(test), `${test} starts within 180 s: ${plan.tests.slice(0, 5).join(', ')}`);
  assert.deepEqual(plan.tests.slice(0, 3), [
    'tests/src-rules.test.mjs',
    'tests/zz-queue-order.test.mjs',
    'tests/queue.test.mjs',
  ]);
  // Smoke and the readers still run, after them: nothing left the plan.
  assert.ok(plan.tests.includes('tests/files.test.mjs'));
  assert.equal(plan.tests.filter(test => test.startsWith('tests/a-reader-')).length, 40);
});

test('a file whose learned saving beats its seconds runs before files that never failed', t => {
  const paths = ['src/queue.ts', 'tests/zz-queue-order.test.mjs'];
  const position = record => {
    const { root, head } = lane(t, record);
    const plan = preflightPlan(
      root,
      { paths, complete: true },
      { laneId: '33333333-3333-4333-8333-333333333333', files: head },
    );
    assert.equal(plan.status, 'planned', plan.reason);
    return ['tests/aa-near.test.mjs', 'tests/zz-far.test.mjs'].map(test => plan.tests.indexOf(test));
  };
  const [failed, other] = position(false);
  assert.ok(other >= 0 && failed > other, `without a record the earlier order holds: ${failed}, ${other}`);
  // 2 failures of 10 outcomes x 200 s / 2 runs = 20 s saved per run, more than its estimated 4 s.
  const [failedWith, otherWith] = position(true);
  assert.ok(
    failedWith >= 0 && failedWith < otherWith,
    `with the record it runs first: ${failedWith}, ${otherWith}`,
  );
});

test('the selector names the lead tests and the repo-wide guards of a change', t => {
  const { files } = lane(t);
  const plan = selectPreflightTests({
    files,
    paths: ['src/queue.ts', 'tests/zz-queue-order.test.mjs'],
    hubBudget: { seconds: 180, secondsFor: () => 4 },
  });
  assert.deepEqual(plan.leadTests, ['tests/zz-queue-order.test.mjs', 'tests/queue.test.mjs']);
  assert.deepEqual(plan.treeGuards, ['tests/src-rules.test.mjs']);
});
