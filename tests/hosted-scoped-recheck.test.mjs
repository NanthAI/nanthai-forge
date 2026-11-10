// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { scopedRecheckSelection } from '../dist/scoped-recheck.js';
import {
  acceptScopedRecheck,
  scopedRecheckBase,
  scopedRecheckEligible,
  scopedRecheckGate,
} from '../dist/scoped-recheck-policy.js';
import { actionsGateSelection } from '../dist/hosted-actions-job-plan.js';
import { policyPreset as preset } from '../dist/autonomy-policy.js';
// Server preflight gate (Issue 029138ef) has its own tests (hosted-landing-desired.test.mjs).
const policyPreset = name => ({ ...preset(name), agentDefaults: { preflight: 'advise' } });
import { firstCheckReceipt, hostedAcceptanceSchema } from '../dist/hosted-acceptance.js';
import { smokeTests } from '../scripts/test-impact.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { passWithSelection, seedFullMain, useSyntheticHostedEnv } from './hosted-race-fixture.mjs';
import * as recheckSelection from '../dist/scoped-recheck.js';
import * as recheckPolicy from '../dist/scoped-recheck-policy.js';
import * as intersection from '../dist/package-intersection.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { commandSelection } from '../dist/check-command-scope.js';
import { buildPackageGraph } from '../dist/package-graph.js';
import { writeCheckPackages } from '../dist/package-graph-checkout.js';
import { batchesFixture, states } from './hosted-landing-batches-fixture.mjs';

useSyntheticHostedEnv(test);

const head = 'c'.repeat(64);
const files = (extra = []) =>
  new Map([
    ['package.json', '{"scripts":{}}'],
    ['package-lock.json', '{"lockfileVersion":3,"packages":{}}'],
    ['convex/lane.ts', 'export const lane = 1;'],
    ['convex/main.ts', 'export const main = 1;'],
    ['convex/both.ts', "import './lane.ts'; import './main.ts'; export const both = 1;"],
    ['tests/lane.test.mjs', "import '../convex/lane.ts';"],
    ['tests/main.test.mjs', "import '../convex/main.ts';"],
    ['tests/both.test.mjs', "import '../convex/both.ts';"],
    ['tests/other.test.mjs', "import 'node:assert';"],
    ...smokeTests.map(path => [path, "import 'node:test';"]),
    ...extra,
  ]);

test('overlapping Convex impact selects only the shared tests, own tests and smoke', () => {
  const selected = scopedRecheckSelection({
    lanePaths: ['convex/lane.ts', 'tests/new.test.mjs'],
    mainPaths: ['convex/main.ts'],
    files: files([['tests/new.test.mjs', "import '../convex/lane.ts';"]]),
  });
  assert.equal(selected.scope, 'scoped');
  assert.deepEqual(selected.tests, ['tests/both.test.mjs', 'tests/new.test.mjs', ...smokeTests].sort());
  assert.match(selected.reason, /1 tests affected by main and this change, 1 own tests/);
  assert.match(selected.reason, /3 of 10 full-suite tests are main-audit debt/);
});

test("replay (c): this change's package, lockfile, selector, root configuration and deletions keep the full suite", () => {
  const extra = [
    ['scripts/test-impact.mjs', 'export const selector = 1;'],
    ['scripts/forge-check.mjs', "import './test-impact.mjs';"],
    ['tsconfig.json', '{}'],
  ];
  for (const [lane, main] of [
    [['package.json'], ['convex/main.ts']],
    [['package-lock.json'], ['convex/main.ts']],
    [['scripts/test-impact.mjs'], ['convex/main.ts']],
    [['tsconfig.json'], ['convex/main.ts']],
    [['convex/deleted.ts'], ['convex/main.ts']],
  ]) {
    const selected = scopedRecheckSelection({ lanePaths: lane, mainPaths: main, files: files(extra) });
    assert.equal(selected.scope, 'full', `${lane} × ${main}`);
    assert.equal(selected.tests.length, 9);
  }
});

// Issue fc215574 (dogfood 2026-11-08: 18 of 18 refused proofs rechecked in full, most because main's
// delta held a root file, a check-pipeline script or a deleted path). Main's delta passed main's own
// checks; a main path the selector cannot place reaches every test, so the shared set is this
// change's own affected set, never the whole suite. Before: each case below selected all 9 tests.
test("replay: a main path the selector cannot place reruns only this change's affected tests", () => {
  const extra = [
    ['scripts/test-impact.mjs', 'export const selector = 1;'],
    ['scripts/forge-check.mjs', "import './test-impact.mjs';"],
    ['tsconfig.json', '{}'],
  ];
  for (const main of [
    ['package.json'],
    ['package-lock.json', 'convex/main.ts'],
    ['scripts/test-impact.mjs'],
    ['tsconfig.json'],
    ['convex/deleted.ts'],
  ]) {
    const selected = scopedRecheckSelection({
      lanePaths: ['convex/lane.ts'],
      mainPaths: main,
      files: files(extra),
    });
    assert.equal(selected.scope, 'scoped', `${main}: ${selected.reason}`);
    assert.deepEqual(
      selected.tests,
      ['tests/both.test.mjs', 'tests/lane.test.mjs', ...smokeTests].sort(),
      `${main}`,
    );
    assert.match(selected.reason, /main reaches every test/);
  }
});

// Issue debe08fa: both sides changed one Markdown file that a test reads (proof refusal `tested-doc`).
// The recheck reruns that document's readers (plus smoke), not the suite. Before: a Markdown-only side
// had no affected tests, so the readers of the merged document were silently skipped.
test('replay: a tested-document overlap reruns only the tests that read the document', () => {
  const docs = [
    ['docs/guide.md', '# Guide\n'],
    ['docs/other.md', '# Other\n'],
    ['tests/guide.test.mjs', "readFileSync('docs/guide.md', 'utf8');"],
  ];
  const only = scopedRecheckSelection({
    lanePaths: ['docs/guide.md'],
    mainPaths: ['docs/guide.md', 'convex/main.ts'],
    files: files(docs),
  });
  assert.equal(only.scope, 'scoped', only.reason);
  assert.deepEqual(only.tests, ['tests/guide.test.mjs', ...smokeTests].sort());
  assert.match(
    only.reason,
    /1 tests affected by main and this change \(through the tests that read a changed document\)/,
  );
  // Code on both sides plus the shared document: the shared import set and the document's readers.
  const mixed = scopedRecheckSelection({
    lanePaths: ['convex/lane.ts', 'docs/guide.md'],
    mainPaths: ['convex/main.ts', 'docs/guide.md'],
    files: files(docs),
  });
  assert.deepEqual(mixed.tests, ['tests/both.test.mjs', 'tests/guide.test.mjs', ...smokeTests].sort());
  // A document no test reads adds no test; code-only overlaps are unchanged.
  const untested = scopedRecheckSelection({
    lanePaths: ['docs/other.md'],
    mainPaths: ['docs/other.md'],
    files: files(docs),
  });
  assert.deepEqual(untested.tests, [...smokeTests].sort());
});

test('incident e4aee4fe: a shell script beside the bench harness keeps the main-race recheck scoped', () => {
  const bench = [
    ['scripts/bench/oracle.mjs', "spawnSync('bash', [join(here, 'oracle.sh')]); export const oracle = 1;"],
    ['scripts/bench/run-cell.mjs', "import './oracle.mjs'; export const cell = 1;"],
    ['tests/bench.test.mjs', "import '../scripts/bench/run-cell.mjs';"],
  ];
  // Before: 'Unclassified or deleted path: scripts/bench/oracle.sh' widened every recheck to full.
  const selected = scopedRecheckSelection({
    lanePaths: ['scripts/bench/oracle.sh', 'scripts/bench/run-cell.mjs'],
    mainPaths: ['convex/main.ts'],
    files: files(bench),
  });
  assert.equal(selected.scope, 'scoped', selected.reason);
  assert.deepEqual(selected.tests, [...smokeTests].sort(), 'no test reaches both sides');
  // The same script named by product code is runtime behavior: keep the full suite.
  const product = scopedRecheckSelection({
    lanePaths: ['scripts/bench/oracle.sh'],
    mainPaths: ['convex/main.ts'],
    files: files([...bench, ['convex/runner.ts', "const script = 'scripts/bench/oracle.sh';"]]),
  });
  assert.equal(product.scope, 'full');
});

test('the planner runs the scoped selection only for a server-stamped recheck with its base', () => {
  const gate = scopedRecheckGate({
    checked: { id: randomUUID(), head, digest: head },
    checkedBase: { head: 'd'.repeat(64), receiptId: 'r' },
    runId: randomUUID(),
  });
  assert.equal(scopedRecheckBase(gate), 'd'.repeat(64));
  assert.equal(scopedRecheckBase({ mode: 'contract', reason: gate.reason }), null);
  assert.equal(scopedRecheckBase({ mode: 'scoped', reason: 'scoped-recheck:nope' }), null);
  const scoped = actionsGateSelection({ gate }, ['convex/lane.ts'], files(), true, ['convex/main.ts']);
  assert.deepEqual(scoped.tests, ['tests/both.test.mjs', ...smokeTests].sort());
  // Missing checked-base bytes select everything rather than failing the check.
  const missing = actionsGateSelection({ gate }, ['convex/lane.ts'], files(), true, null);
  assert.equal(missing.scope, 'full');
  assert.match(missing.reason, /^Scoped recheck base unavailable/);
});

test('scoped recheck eligibility mirrors the contract gate under either gate and pauses on red main', () => {
  const input = (patch = {}) => {
    const policy = policyPreset('trusted');
    Object.assign(policy.acceptance, patch.acceptance ?? {});
    return {
      policy,
      project: { owner: 'owner' },
      actor: patch.actor ?? { kind: 'agent', id: 'owner' },
      paths: patch.paths === undefined ? ['convex/lane.ts'] : patch.paths,
      contract: null,
      main: {
        status: 'green',
        unaudited: { count: 0, firstAt: null },
        debt: false,
        hold: null,
        ...patch.main,
      },
    };
  };
  assert.equal(scopedRecheckEligible(input()), true);
  assert.equal(acceptScopedRecheck(input()), 'pass');
  // Either gate (Issue fc215574): the full gate and an absent gate run scoped main-race rechecks too.
  assert.equal(scopedRecheckEligible(input({ acceptance: { gate: 'full' } })), true);
  assert.equal(acceptScopedRecheck(input({ acceptance: { gate: 'full' } })), 'pass');
  assert.equal(scopedRecheckEligible(input({ acceptance: { gate: undefined } })), true);
  for (const patch of [
    { acceptance: { scopedRecheck: false } },
    { acceptance: { gate: 'full', scopedRecheck: false } },
    { acceptance: { mode: 'review' } },
    { actor: { kind: 'agent', id: 'contributor' } },
    { paths: null },
    { main: { debt: true } },
    { main: { status: 'unknown' } },
  ]) {
    assert.equal(scopedRecheckEligible(input(patch)), false, JSON.stringify(patch));
    assert.equal(acceptScopedRecheck(input(patch)), 'full-required', JSON.stringify(patch));
  }
  assert.equal(scopedRecheckEligible(input({ main: { status: 'red' } })), false);
  assert.equal(acceptScopedRecheck(input({ main: { status: 'red' } })), 'main-red');
});

test('dogfood-size selection uses one graph within runner memory and time budgets', () => {
  const tree = files();
  for (let i = 0; i < 2800; i++) tree.set(`convex/m${i}.ts`, `import './m${(i + 1) % 2800}.ts';`);
  for (let i = 0; i < 1300; i++) tree.set(`src/s${i}.ts`, `export const s = ${i};`);
  for (let i = 0; i < 640; i++) tree.set(`tests/t${i}.test.mjs`, `import '../dist/s${i}.js';`);
  const before = process.memoryUsage().heapUsed,
    started = performance.now();
  const selected = scopedRecheckSelection({
    lanePaths: ['src/s1.ts', 'convex/lane.ts'],
    mainPaths: ['src/s1.ts', 'convex/main.ts'],
    files: tree,
  });
  const ms = performance.now() - started,
    heap = process.memoryUsage().heapUsed - before;
  assert.equal(selected.scope, 'scoped');
  assert.deepEqual(selected.tests, ['tests/both.test.mjs', 'tests/t1.test.mjs', ...smokeTests].sort());
  console.log(JSON.stringify({ files: tree.size, tests: 650, selected: selected.tests.length, ms, heap }));
  assert(ms < 10_000, `selection took ${ms} ms`);
  assert(heap < 256 * 1024 * 1024, `selection held ${heap} bytes`);
});

// Replays on the hosted finish fixture. Synthetic bytes; the lane edits a Convex
// module that main's delta also reaches through a shared test.
const baselineFiles = [
  ['package.json', '{"scripts":{}}'],
  ['package-lock.json', '{"lockfileVersion":3,"packages":{}}'],
  ['convex/projectConvexSourceOutput.ts', 'export const cost = 1;\n// gap\nexport const note = 1;\n'],
  ['convex/projectFreshness.ts', "import './projectConvexSourceOutput.ts'; export const freshness = 1;"],
  ['src/native-projection.ts', 'export const old = 1;'],
  ['tests/convex-source-r2.test.mjs', "import '../convex/projectConvexSourceOutput.ts';"],
  ['tests/project-freshness.test.mjs', "import '../convex/projectFreshness.ts';"],
  ['tests/native-projection.test.mjs', "import '../dist/native-projection.js';"],
];
// Main gains a distinct, line-clean edit on the Lane's own path (identical bytes reuse the pass) and
// a module importing it. A path-disjoint import overlap alone now lands on the
// first check under the main audit (Issue 7fe54c7c): see the disjoint replay below.
const overlapping = [
  ['convex/projectConvexSourceOutput.ts', 'export const cost = 1;\n// gap\nexport const note = 2;\n'],
  ['convex/projectFreshness.ts', "import './projectConvexSourceOutput.ts'; export const freshness = 2;"],
];
const effective = (f, runId, value) => {
  const row = [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === runId);
  const run = JSON.parse(row.value);
  // A project with no configured gate stamps none on its ordinary runs.
  if (!run.gate) return;
  run.gate = { ...run.gate, effective: value };
  f.patch('projectHostedCheckRuns', row._id, { gate: run.gate, value: JSON.stringify(run) });
};
async function race(t, { mainFiles = overlapping, policy = {} } = {}) {
  const f = await finishFixture(t, {
    baselineFiles,
    selectedFiles: [
      ['convex/projectConvexSourceOutput.ts', 'export const cost = 2;\n// gap\nexport const note = 1;\n'],
    ],
    mainFiles,
  });
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...policyPreset('trusted'),
      acceptance: { ...policyPreset('trusted').acceptance, ...policy },
    },
  });
  // Only the direct Actions runner carries server gates.
  const { credential: _credential, ...runner } = f.rawChecks.runner;
  f.rawChecks.configuration = await f.rawChecks.configure(
    { kind: 'runner', configuration: runner },
    f.rawChecks.configuration.digest,
  );
  const state = await f.enqueue(f.request({ agent: true }));
  await f.drain();
  const before = (await f.status(state.id)).attempt;
  const selection = f.c.put(
    JSON.stringify({
      scope: 'full',
      tests: baselineFiles.map(([p]) => p).filter(p => p.startsWith('tests/')),
    }),
  );
  await passWithSelection(f, before.check.runId, selection);
  effective(f, before.check.runId, 'full');
  while ((await f.current(state.id)).submission.phase !== 'ready') await f.execute();
  f.moveMain();
  const parent = await seedFullMain(f, selection);
  effective(f, parent.id, 'full');
  const main = f.currentMain();
  f.insert('projectHostedMainAudits', {
    projectId: f.projectId,
    lastGreen: { sequence: main.sourceRevision, head: main.head, runId: parent.id },
  });
  const calls = f.counts.length;
  for (let n = 0; n < 80 && (await f.current(state.id)).submission.phase !== 'checking'; n++) {
    if ((await f.current(state.id)).submission.phase === 'landed') break;
    await f.execute();
  }
  const io = f.counts.slice(calls);
  // The retry attempt and its check are installed by one existing transaction.
  const install = io.find(c => c.name === 'reuseComplete');
  return {
    f,
    state,
    before,
    selection,
    budget: { calls: io.length, installWrites: install?.writes, installDocuments: install?.documents },
  };
}

test('replay (a): a disjoint race transfers the proof and starts no run', async t => {
  const { f, state, before } = await race(t, {
    mainFiles: [['src/native-projection.ts', 'export const old = 2;']],
  });
  for (let n = 0; n < 40 && (await f.current(state.id)).submission.phase !== 'landed'; n++) await f.execute();
  const { attempt } = await f.status(state.id);
  assert.equal(attempt.crossHeadProof.checked.head, before.candidate.head);
  assert.equal(attempt.recheck, undefined);
  assert.equal(f.tables.projectHostedCheckRuns.size, 2, 'original Candidate check and the main pass only');
});

test('a path-disjoint import overlap lands on its first check and arms the main audit now', async t => {
  const { f, state, before } = await race(t, { mainFiles: [overlapping[1]] });
  for (let n = 0; n < 40 && (await f.current(state.id)).submission.phase !== 'landed'; n++) await f.execute();
  const { attempt } = await f.status(state.id);
  assert.equal(attempt.crossHeadProof.algorithm, 'clean-disjoint-v2');
  assert.equal(attempt.crossHeadProof.checked.head, before.candidate.head);
  assert.equal(f.tables.projectHostedCheckRuns.size, 2, 'original Candidate check and the main pass only');
  const audit = [...f.tables.projectHostedMainAudits.values()][0];
  assert.equal(audit.firstCheck, f.currentMain().sourceRevision);
});

test('replay (b): an overlapping Convex race runs one scoped recheck that lands with audit debt', async t => {
  const { f, state, before, selection } = await race(t);
  const { attempt } = await f.status(state.id);
  assert.equal(attempt.crossHeadProof, undefined);
  assert.deepEqual(attempt.recheck, {
    checked: { id: before.candidate.id, head: before.candidate.head, digest: before.candidate.digest },
    checkedBase: before.main,
    runId: before.check.runId,
  });
  assert.equal(f.tables.projectHostedCheckRuns.size, 3, 'one recheck replaces the full recheck');
  const run = await f.rawChecks.status(attempt.check.runId);
  assert.deepEqual(run.gate, { mode: 'scoped', reason: `scoped-recheck:${before.main.head}` });
  await passWithSelection(f, run.id, selection);
  effective(f, run.id, 'contract');
  for (let n = 0; n < 40 && (await f.current(state.id)).submission.phase !== 'landed'; n++) await f.execute();
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  const receipt = JSON.parse(
    [...f.tables.projectHostedAcceptances.values()].find(row => row.submissionId === state.id).value,
  );
  assert.equal(receipt.check.runId, run.id);
  const audit = [...f.tables.projectHostedMainAudits.values()][0];
  assert.equal(audit.unaudited.count, 1, 'the skipped tests are main-audit debt');
});

// Issue fc215574: the full gate (and no configured gate) ran every main-race recheck in full.
for (const [name, gate] of [
  ['the full gate', 'full'],
  ['no configured gate', undefined],
])
  test(`replay: under ${name} an overlapping race runs one scoped recheck that lands with audit debt`, async t => {
    const { f, state, before, selection } = await race(t, { policy: { gate } });
    const { attempt } = await f.status(state.id);
    assert.equal(attempt.recheck?.checked.head, before.candidate.head, 'the first full pass is the basis');
    const run = await f.rawChecks.status(attempt.check.runId);
    // Before: no basis and a full (or gateless) run.
    assert.deepEqual(run.gate, { mode: 'scoped', reason: `scoped-recheck:${before.main.head}` });
    await passWithSelection(f, run.id, selection);
    effective(f, run.id, 'contract');
    for (let n = 0; n < 40 && (await f.current(state.id)).submission.phase !== 'landed'; n++)
      await f.execute();
    assert.equal((await f.current(state.id)).submission.phase, 'landed');
    const audit = [...f.tables.projectHostedMainAudits.values()][0];
    assert.equal(audit.unaudited.count, 1, 'the skipped tests are main-audit debt');
  });

test("under the full gate a contributor's race keeps the full recheck", async t => {
  const { f, state } = await race(t, { policy: { gate: 'full', autoActors: ['someone-else'] } });
  const { attempt } = await f.status(state.id);
  const run = await f.rawChecks.status(attempt.check.runId);
  assert.equal(run.gate?.mode ?? 'full', 'full');
});

test('scopedRecheck:false keeps the full recheck; on costs no extra Convex calls or writes', async t => {
  const off = await race(t, { policy: { scopedRecheck: false } });
  const on = await race(t);
  const { attempt } = await off.f.status(off.state.id);
  assert.equal(attempt.recheck, undefined);
  assert.equal((await off.f.rawChecks.status(attempt.check.runId)).gate.mode, 'full');
  console.log(JSON.stringify({ on: on.budget, off: off.budget }));
  // Separate fixtures in one process differ in first-use object registration, so
  // compare the race's function calls and its installing transaction.
  assert.equal(on.budget.calls, off.budget.calls, 'no extra Convex function calls per race');
  assert.equal(on.budget.installWrites, off.budget.installWrites, 'no extra document writes');
  assert(on.budget.installDocuments - off.budget.installDocuments <= 8, 'a few reads inside that call');
});

test('replay (d): a failing scoped recheck follows the normal failure path and never lands', async t => {
  const { f, state } = await race(t);
  const { attempt } = await f.status(state.id);
  const prepared = await f.rawChecks.prepare(attempt.check.runId, 1);
  await f.rawChecks.control(prepared.run.id, {
    kind: 'reserve',
    owner: prepared.owner,
    token: prepared.token,
  });
  const running = await f.rawChecks.control(prepared.run.id, {
    kind: 'observe',
    owner: prepared.owner,
    token: prepared.token,
    result: { status: 'accepted', executionId: 'synthetic-failed-scoped' },
  });
  await f.rawChecks.callback(f.rawChecks.shard(running.run, 0, 'failed'));
  await f.rawChecks.callback(f.rawChecks.complete(running.run, 'failed'));
  for (let n = 0; n < 40 && (await f.current(state.id)).submission.phase !== 'terminal-failed'; n++)
    await f.execute();
  assert.equal((await f.current(state.id)).submission.phase, 'terminal-failed');
  assert(![...f.tables.projectHostedAcceptances.values()].some(row => row.submissionId === state.id));
});

test('the receipt records landedOn scoped-intersection with the selection reason', () => {
  const admission = { runId: 'a', status: 'passed', full: true, recheck: 'tested-doc' };
  const scoped = { reason: 'Scoped recheck: 1 tests affected by main and this change', tests: 7 };
  assert.deepEqual(firstCheckReceipt(admission, { runId: 'b', reused: false, batch: false, scoped }), {
    landedOn: 'scoped-intersection',
    reason: 'tested-doc',
    selection: scoped.reason,
    tests: 7,
  });
  // A full recheck and the admission run itself keep their records; a cohort's scoped recheck
  // records it too (Issue 28f08555, below).
  assert.deepEqual(firstCheckReceipt(admission, { runId: 'b', reused: false, batch: false }), {
    landedOn: 'recheck',
    reason: 'tested-doc',
  });
  assert.equal(
    firstCheckReceipt(admission, { runId: 'b', reused: false, batch: true, scoped }).landedOn,
    'scoped-intersection',
  );
  assert.equal(
    firstCheckReceipt(admission, { runId: 'a', reused: false, batch: false, scoped }).landedOn,
    'admission-run',
  );
  const shape = hostedAcceptanceSchema.shape.firstCheck;
  assert.equal(
    shape.safeParse({
      landedOn: 'scoped-intersection',
      reason: 'tested-doc',
      selection: scoped.reason,
      tests: 7,
    }).success,
    true,
  );
});

// Issue 28f08555: a cohort's main-race recheck runs the union of each member's scoped intersection
// (the tests that can see both its checked change and everything else in the cohort's Candidate, its
// own tests, smoke), not the full union. A member that never passed a whole check, or whose own side
// cannot be placed, keeps the full union. New names come through namespace imports, so against
// main's sources (without the fix) each case below fails on its own.
const { batchScopedRecheckSelection } = recheckSelection;
const { cohortRecheckBases, isScopedRecheck, scopedRecheckBatchGate, scopedRecheckPairs } = recheckPolicy;
const { packageIntersectionUnion } = intersection;

const hex = c => c.repeat(64);
const cohortBasis = (base, checked) => ({
  checked: { id: randomUUID(), head: checked, digest: hex('e') },
  checkedBase: { head: base, receiptId: randomUUID() },
  runId: randomUUID(),
});
// Member A edits convex/a.ts, member B convex/b.ts, main convex/main.ts. tests/a-main reaches A and
// main, tests/a-b reaches both members, tests/b-only only B, tests/other nothing.
const cohortFiles = (extra = []) =>
  new Map([
    ['package.json', '{"scripts":{}}'],
    ['package-lock.json', '{"lockfileVersion":3,"packages":{}}'],
    ['convex/a.ts', 'export const a = 1;'],
    ['convex/b.ts', 'export const b = 1;'],
    ['convex/main.ts', 'export const main = 1;'],
    ['convex/a-main.ts', "import './a.ts'; import './main.ts'; export const am = 1;"],
    ['convex/a-b.ts', "import './a.ts'; import './b.ts'; export const ab = 1;"],
    ['tests/a-main.test.mjs', "import '../convex/a-main.ts';"],
    ['tests/a-b.test.mjs', "import '../convex/a-b.ts';"],
    ['tests/b-only.test.mjs', "import '../convex/b.ts';"],
    ['tests/other.test.mjs', "import 'node:assert';"],
    ...smokeTests.map(path => [path, "import 'node:test';"]),
    ...extra,
  ]);
// Each member's other side is everything in the cohort's Candidate that differs from what it checked:
// main's delta and the other member's change.
const raced = (a = ['convex/a.ts'], b = ['convex/b.ts']) => [
  { lanePaths: a, mainPaths: ['convex/main.ts', ...b] },
  { lanePaths: b, mainPaths: ['convex/main.ts', ...a] },
];

test('replay: a two-member cohort that raced main reruns the union of each member intersection', () => {
  const selected = batchScopedRecheckSelection({ members: raced(), files: cohortFiles() });
  assert.equal(selected.scope, 'scoped', selected.reason);
  // A×(main+B): a-main, a-b. B×(main+A): a-b. Plus smoke; b-only and other are main-audit debt.
  assert.deepEqual(selected.tests, ['tests/a-b.test.mjs', 'tests/a-main.test.mjs', ...smokeTests].sort());
  assert.match(selected.reason, /union of 2 member selection\(s\)/);
  assert.match(selected.reason, /2 of \d+ full-suite tests are main-audit debt/);
  // Each member's own test files always run.
  const own = batchScopedRecheckSelection({
    members: raced(['convex/a.ts', 'tests/a-new.test.mjs']),
    files: cohortFiles([['tests/a-new.test.mjs', "import 'node:assert';"]]),
  });
  assert(own.tests.includes('tests/a-new.test.mjs'));
  // The union is never narrower than either member's own solo intersection.
  for (const member of raced())
    for (const test of scopedRecheckSelection({ ...member, files: cohortFiles() }).tests)
      assert(selected.tests.includes(test), test);
});

test('replay: one member with an unplaced path on its own side keeps the full union', () => {
  for (const lane of [['package.json'], ['convex/deleted.ts'], ['tsconfig.json']]) {
    const selected = batchScopedRecheckSelection({
      members: raced(['convex/a.ts'], lane),
      files: cohortFiles([['tsconfig.json', '{}']]),
    });
    assert.equal(selected.scope, 'full', `${lane}`);
    assert.match(selected.reason, /^Cohort member: Scoped recheck needs full/);
    assert.equal(
      selected.tests.length,
      [...cohortFiles([['tsconfig.json', '{}']]).keys()].filter(p => /^tests\//.test(p)).length,
    );
  }
  assert.equal(batchScopedRecheckSelection({ members: [], files: cohortFiles() }).scope, 'full');
});

// Incident 7d98c7da (dogfood 2026-11-09): a cohort of three ready landings (bench harness scripts,
// Git serving, approvals) rechecked after the head entry landed a lint configuration change. The
// cohort ran the full suite (12 shards, 14 min, `scoped-unclassified`) because the bench member's
// own side "reached the check pipeline": a measurement script loads `join(runtime, 'dist/x.js')`,
// which counted as loading every file, and a static check names that script's path in its
// exemption list. A computed path whose trailing segments are literal names only files ending so.
const pipeline = (loader = "join(runtime, 'dist/exchange.js')") => [
  ['package.json', '{"scripts":{"check":"node scripts/check-foundation.mjs"}}'],
  ['scripts/check-foundation.mjs', "import './check-boundaries.mjs';"],
  [
    'scripts/check-boundaries.mjs',
    "export const exempt = new Map([['scripts/measure-latency.mjs', 'intercept']]);",
  ],
  [
    'scripts/measure-latency.mjs',
    `import { join } from 'node:path'; import { pathToFileURL } from 'node:url';
const runtime = process.env.RUNTIME ?? '.';
export const run = async path => (await import(pathToFileURL(${loader}))).exchange;`,
  ],
  ['src/exchange.ts', 'export const exchange = 1;'],
  ['tests/exchange.test.mjs', "import '../dist/exchange.js';"],
  ['scripts/bench/drain.mjs', 'export const drain = 1;'],
  ['scripts/bench/run-cell.mjs', "import './drain.mjs'; export const cell = 1;"],
  ['tests/bench-cell.test.mjs', "import '../scripts/bench/run-cell.mjs';"],
  ['.oxlintrc.json', '{}'],
];
const incidentCohort = [
  // The bench member: harness scripts and their test.
  {
    lanePaths: ['scripts/bench/drain.mjs', 'tests/bench-cell.test.mjs'],
    mainPaths: ['.oxlintrc.json', 'convex/a.ts'],
  },
  // The Git-serving member: Convex modules.
  { lanePaths: ['convex/a.ts'], mainPaths: ['.oxlintrc.json', 'scripts/bench/drain.mjs'] },
];

test('incident 7d98c7da: a bench-script member keeps the cohort recheck scoped after a lint-config head', () => {
  const files = cohortFiles(pipeline());
  const selected = batchScopedRecheckSelection({ members: incidentCohort, files });
  assert.equal(selected.scope, 'scoped', selected.reason);
  assert.equal(selected.fallback, undefined);
  // Main's root configuration reaches every test, so each member reruns its own affected set.
  for (const test of ['tests/bench-cell.test.mjs', 'tests/a-main.test.mjs', 'tests/a-b.test.mjs'])
    assert(selected.tests.includes(test), test);
  for (const test of ['tests/exchange.test.mjs', 'tests/b-only.test.mjs', 'tests/other.test.mjs'])
    assert(!selected.tests.includes(test), `${test} is main-audit debt`);
  // The literal ending still names its module: a change to it reaches the loading script's tests.
  const loaded = scopedRecheckSelection({
    lanePaths: ['src/exchange.ts'],
    mainPaths: ['convex/main.ts'],
    files: cohortFiles([
      ...pipeline(),
      ['tests/latency.test.mjs', "import '../scripts/measure-latency.mjs';"],
      ['tests/exchange-main.test.mjs', "import '../dist/exchange.js'; import '../convex/main.ts';"],
    ]),
  });
  assert.equal(loaded.scope, 'scoped', loaded.reason);
  assert(loaded.tests.includes('tests/exchange-main.test.mjs'));
  // A path with no literal ending, or one that leaves its folder, still may load anything: a script
  // that such a check-pipeline loader can reach keeps the full union.
  for (const loader of ['join(runtime, path)', "join(runtime, '../dist/exchange.js')"]) {
    const wide = batchScopedRecheckSelection({
      members: incidentCohort,
      files: cohortFiles(pipeline(loader)),
    });
    assert.equal(wide.scope, 'full', loader);
    assert.match(wide.reason, /scripts\/bench\/drain\.mjs reaches package-script:check/);
  }
});

test('the cohort gate carries every basis pair; old and other gates never parse as one', () => {
  const a = cohortBasis(hex('1'), hex('2')),
    b = cohortBasis(hex('3'), hex('4'));
  const gate = scopedRecheckBatchGate([a, b, a]);
  assert.equal(gate.mode, 'scoped');
  assert.deepEqual(scopedRecheckPairs(gate), [
    { base: hex('1'), checked: hex('2') },
    { base: hex('3'), checked: hex('4') },
  ]);
  assert.equal(scopedRecheckBase(gate), null, 'an older planner reads an ordinary scoped gate');
  assert(isScopedRecheck(gate) && isScopedRecheck(scopedRecheckGate(a)));
  assert.equal(scopedRecheckPairs(scopedRecheckGate(a)), null);
  assert.equal(scopedRecheckPairs({ mode: 'full', reason: gate.reason }), null);
  assert.equal(scopedRecheckPairs({ mode: 'scoped', reason: 'scoped-recheck-batch:' }), null);
  assert.equal(scopedRecheckPairs({ mode: 'scoped', reason: `scoped-recheck-batch:${hex('1')}` }), null);
  // Bases: the cohort's own whole pass covers every member; otherwise each member needs its own.
  assert.deepEqual(cohortRecheckBases(a, [{}, {}]), [a]);
  assert.deepEqual(cohortRecheckBases(undefined, [{ recheck: a }, { recheck: b }]), [a, b]);
  assert.equal(cohortRecheckBases(undefined, [{ recheck: a }, {}]), undefined);
  assert.equal(cohortRecheckBases(undefined, []), undefined);
});

test('the Actions planner runs the cohort union, and full when a basis State is unavailable', () => {
  const gate = scopedRecheckBatchGate([cohortBasis(hex('1'), hex('2')), cohortBasis(hex('3'), hex('4'))]);
  const paths = ['convex/a.ts', 'convex/b.ts'];
  const scoped = actionsGateSelection({ gate }, paths, cohortFiles(), true, null, raced());
  assert.deepEqual(scoped.tests, ['tests/a-b.test.mjs', 'tests/a-main.test.mjs', ...smokeTests].sort());
  const missing = actionsGateSelection({ gate }, paths, cohortFiles(), true, null, null);
  assert.equal(missing.scope, 'full');
  assert.match(missing.reason, /^Scoped recheck base unavailable/);
  assert.equal(missing.fallback, 'scoped-base-unavailable');
});

// Any CI: a configured command gets the per-member sides and FORGE_CHECK_PACKAGES the union of the
// members' package intersections.
const cargo = {
  'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
  'Cargo.lock': '',
  'crates/core/Cargo.toml': '[package]\nname = "fx-core"\n',
  'crates/core/src/lib.rs': '',
  'crates/api/Cargo.toml': '[package]\nname = "fx-api"\n\n[dependencies]\nfx-core = { path = "../core" }\n',
  'crates/api/src/lib.rs': '',
  'crates/tool/Cargo.toml': '[package]\nname = "fx-tool"\n',
  'crates/tool/src/main.rs': '',
  'crates/misc/Cargo.toml': '[package]\nname = "fx-misc"\n',
  'crates/misc/src/lib.rs': '',
};
const crates = [
  { lanePaths: ['crates/core/src/lib.rs'], mainPaths: ['crates/api/src/lib.rs', 'crates/tool/src/main.rs'] },
  { lanePaths: ['crates/tool/src/main.rs'], mainPaths: ['crates/api/src/lib.rs', 'crates/core/src/lib.rs'] },
];
test('a configured command gets each member side and the union of package intersections', t => {
  const run = {
    check: { executable: 'bash', args: ['ci.sh'], selection: { scope: 'changed-paths' } },
    gate: scopedRecheckBatchGate([cohortBasis(hex('1'), hex('2'))]),
    candidate: { base: { head: hex('5') } },
    request: { expectedHead: hex('6') },
  };
  const paths = ['crates/core/src/lib.rs', 'crates/tool/src/main.rs'];
  const selected = commandSelection(run, paths, new Set(), null, undefined, crates);
  assert.equal(selected.scope, 'scoped');
  assert.equal(selected.changes.mode, 'scoped');
  assert.deepEqual(
    selected.changes.members.map(m => m.paths),
    crates.map(m => m.lanePaths),
  );
  assert.equal(commandSelection(run, paths, new Set(), null, undefined, null).scope, 'full');
  const graph = buildPackageGraph(Object.keys(cargo), path => cargo[path]);
  const union = packageIntersectionUnion(graph, crates);
  // core×(api,tool): core, api. tool×(api,core): tool. misc is never reached.
  assert.deepEqual(union.packages.map(p => p.name).sort(), ['fx-api', 'fx-core', 'fx-tool']);
  assert.equal(
    packageIntersectionUnion(graph, [...crates, { lanePaths: ['Cargo.lock'], mainPaths: [] }]).scope,
    'full',
  );
  const root = mkdtempSync(join(tmpdir(), 'forge-cohort-packages-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(cargo)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const written = writeCheckPackages(root, selected.changes);
  t.after(() => written?.remove());
  const file = JSON.parse(readFileSync(written.path, 'utf8'));
  assert.equal(file.scope, 'scoped');
  assert.deepEqual(file.packages.map(p => p.name).sort(), ['fx-api', 'fx-core', 'fx-tool']);
});

test('every member receipt records landedOn scoped-intersection for a scoped cohort recheck', () => {
  const admission = { runId: 'a', status: 'passed', full: true, recheck: 'tested-doc' };
  const scoped = { reason: 'Scoped cohort recheck: union of 2 member selection(s), 7 tests', tests: 7 };
  assert.deepEqual(firstCheckReceipt(admission, { runId: 'b', reused: false, batch: true, scoped }), {
    landedOn: 'scoped-intersection',
    reason: 'tested-doc',
    selection: scoped.reason,
    tests: 7,
  });
  assert.deepEqual(
    firstCheckReceipt({ ...admission, recheck: undefined }, { runId: 'b', reused: false, batch: true }),
    {
      landedOn: 'recheck',
      reason: 'cohort',
    },
  );
});

// Hosted replays on the batch fixture: the direct Actions runner (the only one with server gates),
// green main, two members.
async function cohort(t, { bases = 'both', scopedRecheck } = {}) {
  const f = await batchesFixture(t, { count: 0 });
  if (scopedRecheck !== undefined) {
    const project = f.tables.hostedProjects.get(f.projectId);
    const policy = project.autonomyPolicy;
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: { ...policy, acceptance: { ...policy.acceptance, scopedRecheck } },
    });
  }
  const { credential: _credential, ...runner } = f.rawChecks.runner;
  f.rawChecks.configuration = await f.rawChecks.configure(
    { kind: 'runner', configuration: runner },
    f.rawChecks.configuration.digest,
  );
  const green = () => {
    const main = f.currentMain();
    for (const row of [...f.tables.projectHostedMainAudits.values()])
      f.patch('projectHostedMainAudits', row._id, {
        lastGreen: { sequence: main.sourceRevision, head: main.head, runId: randomUUID() },
        unaudited: { count: 0, firstAt: null },
        debt: false,
      });
    if (!f.tables.projectHostedMainAudits.size)
      f.insert('projectHostedMainAudits', {
        projectId: f.projectId,
        lastGreen: { sequence: main.sourceRevision, head: main.head, runId: randomUUID() },
      });
  };
  green();
  await f.add(0);
  await f.add(1);
  // Run until the cohort forms, before its shared composition reserves the check.
  for (let n = 0; n < 100 && !f.tables.projectHostedLandingBatches.size; n++) await f.execute(f.pending()[0]);
  const [row] = [...f.tables.projectHostedLandingBatches.values()];
  assert(row, 'the two members formed one cohort');
  const formed = JSON.parse(row.value);
  assert.equal(formed.phase, 'composing');
  // Both members passed their own whole check before main moved: the basis
  // projectHostedFinishCompose pins on each refused member attempt. Basis heads are State heads.
  const seeded = [];
  const members = formed.members.map((member, index) => {
    if (bases === 'none' || (bases === 'one' && index > 0)) return member;
    const recheck = cohortBasis(f.currentMain().head, f.entries[index].candidate.result.head);
    seeded.push(recheck);
    return { ...member, recheck };
  });
  f.patch('projectHostedLandingBatches', row._id, { value: JSON.stringify({ ...formed, members }) });
  const calls = f.counts.length;
  await f.drain();
  const io = f.counts.slice(calls);
  return {
    f,
    seeded,
    green,
    budget: { calls: io.length, writes: io.reduce((n, c) => n + (c.writes ?? 0), 0) },
  };
}

test('hosted replay: a cohort whose members each raced main stamps one scoped cohort recheck', async t => {
  const { f, seeded } = await cohort(t);
  assert.equal(new Set(states(f).map(s => s.batchId)).size, 1);
  assert.equal(f.runs().length, 1, 'one shared check');
  const run = f.runs()[0];
  // Before: { mode: 'full', reason: 'Hosted landing batch: full union gate' }.
  assert.equal(run.gate.mode, 'scoped', run.gate.reason);
  assert.deepEqual(run.gate, scopedRecheckBatchGate(seeded));
  assert.equal(scopedRecheckPairs(run.gate).length, 2);
  // The runner selected the union (effective contract): one landing, main-audit debt once per batch head.
  await f.passChecks();
  const row = [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === run.id);
  const passed = JSON.parse(row.value);
  passed.gate = { ...passed.gate, effective: 'contract' };
  f.patch('projectHostedCheckRuns', row._id, { gate: passed.gate, value: JSON.stringify(passed) });
  await f.drain();
  assert(
    states(f).every(s => s.phase === 'landed'),
    JSON.stringify(states(f).map(s => s.phase)),
  );
  const receipts = [...f.tables.projectHostedAcceptances.values()].map(r => JSON.parse(r.value));
  assert.equal(receipts.length, 2);
  assert(receipts.every(r => r.check.runId === run.id));
  const audit = [...f.tables.projectHostedMainAudits.values()][0];
  assert.equal(audit.unaudited.count, 1, 'the skipped tests are main-audit debt once per batch head');
});

test('hosted replay: a member without a whole-pass basis keeps the full union gate', async t => {
  for (const bases of ['one', 'none']) {
    const { f } = await cohort(t, { bases });
    assert.equal(f.runs().length, 1);
    assert.deepEqual(f.runs()[0].gate, { mode: 'full', reason: 'Hosted landing batch: full union gate' });
  }
});

test('hosted replay: a passing cohort refused by a main race rechecks scoped on its own pass', async t => {
  const { f, green } = await cohort(t, { bases: 'none' });
  const first = f.runs()[0];
  assert.equal(first.gate.mode, 'full');
  f.moveMain();
  green();
  await f.passChecks();
  const row = [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === first.id);
  const passed = JSON.parse(row.value);
  passed.gate = { ...passed.gate, effective: 'full' };
  f.patch('projectHostedCheckRuns', row._id, { gate: passed.gate, value: JSON.stringify(passed) });
  await f.drain();
  assert.equal(f.tables.projectHostedAcceptances.size, 0, 'main moved: nothing published on the old head');
  const retry = f.runs().find(r => r.id !== first.id);
  assert(retry, 'the cohort recomposed one shared check');
  // Before: a second full union gate. Now one basis: the cohort's own whole pass on the old main.
  assert.equal(retry.gate.mode, 'scoped', retry.gate.reason);
  assert.deepEqual(scopedRecheckPairs(retry.gate), [
    { base: first.candidate.base.head, checked: first.request.expectedHead },
  ]);
  const batch = JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value);
  assert.equal(batch.recheck.runId, first.id);
});

test('a scoped cohort recheck adds no Convex calls or writes over the full union gate', async t => {
  const on = await cohort(t);
  const off = await cohort(t, { scopedRecheck: false });
  assert.equal(off.f.runs()[0].gate.mode, 'full', 'scopedRecheck:false keeps the full union');
  assert.equal(on.f.runs()[0].gate.mode, 'scoped');
  console.log(JSON.stringify({ on: on.budget, off: off.budget }));
  assert.equal(on.budget.calls, off.budget.calls, 'no extra Convex function calls per cohort');
  assert(on.budget.writes <= off.budget.writes, 'no extra document writes');
});
