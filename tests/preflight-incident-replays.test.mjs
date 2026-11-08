// SPDX-License-Identifier: Apache-2.0
// Incident replays on the real Forge inventory (Issue c14f4065): each case is a preflight that let a
// landing check fail or ran far more than the change needed. Selection only (a local graph read).
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
  // job modules are hubs (well over a hundred tests load them, all ranked [0, 1, 0]), so which of
  // the equally close loaders fit is a name order, not this incident: an importer left out may only
  // be cut behind tests ranked as close as it is (17cce1b3: one new equally close test pushed
  // the hosted saves test past the 45-file edge).
  const fit = fitPreflightBudget({ tiers: plan.tiers, budgetSeconds: 180, secondsPerFile: 4 });
  const local = new Set(fit.tests);
  const closer = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
    return true;
  };
  for (const test of importers)
    if (!local.has(test))
      for (const kept of fit.tests.filter(item => plan.ranks[item]))
        assert.ok(
          closer(plan.ranks[kept], plan.ranks[test]) && !recentTier.includes(kept),
          `${kept} displaced ${test}`,
        );
  for (const test of recentTier) assert.ok(!fit.tests.includes(test), `${test} displaced an importer`);
  t.diagnostic(`recent ${recentTier.join(' ') || 'none'}; local ${fit.tests.length}`);
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
  assert.deepEqual(
    [...plan.tests].sort(),
    [...new Set([...readers, ...smokeTests])].sort(),
    'local tiers hold the fixture reader and the fixed smoke set only',
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
