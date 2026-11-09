// SPDX-License-Identifier: Apache-2.0
// Incident replays on the real Forge inventory (Issue c14f4065): each case is a preflight that let a
// landing check fail or ran far more than the change needed. Selection only (a local graph read), plus
// the pure run verdict where a case needs it.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fitPreflightBudget,
  protectedTiers,
  selectPreflightTests,
  selectTests,
  smokeTests,
  sourceFiles,
} from '../scripts/test-impact.mjs';
import { scanReaders } from '../scripts/test-tree-scanners.mjs';
import { incompletePreflight, mustRunNotRun, preflightVerdict } from '../dist/agent-preflight-incomplete.js';

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
  const fit = fitPreflightBudget({ tiers: plan.tiers, budgetSeconds: 180, secondsPerFile: 4 });
  const local = new Set(fit.tests);
  for (const test of importers) assert.ok(local.has(test), `${test} fits the default budget`);
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
  assert.equal(
    incomplete.finish,
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

test('425ecd74: a data fixture, its test and a doc select only that test and mandatory checks', t => {
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
  assert.deepEqual(
    [...plan.tests].sort(),
    [...new Set([...readers, ...smokeTests, ...scanners])].sort(),
    'local tiers hold the fixture reader, the folder scanners and the fixed smoke set only',
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
  assert.ok(plan.tests.length <= 6, `${plan.tests.length} readers`);
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
