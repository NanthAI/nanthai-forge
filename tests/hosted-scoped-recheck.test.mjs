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
import { policyPreset } from '../dist/autonomy-policy.js';
import { firstCheckReceipt, hostedAcceptanceSchema } from '../dist/hosted-acceptance.js';
import { smokeTests } from '../scripts/test-impact.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { passWithSelection, seedFullMain, useSyntheticHostedEnv } from './hosted-race-fixture.mjs';

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
  ['convex/projectConvexSourceOutput.ts', 'export const cost = 1;'],
  ['convex/projectFreshness.ts', "import './projectConvexSourceOutput.ts'; export const freshness = 1;"],
  ['src/native-projection.ts', 'export const old = 1;'],
  ['tests/convex-source-r2.test.mjs', "import '../convex/projectConvexSourceOutput.ts';"],
  ['tests/project-freshness.test.mjs', "import '../convex/projectFreshness.ts';"],
  ['tests/native-projection.test.mjs', "import '../dist/native-projection.js';"],
];
// Main gains the Lane's own path (the same bytes, so the composition is clean) and
// a module importing it. A path-disjoint import overlap alone now lands on the
// first check under the main audit (Issue 7fe54c7c): see the disjoint replay below.
const overlapping = [
  ['convex/projectConvexSourceOutput.ts', 'export const cost = 2;'],
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
    selectedFiles: [['convex/projectConvexSourceOutput.ts', 'export const cost = 2;']],
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
  // A full recheck, a cohort and the admission run itself keep their records.
  assert.deepEqual(firstCheckReceipt(admission, { runId: 'b', reused: false, batch: false }), {
    landedOn: 'recheck',
    reason: 'tested-doc',
  });
  assert.equal(
    firstCheckReceipt(admission, { runId: 'b', reused: false, batch: true, scoped }).landedOn,
    'recheck',
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
