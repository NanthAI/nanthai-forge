// SPDX-License-Identifier: Apache-2.0
// Guard 4 (Item 6abdde40, incident 5e3c3a3c): the 2026-11-17 wake cut claimed only to save cost and
// cost hours of landing time. The landing check classifies queue, admission, acceptance, check and
// wake paths as core by path alone, and every check of such a change runs the queue simulation and
// the registered incident replays: scoped, preflight and re-check (interaction) selections alike.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { REGISTRY, coreQueuePath, coreQueueTests } from '../scripts/core-queue-paths.mjs';
import { interactionSelection, selectPreflightTests, selectTests } from '../scripts/test-impact.mjs';

const registry = JSON.stringify({
  schema: 1,
  replays: [
    { incident: 'x', file: 'tests/stall-replay.test.mjs', test: 'x' },
    { incident: 'y', file: 'tests/missing.test.mjs', test: 'y' },
  ],
});
const files = new Map(
  Object.entries({
    'convex/projectHostedFinishWake.ts': 'export const wake = 1; // cost: skip one wake',
    'convex/projectProfile.ts': 'export const profile = 1;',
    'src/landing-overtake.ts': 'export const overtake = 1;',
    'src/landing-capsule.ts': 'export const capsule = 1;',
    [REGISTRY]: registry,
    'tests/wake.test.mjs': "await import(moduleUrl('../convex/projectHostedFinishWake.ts'))",
    'tests/profile.test.mjs': "await import(moduleUrl('../convex/projectProfile.ts'))",
    'tests/core-queue-paths.test.mjs': '',
    'tests/hosted-landing-queue-sim.test.mjs': '',
    'tests/incident-replays.test.mjs': '',
    'tests/landing-cost-guard.test.mjs': '',
    'tests/stall-replay.test.mjs': '',
    'tests/unrelated.test.mjs': '',
    'tests/files.test.mjs': '',
    'tests/ci-scope.test.mjs': '',
    'tests/test-impact.test.mjs': '',
    'tests/check-path-scopes.test.mjs': '',
  }),
);
const GUARD = [
  'tests/core-queue-paths.test.mjs',
  'tests/hosted-landing-queue-sim.test.mjs',
  'tests/incident-replays.test.mjs',
  'tests/landing-cost-guard.test.mjs',
  'tests/stall-replay.test.mjs',
];

test('core queue paths are classified by path: queue, finish, acceptance and landing modules, not capsule storage', () => {
  for (const path of [
    'convex/projectHostedFinishWake.ts',
    'convex/projectHostedLandingStore.ts',
    'convex/projectHostedAcceptancePublish.ts',
    'convex/projectHostedQueueAhead.ts',
    'convex/projectHostedCheckDispatch.ts',
    'src/landing-overtake.ts',
    'src/hosted-landing-admission.ts',
    // The source step repair wake (e62d834b, review 308f217c).
    'convex/projectConvexSourceLease.ts',
    'convex/projectConvexSourceActive.ts',
    'convex/projectSourceJobs.ts',
  ])
    assert(coreQueuePath(path), path);
  for (const path of [
    'convex/projectProfile.ts',
    'src/landing-capsule.ts',
    'scripts/forge-check.mjs',
    'web/src/App.tsx',
  ])
    assert(!coreQueuePath(path), path);
  // The registry's files that exist in the Candidate, plus the fixed queue guards.
  assert.deepEqual(coreQueueTests(files), GUARD);
});

test('6abdde40: a cost-only change to a wake path runs the queue simulation and every incident replay in a scoped check', () => {
  const selection = selectTests({ files, paths: ['convex/projectHostedFinishWake.ts'] });
  assert.equal(selection.scope, 'scoped');
  for (const test of GUARD) {
    assert(selection.tests.includes(test), test);
    assert.equal(selection.reasons[test].kind, 'guard');
    assert.match(selection.reasons[test].detail, /Guard 4/);
  }
  assert(selection.tests.includes('tests/wake.test.mjs'), 'its importers still run');
  assert(!selection.tests.includes('tests/unrelated.test.mjs'));
  // A non-core change keeps its narrow selection.
  const other = selectTests({ files, paths: ['convex/projectProfile.ts'] });
  assert(!other.tests.includes('tests/hosted-landing-queue-sim.test.mjs'));
});

test('6abdde40: local preflight ranks the queue guards like any test; the pre-queue check runs what it leaves (eb0491bb)', () => {
  const selection = selectPreflightTests({ files, paths: ['src/landing-overtake.ts'] });
  const mandatory = selection.tiers.find(tier => tier.tier === 'mandatory').tests;
  for (const test of GUARD) {
    assert(!mandatory.includes(test), `${test} does not crowd out the changed module's own importers`);
    assert(
      selection.tests.includes(test) || selection.deferredTests.includes(test),
      `${test} runs here or in the pre-queue check`,
    );
  }
});

test("6abdde40: a re-check after main moved runs the queue guards only for the Lane's own core change", () => {
  const head = 'a'.repeat(40);
  const interaction = (lanePaths, mainPaths) => ({
    version: 1,
    reusedRunId: '11111111-1111-4111-8111-111111111111',
    mainRunId: '33333333-3333-4333-8333-333333333333',
    base: head,
    checkedHead: head,
    main: head,
    mergedHead: head,
    eligible: true,
    reason: 'clean merge',
    lanePaths,
    mainPaths,
    overlap: [],
  });
  const env = { FORGE_CHECK_SCOPED: '1' };
  const core = interactionSelection({
    files,
    paths: ['convex/projectHostedFinishWake.ts'],
    interaction: interaction(['convex/projectHostedFinishWake.ts'], ['convex/projectProfile.ts']),
    env,
  });
  assert.equal(core.scope, 'interaction');
  for (const test of GUARD) assert(core.tests.includes(test), test);
  // Main's core change ran the guard set in its own check: a plain Lane re-checked after it pays nothing extra.
  const mainSide = interactionSelection({
    files,
    paths: ['convex/projectProfile.ts'],
    interaction: interaction(['convex/projectProfile.ts'], ['convex/projectHostedFinishWake.ts']),
    env,
  });
  assert.equal(mainSide.scope, 'interaction');
  assert(!mainSide.tests.includes('tests/hosted-landing-queue-sim.test.mjs'));
  const plain = interactionSelection({
    files,
    paths: ['convex/projectProfile.ts'],
    interaction: interaction(['convex/projectProfile.ts'], ['src/landing-capsule.ts']),
    env,
  });
  assert(!plain.tests.includes('tests/hosted-landing-queue-sim.test.mjs'));
});

// Review afa5e865: the core list cannot drift. A queue-family module that core code or the queue
// simulation imports is core, or listed here with the reason its changes need no queue replay.
const NOT_CORE = {
  'convex/projectHostedAcceptedByNote.ts': 'board note to the Lane after a person accepted; after the commit',
  'convex/projectHostedApprovalStore.ts':
    'builder approval request rows; the owner grant that gates landing is core',
  'convex/projectHostedChannels.ts': 'Channel and seed lookups shared by every hosted write',
  'convex/projectHostedIntentCompletion.ts': 'Intent bookkeeping after a landing',
  'convex/projectHostedOperations.ts': 'receipt retention cleanup',
  'convex/projectHostedOutputApi.ts': 'verified transfer of check output bytes',
  'convex/projectHostedOverlapLanded.ts': 'overlap view of landed Lanes',
  'convex/projectHostedOverlapStore.ts': 'Lane overlap rows written at save',
  'convex/projectHostedProvenance.ts': 'source ownership evidence of composed inputs',
  'convex/projectHostedRecords.ts': 'immutable record integrity primitives shared by all hosted storage',
  'convex/projectHostedResolutionOrigin.ts': 'conflict resolution Lane lineage',
  'convex/projectHostedRevertNotice.ts': 'notice of a compensating landing',
  'convex/projectHostedSaveStore.ts': 'save rows; a save is not a queue step',
  'convex/projectHostedSecretAllow.ts': 'owner notice after a landing that added a secret allow',
  'convex/projectHostedStackNotice.ts': 'Lane notes about a stacked change',
  'convex/projectHostedTestTimings.ts': 'advisory test timing estimates',
  'convex/projectHostedTrust.ts': 'per-actor trust rows updated after landing',
  'convex/projectLandingCapsuleContext.ts': 'landing capsule archive, packed days after the commit',
  'convex/projectLandingCapsuleLedger.ts': 'landing capsule archive, packed days after the commit',
  'convex/projectLandingCapsuleStore.ts': 'landing capsule archive, packed days after the commit',
  'convex/projectLandingCapsuleWake.ts': 'landing capsule archive, packed days after the commit',
  'convex/projectLandingSpeed.ts': 'speed budget samples recorded after the commit',
  'src/hosted-check-summary.ts': 'read-only summary reply of a check run',
  'src/landing-accepted-by.ts': 'display of who accepted a landing',
  'src/landing-message.ts': 'landing commit message text',
};
const FAMILY = [
  /^convex\/(?:projectHosted|projectAcceptance|projectLanding|scheduler)[^/]*\.ts$/,
  /^src\/(?:hosted-(?:check|compose|cross|would|land|queue|batch|finish|acceptance)|scoped-|check-reuse|landing-|queue-|first-check)[^/]*\.ts$/,
];
// The queue simulation's entry points. The walk follows their imports through the simulation's own
// files and core modules, so it needs no folder listing.
const SIM = [
  'tests/hosted-landing-queue-sim.test.mjs',
  'tests/queue-sim/parked-mutant-runner.mjs',
  'tests/hosted-finish-fixture.mjs',
  'tests/hosted-landing-batches-fixture.mjs',
];

test('6abdde40: every queue-family module the queue simulation reaches through core code is core or a listed exception', () => {
  const root = new URL('../', import.meta.url);
  const exists = path => existsSync(new URL(path, root));
  const resolve = (from, spec) => {
    if (!spec.startsWith('.')) return null;
    const parts = from.split('/').slice(0, -1);
    for (const part of spec.split('/')) {
      if (part === '..') parts.pop();
      else if (part !== '.') parts.push(part);
    }
    const path = parts.join('/').replace(/^dist\//, 'src/');
    if (path.startsWith('tests/')) return /\.m?js$/.test(path) && exists(path) ? path : null;
    const ts = path.endsWith('.ts') ? path : `${path.replace(/\.js$/, '')}.ts`;
    return exists(ts) ? ts : null;
  };
  const seen = new Set();
  const queue = [...SIM];
  const missing = new Set();
  const reached = new Set();
  let core = 0;
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (coreQueuePath(file)) core++;
    const text = readFileSync(new URL(file, root), 'utf8');
    for (const [, spec] of text.matchAll(/(?:from\s+|import\(\s*|moduleUrl\(\s*)['"]([^'"]+)['"]/g)) {
      const target = resolve(file, spec);
      if (!target) continue;
      // The simulation's own files and core modules are walked on; other fixtures and non-core
      // modules are leaves.
      if (SIM.includes(target) || target.startsWith('tests/queue-sim/') || coreQueuePath(target))
        queue.push(target);
      else if (target.startsWith('tests/')) continue;
      else if (target in NOT_CORE) reached.add(target);
      else if (FAMILY.some(p => p.test(target))) missing.add(`${target} (imported by ${file})`);
    }
  }
  assert(core > 100, `the walk reaches the core queue code (${core} modules)`);
  assert.deepEqual([...missing].sort(), [], 'make it core in scripts/core-queue-paths.mjs or list why not');
  for (const path of Object.keys(NOT_CORE)) {
    assert(!coreQueuePath(path), `${path} is core now; drop its exception`);
    assert(reached.has(path), `no queue code imports ${path} now; drop its exception`);
  }
});
