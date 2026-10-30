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

test('replay (c): package, lockfile, selector, root configuration and deletions keep the full suite', () => {
  const extra = [
    ['scripts/test-impact.mjs', 'export const selector = 1;'],
    ['scripts/forge-check.mjs', "import './test-impact.mjs';"],
    ['tsconfig.json', '{}'],
  ];
  for (const [lane, main] of [
    [['convex/lane.ts'], ['package.json']],
    [['package-lock.json'], ['convex/main.ts']],
    [['convex/lane.ts'], ['scripts/test-impact.mjs']],
    [['tsconfig.json'], ['convex/main.ts']],
    [['convex/lane.ts'], ['convex/deleted.ts']],
  ]) {
    const selected = scopedRecheckSelection({ lanePaths: lane, mainPaths: main, files: files(extra) });
    assert.equal(selected.scope, 'full', `${lane} × ${main}`);
    assert.equal(selected.tests.length, 9);
  }
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

test('scoped recheck eligibility mirrors the contract gate and pauses on red main', () => {
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
  for (const patch of [
    { acceptance: { scopedRecheck: false } },
    { acceptance: { gate: 'full' } },
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
const overlapping = [
  ['convex/projectFreshness.ts', "import './projectConvexSourceOutput.ts'; export const freshness = 2;"],
];
const effective = (f, runId, value) => {
  const row = [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === runId);
  const run = JSON.parse(row.value);
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
