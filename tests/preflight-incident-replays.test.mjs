// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Incident replays on the real Forge inventory (Issue c14f4065): each case is a preflight that let a
// landing check fail or ran far more than the change needed. Selection only (a local graph read), plus
// the pure run verdict where a case needs it.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTRACT_PIN_SECONDS,
  changedExports,
  contractGuardTest,
  fitPreflightBudget,
  protectedTiers,
  removedNames,
  selectPreflightTests,
  selectTests,
  smokeTests,
  sourceFiles,
} from '../scripts/test-impact.mjs';
import { scanReaders } from '../scripts/test-tree-scanners.mjs';
import { recursiveFolderReader } from '../scripts/script-impact.mjs';
import { incompletePreflight, mustRunNotRun, preflightVerdict } from '../dist/agent-preflight-incomplete.js';
import * as preflight from '../dist/agent-preflight.js';
import {
  preflightGuards,
  selectGuards,
  selectStaticChecks,
  staticChecks,
} from '../dist/agent-preflight-static.js';
import { protectedRunOrder } from '../dist/preflight-run-order.js';
import { readFileSync } from 'node:fs';

const files = sourceFiles(new URL('..', import.meta.url).pathname);
// None of these paths is a script, so every case parses the same graph: one parse serves them all.
const graphCache = {};
const hubBudget = { seconds: 180, secondsFor: () => 4 };
// Paths are built at run time: a literal repo path here would make this file a reader of it.
const at = (...parts) => parts.join('/');
const tier = (plan, name) => plan.tiers.find(item => item.tier === name).tests;
const select = (paths, extra = {}) => {
  const complete = selectTests({ files, paths }, graphCache);
  const plan = selectPreflightTests({ files, paths, hubBudget, ...extra }, graphCache);
  // Exact partition: every landing-covered test is local or deferred, once.
  assert.deepEqual([...plan.tests, ...plan.deferredTests].sort(), complete.tests);
  assert.equal(new Set(plan.tests).size, plan.tests.length);
  return plan;
};

test('8809fba5: tests that reach a changed Convex module through shared fixtures are direct', t => {
  const plan = select([at('convex', 'projectHostedLandingCancel.ts')]);
  // These reach the module only through tests/hosted-landing-fixture.mjs (which loads
  // convex/projectHostedLanding.ts, which imports the changed module) or the acceptance fixture
  // built on it. All seven failed in a landing check after preflight passed.
  const failed = [
    at('tests', 'hosted-landing-cancel.test.mjs'),
    at('tests', 'hosted-landing-priority.test.mjs'),
    at('tests', 'hosted-landing.test.mjs'),
    at('tests', 'hosted-acceptance.test.mjs'),
    at('tests', 'hosted-contract-gate.test.mjs'),
    at('tests', 'hosted-mac-evidence.test.mjs'),
    at('tests', 'public-governance.test.mjs'),
  ];
  const direct = tier(plan, 'direct');
  for (const test of failed) assert.ok(direct.includes(test), `${test} must be direct`);
  assert.ok(protectedTiers.has('direct'));
  // The test named for the module ranks first.
  assert.equal(direct[0], at('tests', 'hosted-landing-cancel.test.mjs'));
  t.diagnostic(
    `direct ${direct.length}; tiers ${plan.tiers.map(i => `${i.tier} ${i.tests.length}`).join(', ')}`,
  );
});

test('eb0491bb: direct importers of changed job modules run before any recent failure', t => {
  const paths = [
    at('convex', 'projectHostedComposeJobs.ts'),
    at('convex', 'projectHostedSaveJobs.ts'),
    at('convex', 'projectHostedSyncJobs.ts'),
    at('convex', 'projectHostedFinishDriver.ts'),
  ];
  // The clone-local record of tests that failed in landing checks on 2026-11-07, as that builder saw it.
  const recent = [
    at('tests', 'exchange-request.test.mjs'),
    at('tests', 'hosted-actions-direct.test.mjs'),
    at('tests', 'hosted-agent-cache.test.mjs'),
    at('tests', 'hosted-agent-help.test.mjs'),
    at('tests', 'hosted-landing-cohort-isolation.test.mjs'),
    at('tests', 'hosted-landing.test.mjs'),
    at('tests', 'hosted-precompose-ownership.test.mjs'),
    at('tests', 'hosted-save-sync-efficiency.test.mjs'),
    at('tests', 'metrics-deadline.test.mjs'),
    at('tests', 'native-web-typecheck.test.mjs'),
    at('tests', 'parallel-work-defaults.test.mjs'),
    at('tests', 'public-identity-guard.test.mjs'),
    at('tests', 'recovery-runner.test.mjs'),
    at('tests', 'source-worker-diagnostics.test.mjs'),
  ];
  const plan = select(paths, { recent });
  // Tests that import a changed module themselves, the consumers that builder ran by hand.
  const importers = [
    at('tests', 'hosted-compose.test.mjs'),
    at('tests', 'hosted-saves.test.mjs'),
    at('tests', 'hosted-finish.test.mjs'),
    at('tests', 'hosted-landing-compose-watchdog.test.mjs'),
  ];
  const order = new Map(plan.tests.map((test, i) => [test, i]));
  const recentTier = tier(plan, 'recent');
  for (const test of importers) {
    assert.deepEqual(plan.ranks[test], [0, 1, 0], `${test} imports a changed module`);
    for (const late of recentTier) assert.ok(order.get(test) < order.get(late), `${test} after ${late}`);
  }
  // A recent failure joins only when it runs a changed module within two modules: these reach the
  // job modules only through a computed path, a by-name closure or the backend's shared wrapper.
  for (const test of [
    at('tests', 'public-identity-guard.test.mjs'),
    at('tests', 'parallel-work-defaults.test.mjs'),
    at('tests', 'exchange-request.test.mjs'),
    at('tests', 'native-web-typecheck.test.mjs'),
    at('tests', 'hosted-actions-direct.test.mjs'),
  ])
    assert.ok(!recentTier.includes(test), `${test} is not near this change`);
  // Within the default budget no recent file and no farther consumer displaces an importer. These
  // job modules are hubs (well over a hundred tests load them, all ranked [0, 1, 0]); equally close
  // tests order by relevance and a stable hash, never by file name, so the four importers fit
  // (17cce1b3: one new equally close test pushed the hosted saves test past the 45-file edge).
  // The plan's contract pins (cost, budget and registration guards a backend change reaches, at most
  // CONTRACT_PIN_SECONDS) are protected and counted inside the budget (Item 13ea93bf), so they take
  // places from the tail of the default budget. The three most specific importers keep theirs; the
  // fourth, the last file the 180 s budget reached before the pins, fits again once the budget covers
  // the pins' own seconds: the pins displace nothing else.
  const pinSeconds = plan.pins.length * 4;
  assert.ok(pinSeconds <= CONTRACT_PIN_SECONDS);
  const fits = seconds =>
    new Set(fitPreflightBudget({ tiers: plan.tiers, budgetSeconds: seconds, secondsPerFile: 4 }).tests);
  for (const test of importers.slice(0, 3)) assert.ok(fits(180).has(test), `${test} fits the default budget`);
  for (const test of importers)
    assert.ok(fits(180 + pinSeconds).has(test), `${test} fits the default budget plus the pins`);
  const fit = { tests: [...fits(180)] };
  for (const test of recentTier) assert.ok(!fit.tests.includes(test), `${test} displaced an importer`);
  t.diagnostic(`recent ${recentTier.join(' ') || 'none'}; local ${fit.tests.length}`);
});

test('e5e6fca8: the four files a wide source change broke are selected and protected', t => {
  // The Lane head whose landing check failed (State 6a607387): 39 changed paths across the source
  // publish path. Preflight passed after 74 files; the check then failed these four.
  const paths = [
    ...[
      'projectConvexSource.ts',
      'projectConvexSourceNode.ts',
      'projectConvexSourceStore.ts',
      'projectConvexSourceTransport.ts',
      'projectHostedComposeJobs.ts',
      'projectHostedComposePublish.ts',
      'projectHostedResolveChain.ts',
      'projectHostedResolveChainStore.ts',
      'projectHostedSaveJobs.ts',
      'projectHostedSavePublish.ts',
      'projectHostedSaveStore.ts',
      'projectHostedSaves.ts',
      'projectHostedSync.ts',
      'projectHostedSyncJobs.ts',
      'projectHostedSyncPublish.ts',
      'projectObjectCommit.ts',
      'projectObjects.ts',
      'projectSourceBeginReads.ts',
      'projectSourcePublishInline.ts',
      'projectSourceRun.ts',
      'projectSourceStepFields.ts',
    ].map(name => at('convex', name)),
    ...['architecture.md'].map(name => at('docs', name)),
    ...[
      'exchange-client.ts',
      'exchange-upload.ts',
      'hosted-agent-resolution.ts',
      'hosted-agent-source-wait.ts',
      'hosted-agent-source.ts',
      'hosted-agent-transport.ts',
      'hosted-contract-features.ts',
      'hosted-save-client.ts',
      'hosted-source-small-save.ts',
    ].map(name => at('src', name)),
    ...[
      'convex-source-inline-step.test.mjs',
      'convex-source-provider.test.mjs',
      'hosted-finish-fixture.mjs',
      'hosted-finish.test.mjs',
      'hosted-resolve-chain.test.mjs',
      'hosted-save-sync-efficiency.test.mjs',
      'hosted-source-efficiency-fixture.mjs',
      'hosted-source-small-save.test.mjs',
      'hosted-source-submit-run.test.mjs',
    ].map(name => at('tests', name)),
  ];
  const plan = select(paths);
  const failed = [
    at('tests', 'landing-failure-injection.test.mjs'),
    at('tests', 'hosted-landing-batches.test.mjs'),
    at('tests', 'convex-source-ancestry-scale.test.mjs'),
    at('tests', 'convex-source-dbio-budget.test.mjs'),
  ];
  const direct = tier(plan, 'direct');
  for (const test of failed) assert.ok(direct.includes(test), `${test} runs a changed module: direct`);
  assert.ok(protectedTiers.has('direct'));
  // So wide a change protects far more than the local budget: the plan says so instead of trimming.
  const fit = fitPreflightBudget({ tiers: plan.tiers, budgetSeconds: 180, secondsPerFile: 4 });
  assert.equal(fit.protectedOverBudget, true);
  for (const test of failed) assert.ok(fit.tests.includes(test), `${test} is never trimmed`);
  // The run's 180 s wall clock at 4 s per file starts the first 45 planned files and stops the rest.
  // Those stopped must-run files make the run NOT COMPLETE, never a pass (ec7960f9).
  const kept = new Set(fit.tests);
  const tierTests = Object.fromEntries(
    plan.tiers.map(item => [item.tier, item.tests.filter(x => kept.has(x))]),
  );
  const notRun = fit.tests.slice(180 / 4);
  const missed = mustRunNotRun(tierTests, notRun);
  for (const test of failed) assert.ok(missed.includes(test), `${test} is counted as must-run, not run`);
  const incomplete = incompletePreflight({
    root: '/lane',
    laneId: 'L',
    tierTests,
    notRun,
    secondsPerFile: 4,
  });
  assert.equal(incomplete.mustRun, missed.length);
  // Finishing them takes longer than one 540 s agent wait, so no finish is offered: landing runs them.
  assert.ok(notRun.length * 4 > 540);
  assert.equal(incomplete.finish, undefined);
  // Within the wait, the finish runs exactly the stopped files with no time cap.
  assert.equal(
    incompletePreflight({
      root: '/lane',
      laneId: 'L',
      tierTests,
      notRun,
      secondsPerFile: 4,
      waitSeconds: notRun.length * 4,
    }).finish,
    `nforge agent '/lane' preflight '{"laneId":"L","retry":true,"trim":false}'`,
  );
  assert.equal(preflightVerdict({ passed: false, incomplete }), 'NOT COMPLETE');
  // When the protected tier fits, nothing changes: no must-run file was stopped.
  assert.equal(
    incompletePreflight({ root: '/lane', laneId: 'L', tierTests, notRun: [], secondsPerFile: 4 }),
    undefined,
  );
  t.diagnostic(
    `direct ${direct.length}; ${failed.map(test => direct.indexOf(test)).join(' ')}; must-run not run ${missed.length}`,
  );
});

test('de6620eb: a new literal in a scanned source file selects the repo-wide guard', () => {
  // Lane d5576468 added a literal to one product module; only the landing check ran the rules guard
  // that scans every product file.
  const guard = at('tests', 'forge-only-rules.test.mjs');
  const changed = at('src', 'dependency-link.ts');
  const plan = select([changed]);
  assert.ok(tier(plan, 'mandatory').includes(guard), 'the guard scans the changed folder');
  assert.deepEqual(selectTests({ files, paths: [changed] }).reasons[guard], {
    kind: 'explicit',
    changedPath: changed,
    detail: `Scans src/, which holds changed ${changed}`,
  });
});

test('425ecd74: a data fixture, its test and a doc retain byte and folder readers plus mandatory checks', t => {
  const paths = [
    at('docs', 'agents', 'regression-ladder.md'),
    at('tests', 'fixtures', 'incident-replays.json'),
    at('tests', 'incident-replays.test.mjs'),
  ];
  const plan = select(paths);
  const readers = [...files]
    .filter(
      ([path, text]) =>
        /^tests\/[^/]+\.test\.mjs$/.test(path) && text.includes(at('fixtures', 'incident-replays.json')),
    )
    .map(([path]) => path);
  assert.deepEqual(readers, [at('tests', 'incident-replays.test.mjs')]);
  // Repo-wide guards that scan the docs or tests folder read these files too (Issue ec7960f9).
  const scanners = [...scanReaders(files, paths).keys()];
  // A bare readdirSync('tests') observes the JSON folder too, even when the
  // returned names are filtered to test files. Retain that conservative reader.
  const directoryReaders = [at('tests', 'public-verify.test.mjs')];
  // Test code that runs a tooling walk of tests/ (sourceFiles(), Item 196d5e4e) reads them as bytes.
  const { reasons } = selectTests({ files, paths });
  const walkReaders = plan.tests.filter(
    test => reasons[test]?.detail === recursiveFolderReader && paths.includes(reasons[test].changedPath),
  );
  assert.ok(walkReaders.includes(at('tests', 'hosted-scoped-recheck.test.mjs')), 'a sourceFiles() reader');
  assert.deepEqual(
    [...plan.tests].sort(),
    [...new Set([...readers, ...smokeTests, ...scanners, ...directoryReaders, ...walkReaders])].sort(),
    'local tiers hold the fixture reader, folder readers and fixed smoke set only',
  );
  t.diagnostic(`local ${plan.tests.length}, deferred to pre-queue ${plan.deferredTests.length}`);
});

test('0f3d44e1: a docs-only change runs only the tests that read those documents, with no graph', t => {
  // The lead's change (receipt 0f3d44e1) that ran 315 files locally while its landing check ran none.
  const docs = [
    at('docs', 'agents', 'brief-template.md'),
    at('docs', 'agents', 'briefings.md'),
    at('docs', 'agents', 'lead.md'),
  ];
  const cache = {};
  const started = performance.now();
  const plan = selectPreflightTests({ files, paths: docs, hubBudget }, cache);
  const ms = performance.now() - started;
  assert.equal(plan.scope, 'docs');
  assert.equal(cache.graph, undefined, 'a docs-only change parses no import graph');
  assert.deepEqual(plan.deferredTests, []);
  assert.deepEqual(
    selectTests({ files, paths: docs }, cache).tests,
    [],
    'the landing docs scope is unchanged',
  );
  // The tests that read these documents (directly, or through a script that lists them), and only those.
  for (const test of [at('tests', 'check-brief.test.mjs'), at('tests', 'planning-search.test.mjs')])
    assert.ok(plan.tests.includes(test), `${test} reads a changed document`);
  for (const test of plan.tests) assert.ok(docs.includes(plan.docsReaders[test].doc), test);
  // The retired-wording guard walks docs/agents/ by relative path (preflight-miss fix 4, d3357f40): a
  // reader of every document there. The bound on the other readers stays.
  // The teaching guard (6b7d5a79) walks docs/agents/ the same way, for removed rules and deprecated verbs.
  const walkers = [
    at('tests', 'approve-land-wording.test.mjs'),
    at('tests', 'agent-teaching-guard.test.mjs'),
  ];
  for (const walker of walkers) assert.ok(plan.tests.includes(walker), `${walker} walks docs/agents/`);
  const others = plan.tests.filter(test => !walkers.includes(test));
  assert.ok(others.length <= 6, `${others.length} readers`);
  assert.deepEqual(plan.tiers, [{ tier: 'mandatory', tests: plan.tests }]);
  t.diagnostic(`readers ${plan.tests.join(' ')}; selection ${ms.toFixed(0)} ms`);
});

test('a code change beside those documents still selects its real tests', () => {
  const script = at('scripts', 'check-brief.mjs');
  const doc = at('docs', 'agents', 'briefings.md');
  const near = select([script]);
  assert.ok(tier(near, 'direct').includes(at('tests', 'check-brief.test.mjs')));
  // With the document in the same change, its readers are mandatory beside the script's consumers.
  const both = select([script, doc]);
  const mandatory = tier(both, 'mandatory');
  for (const test of [at('tests', 'check-brief.test.mjs'), at('tests', 'planning-search.test.mjs')])
    assert.ok(mandatory.includes(test), `${test} must be mandatory`);
});

test('SM-C M4: an environment receipt reads ENVIRONMENT, never FAILED; the gate and the summary share one outcome', async () => {
  const { preflightOutcome } = await import('../dist/agent-preflight-incomplete.js');
  const environment = { kind: 'program-missing', units: ['x'] };
  const incomplete = { mustRun: 1, finish: 'f', estimateMinutes: 1 };
  const rows = [
    [{ passed: true }, 'passed', 'passed'],
    [{ passed: false, incomplete }, 'incomplete', 'NOT COMPLETE'],
    [{ passed: false, environment }, 'environment', 'ENVIRONMENT (not a failed run)'],
    [{ passed: false, environment, incomplete }, 'environment', 'ENVIRONMENT (not a failed run)'],
    [{ passed: false }, 'failed', 'FAILED'],
  ];
  for (const [receipt, outcome, word] of rows) {
    assert.equal(preflightOutcome(receipt), outcome);
    assert.equal(preflightVerdict(receipt), word);
  }
});

test('3a733ee8 (Lane e2572586): a landing-transaction change runs the exact-I/O pins first and the budget never stops them', t => {
  // The Lane's changed product paths at head 9a685268 (added files are not in this inventory).
  const paths = [
    ...[
      'Acceptance',
      'AcceptanceCompletion',
      'AcceptanceFields',
      'AcceptancePublish',
      'LandingBatchPublish',
      'ResolutionOrigin',
      'RevertNotice',
    ].map(name => at('convex', `projectHosted${name}.ts`)),
    at('convex', 'projectPurgeInventory.ts'),
    at('convex', 'projectWorkIndex.ts'),
    at('convex', 'schema.ts'),
    at('src', 'hosted-agent-planning.ts'),
    at('src', 'member-data-notice.ts'),
    at('src', 'speed-budgets.json'),
  ];
  // The files that pin landing calls, reads and writes; the landing check failed on the second.
  const pins = [
    'landing-cost-guard',
    'hosted-early-resolution-speed',
    'hosted-landing-admission-default',
  ].map(name => at('tests', `${name}.test.mjs`));
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const guardTests = selectGuards(
    preflightGuards(packageJson, path => files.has(path)),
    paths,
  ).selected.flatMap(guard => guard.tests);
  for (const pin of pins) assert.ok(guardTests.includes(pin), `${pin} is a guard this change triggers`);
  const plan = select(paths, { guards: guardTests });
  const queue = preflight.guardsFirst(plan.tiers, guardTests).flatMap(item => item.tests);
  // The incident run: the 180 s wall clock was spent after 39 files had started.
  const started = queue.slice(0, 39);
  const spent = preflight.budgetSpent(queue.slice(39), new Set(guardTests));
  for (const pin of pins)
    assert.ok(started.includes(pin) || spent.start.includes(pin), `${pin} was stopped for time`);
  assert.ok(!spent.stopped.some(test => guardTests.includes(test)), 'no guard is stopped for time');
  const unique = [...new Set(guardTests)];
  assert.deepEqual(queue.slice(0, unique.length).sort(), unique.sort(), 'guards run first');
  t.diagnostic(`guards ${guardTests.length}; queue ${queue.length}; stopped ${spent.stopped.length}`);
});

test('b1e96c63: every landing replay test with an I/O step history is a landing-transaction guard', () => {
  // A test that drives a landing fixture and records its read/write/call ceiling as a step history
  // ("Reads 1352 -> 1354 (750c5929): ...") fails on the next +1 per landing. It must run first in
  // preflight for any landing-transaction change, never after the wall clock stops it.
  const fixture = new RegExp(
    `from '\\./(?:hosted-landing[\\w-]*fixture|hosted-acceptance-fixture|hosted-finish-fixture|hosted-race-fixture|early-resolution-replay|landing-admission-replay)\\.mjs'`,
  );
  const history = /\b(?:[Rr]eads|[Ww]rites|[Cc]alls) \d+ -> \d+/;
  const pins = [...files]
    .filter(
      ([path, text]) => /^tests\/[^/]+\.test\.mjs$/.test(path) && fixture.test(text) && history.test(text),
    )
    .map(([path]) => path);
  assert.ok(pins.length >= 3, `found ${pins.length} landing step-history tests`);
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const guardTests = selectGuards(
    preflightGuards(packageJson, path => files.has(path)),
    [at('convex', 'projectHostedAcceptanceCompletion.ts')],
  ).selected.flatMap(guard => guard.tests);
  for (const pin of pins) assert.ok(guardTests.includes(pin), `${pin} pins landing I/O but is not a guard`);
});

test('abfc9b96: a hosted agent schema change runs its generated-docs guard first', () => {
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const guardTests = selectGuards(
    preflightGuards(packageJson, path => files.has(path)),
    [at('src', 'hosted-agent-contract.ts')],
  ).selected.flatMap(guard => guard.tests);
  // The help table in the agent workflow doc is generated from these schemas; the landing check
  // failed on it after preflight stopped at 48 of 560 files.
  assert.ok(guardTests.includes(at('tests', 'hosted-agent-help.test.mjs')));
});

// Item 13ea93bf friction triage (2026-11-22) and the lead's 2026-11-23 cost-pin line: each preflight miss the
// landing check later caught is selected, and a backend change starts its cost and registration pins inside
// land's 90 s quick run. These live here, not in a file of their own: this file already reads the whole tree,
// and one more recursive reader of it would be one more loader of every module (the 8809fba5 budget edge).
const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
const tests = (...names) => names.map(name => at('tests', `${name}.test.mjs`));
const guards = paths =>
  selectGuards(
    preflightGuards(packageJson, path => files.has(path)),
    paths,
  ).selected.flatMap(guard => guard.tests);
// Land's quick run budget: 90 s, at 4 s a file.
const budget = { seconds: 90, secondsFor: () => 4 };

/** The pure run order land's quick run uses, at 4 s a file unless `measured` says otherwise. */
function quickQueue(plan, paths, measured = {}) {
  const guardTests = guards(paths);
  return protectedRunOrder({
    tiers: plan.tiers,
    isProtected: name => protectedTiers.has(name),
    guards: new Set(guardTests),
    treeGuards: plan.treeGuards ?? [],
    leadTests: plan.leadTests ?? [],
    ownTests: [],
    specificModules: plan.specificModules ?? [],
    pins: plan.pins,
    firstPins: plan.pinsFirst,
    budgetSeconds: 90,
    measuredSeconds: test => measured[test],
    secondsFor: test => measured[test] ?? 4,
    failureSeconds: () => 0,
  });
}
const startsAt = (queue, test, measured = {}) =>
  queue.slice(0, queue.indexOf(test)).reduce((sum, name) => sum + (measured[name] ?? 4), 0);

test('baaec084 (receipt 4f687721): the read reduction in convex/ starts its cost and inventory pins inside 90 s', () => {
  // Lane 01cd81c8 changed these two backend modules; three exact cost pins failed only in the queue check.
  const paths = [at('convex', 'projectConvexSourceObjects.ts'), at('convex', 'projectPlanningList.ts')];
  const plan = selectPreflightTests({ files, paths, guards: guards(paths), hubBudget: budget }, {});
  assert.ok(plan.pins.length >= 3, `pins ${plan.pins.length}`);
  assert.ok(plan.pins.length * 4 <= CONTRACT_PIN_SECONDS, 'pins stay inside their allowance');
  const mandatory = tier(plan, 'mandatory');
  for (const pin of plan.pins) {
    assert.ok(contractGuardTest(pin), `${pin} is named for a guard`);
    assert.ok(mandatory.includes(pin), `${pin} is protected, so the plan never trims it`);
  }
  // Registration and inventory pins first, then the cost pins the changed modules are about.
  assert.match(plan.pins[0], /inventory|registration/);
  assert.ok(
    plan.pins.some(pin => /source-(?:point-query|generation)|dbio/.test(pin)),
    'a source read pin',
  );
  const queue = quickQueue(plan, paths);
  for (const pin of plan.pins) assert.ok(startsAt(queue, pin) < 90, `${pin} starts after 90 s`);
});

test('60d68b5f (Lane ef5d2a08): a schema change starts the registration and inventory guards first, even behind slow guards', () => {
  const paths = [at('convex', 'schema.ts')];
  const plan = selectPreflightTests({ files, paths, guards: guards(paths), hubBudget: budget }, {});
  const registrations = at('tests', 'table-registrations.test.mjs');
  const inventory = at('tests', 'project-purge-inventory.test.mjs');
  for (const pin of [registrations, inventory]) {
    assert.ok(plan.pins.includes(pin), `${pin} is a pin`);
    assert.ok(tier(plan, 'mandatory').includes(pin), `${pin} is protected`);
  }
  assert.ok(plan.pins.indexOf(registrations) < 2 && plan.pins.indexOf(inventory) < 2, 'registrations lead');
  // The landing-I/O guards this schema change triggers take ~30 s each here; the cheap pins, timed
  // fast, start before every one of them.
  const measured = { [registrations]: 2.2, [inventory]: 5.5 };
  for (const guard of guards(paths)) measured[guard] ??= 30;
  // A fresh clone has timed nothing: the registration and inventory pins still start before the guards.
  const fresh = quickQueue(plan, paths);
  assert.ok(startsAt(fresh, registrations) <= 8 && startsAt(fresh, inventory) <= 8, 'untimed, they lead');
  const queue = quickQueue(plan, paths, measured);
  assert.ok(startsAt(queue, registrations, measured) <= 10, 'registrations start within 10 s');
  assert.ok(startsAt(queue, inventory, measured) <= 10, 'inventory starts within 10 s');
});

test('42e2a995: the tool-list contract test runs first when a contract schema changes', () => {
  const toolList = at('tests', 'mcp-tool-list.test.mjs');
  assert.ok(contractGuardTest(toolList));
  const paths = [at('src', 'hosted-agent-contract.ts')];
  const plan = selectPreflightTests({ files, paths, guards: guards(paths), hubBudget: budget }, {});
  assert.ok(tier(plan, 'mandatory').includes(toolList), 'mcp-tool-list is protected for a contract change');
});

test('8cf45311: a source-text guard that reads a changed file is must-run (the detached:true literal)', () => {
  const plan = selectPreflightTests({
    files,
    paths: [at('src', 'agent-preflight-capture.ts')],
    hubBudget: budget,
  });
  assert.ok(tier(plan, 'mandatory').includes(at('tests', 'no-resident-process.test.mjs')));
});

test('10d969ca: a test that hard-codes an id format the change removed is direct, however far it sits', () => {
  const before = 'export const timelineId = id => `accepted:${id}`;\nexport const other = 1;\n';
  const after = 'export const timelineId = id => `landed:${id}`;\nexport const other = 1;\n';
  const gone = removedNames(at('src', 'timeline.ts'), before, after);
  assert.deepEqual(gone, ['accepted:']);
  const inventory = new Map([
    [at('src', 'timeline.ts'), after],
    [at('tests', 'stale-id.test.mjs'), "import '../dist/timeline.js';\nassert.equal(x, 'accepted:abc');\n"],
    ...['a', 'b', 'c'].map(name => [
      at('tests', `consumer-${name}.test.mjs`),
      "import '../dist/timeline.js';\nassert.ok(true);\n",
    ]),
    ['package.json', '{}'],
    ['package-lock.json', '{}'],
  ]);
  // A one-file budget makes the module a hub: its consumers are ranked, not protected.
  const input = {
    files: inventory,
    paths: [at('src', 'timeline.ts')],
    hubBudget: { seconds: 4, secondsFor: () => 4 },
  };
  const control = selectPreflightTests(input, {});
  assert.ok(!tier(control, 'direct').includes(at('tests', 'stale-id.test.mjs')), 'control: not protected');
  const plan = selectPreflightTests({ ...input, removedNames: gone }, {});
  assert.ok(tier(plan, 'direct').includes(at('tests', 'stale-id.test.mjs')));
  for (const name of ['a', 'b', 'c'])
    assert.ok(!tier(plan, 'direct').includes(at('tests', `consumer-${name}.test.mjs`)));
  assert.equal(plan.specificModules[0].tests[0], at('tests', 'stale-id.test.mjs'), 'it runs first');
});

test('5b30f265: a test that imports a changed export by name is direct, one that imports another export is not', () => {
  const before = 'export function notice(a) { return a; }\nexport function steady() { return 1; }\n';
  const after = 'export function notice(a, b) { return [a, b]; }\nexport function steady() { return 1; }\n';
  const path = at('src', 'canary.ts');
  const altered = changedExports(path, before, after);
  assert.deepEqual(altered, ['notice']);
  const inventory = new Map([
    [path, after],
    [at('tests', 'trust.test.mjs'), "import { notice as n } from '../dist/canary.js';\nn(1);\n"],
    [at('tests', 'steady.test.mjs'), "import { steady } from '../dist/canary.js';\nsteady();\n"],
    [at('tests', 'other.test.mjs'), "import { steady } from '../dist/canary.js';\nsteady();\n"],
    ['package.json', '{}'],
    ['package-lock.json', '{}'],
  ]);
  // A default import may come first; a module of the same file name elsewhere is not the changed one.
  inventory.set(
    at('tests', 'default.test.mjs'),
    "import c, { notice } from '../dist/canary.js';\nc(notice);\n",
  );
  inventory.set(
    at('tests', 'elsewhere.test.mjs'),
    "import { notice } from './fixtures/canary.js';\nnotice();\n",
  );
  const plan = selectPreflightTests(
    {
      files: inventory,
      paths: [path],
      changedExports: new Map([[path, altered]]),
      hubBudget: { seconds: 4, secondsFor: () => 4 },
    },
    {},
  );
  assert.ok(tier(plan, 'direct').includes(at('tests', 'trust.test.mjs')));
  assert.ok(!tier(plan, 'direct').includes(at('tests', 'steady.test.mjs')));
  assert.ok(tier(plan, 'direct').includes(at('tests', 'default.test.mjs')));
  assert.ok(!tier(plan, 'direct').includes(at('tests', 'elsewhere.test.mjs')));
});

test('ca035ee5: a field in any schema the generated command table renders runs its generated-doc guards', () => {
  const guardTests = guards([at('src', 'hosted-agent-reads.ts')]);
  for (const test of tests('hosted-agent-help', 'hosted-response-contract', 'table-registrations'))
    assert.ok(guardTests.includes(test), `${test} is a guard of a schema change`);
  // Every schema file the contract, the reads and the help module import directly is covered.
  const schemaFiles = new Set();
  for (const entry of ['hosted-agent-help', 'hosted-agent-contract', 'hosted-agent-reads']) {
    schemaFiles.add(at('src', `${entry}.ts`));
    const text = files.get(at('src', `${entry}.ts`));
    for (const match of text.matchAll(/from '\.\/([\w-]+)\.js'/g)) {
      const path = at('src', `${match[1]}.ts`);
      if (/z\.(?:object|strictObject)\(/.test(files.get(path) ?? '')) schemaFiles.add(path);
    }
  }
  for (const path of schemaFiles)
    assert.ok(
      guards([path]).includes(at('tests', 'hosted-agent-help.test.mjs')),
      `${path} defines a schema the help table renders but triggers no generated-doc guard`,
    );
});

test('daedb321 and 57ab011b: a new module runs the package ceilings (the cheap check the lead chose over full smoke, 11-20), a Convex-reached module the runtime-import check', () => {
  const checks = staticChecks(packageJson);
  const ceilings = checks.find(check => check.command.includes('scripts/package-ceilings.mjs'));
  assert.deepEqual(selectStaticChecks([ceilings], [at('src', 'a-new-module.ts')]).selected, [ceilings]);
  const runtime = checks.find(check => check.name === 'convex runtime imports');
  assert.deepEqual(selectStaticChecks([runtime], [at('src', 'hosted-main.ts')]).selected, [runtime]);
  assert.ok(guards([at('src', 'hosted-main.ts')]).includes(at('tests', 'convex-runtime-imports.test.mjs')));
});

test('df1eca81: a data file under src stays scoped when only prose, manifests, ledgers and type includes name it', () => {
  const real = selectTests({ files, paths: [at('src', 'speed-budgets.json')] });
  assert.equal(real.scope, 'scoped');
  const data = at('src', 'new-limits.json');
  const base = new Map([
    ...files,
    [data, '{}'],
    [at('src', 'new-limits.ts'), "import limits from './new-limits.json';\nexport default limits;\n"],
    [at('tests', 'new-limits.test.mjs'), "import '../dist/new-limits.js';\n"],
    [at('tests', 'new-limits-baseline.json'), '{"files":["dist/new-limits.json"]}'],
    [at('scripts', 'package-documents', 'new-limits.json'), '{"path":"docs/new-limits.md"}'],
  ]);
  assert.equal(selectTests({ files: base, paths: [data] }).scope, 'scoped');
  // A shell script or workflow naming it may read it: the data file stays unobserved.
  const read = new Map([...base, ['scripts/run.sh', 'cat src/new-limits.json']]);
  assert.equal(selectTests({ files: read, paths: [data] }).scope, 'full');
  const shipped = { ...JSON.parse(files.get('package.json')), files: ['src/new-limits.json'] };
  // A fixture a test reads may hand the path to code: the readers of that fixture become readers of the
  // data file (never dropped), and a fixture nobody reads is inert.
  const fixture = new Map([
    ...base,
    [at('tests', 'cases.json'), '{"input":"src/new-limits.json"}'],
    [at('tests', 'cli-case.test.mjs'), "import '../dist/cli.js';\nreadFileSync('tests/cases.json');\n"],
  ]);
  const viaFixture = selectTests({ files: fixture, paths: [data] });
  assert.ok(viaFixture.tests.includes(at('tests', 'cli-case.test.mjs')), 'the fixture reader runs');
  const manifest = new Map([...base, ['package.json', JSON.stringify(shipped)]]);
  assert.equal(selectTests({ files: manifest, paths: [data] }).scope, 'full');
});

test('bf230974: a new docs page and its package-documents manifest stay scoped', () => {
  const inventory = new Map([
    ...files,
    [at('scripts', 'package-documents', 'phase7-plan.json'), '{"path":"docs/phase7-plan.md"}'],
  ]);
  const selection = selectTests({
    files: inventory,
    paths: [at('docs', 'phase7-plan.md'), at('scripts', 'package-documents', 'phase7-plan.json')],
  });
  assert.equal(selection.scope, 'scoped');
  assert.ok(selection.tests.length < files.size / 3, `selected ${selection.tests.length}`);
});
