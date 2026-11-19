// SPDX-License-Identifier: Apache-2.0
// Keep the run (Item fa2c1383): the pure main-move rule. Every cancel cause and every keep cause, in
// strict and fast, plus the guards the rule must hold: it keeps every run today keeps (except under a
// coverage mover, an intended tightening), it never claims a carry that the strict or fast proof path
// rule refuses, it keeps for a scoped recheck only where today's recheck can scope and it pays, and
// every keep that replaces a retire holds queue order.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codeOverlap,
  needsFastMain,
  scopedRecheckPays,
  sharedDocs,
  staleCheckDisposition,
} from '../dist/stale-check-keep.js';
import { firstCheckRiskPaths, globalRiskBetween, orderSensitiveRisk } from '../dist/first-check-risk.js';
import { placeableRisk } from '../dist/package-placement.js';
import { scopedRecheckSelection } from '../dist/scoped-recheck.js';
import { scopedRootConfig } from '../dist/scoped-root-config.js';
import { ECONOMICS, STANDARD_ENTRIES, keepInput, todayKeeps } from './keep-the-run-baseline.mjs';

const MODES = ['strict', 'fast'];
const decide = (mode, overrides = {}) =>
  staleCheckDisposition(
    keepInput({ ...overrides, acceptance: { landingMode: mode, ...overrides.acceptance } }),
  );
const expect = (mode, overrides, action, reason) => {
  const decided = decide(mode, overrides);
  assert.deepEqual(
    { action: decided.action, reason: decided.reason },
    { action, reason },
    JSON.stringify({ mode, overrides }),
  );
};

for (const mode of MODES) {
  test(`fa2c1383 ${mode}: an unrelated mover keeps the run whatever the policy, as today`, () => {
    for (const extra of [
      {},
      { acceptance: { mode: 'review' } },
      { reducedEvidence: false },
      { main: { status: 'red' } },
      { run: { gate: 'partial' } },
      { run: { direct: false } },
      { landing: { cohort: true } },
      { paths: null },
      { paths: [] },
      { economics: null },
    ])
      expect(mode, extra, 'keep', 'unrelated');
  });

  test(`fa2c1383 ${mode}: a disjoint order-sensitive mover keeps the run to seed a scoped recheck`, () => {
    expect(mode, { changed: ['convex/schema.ts'] }, 'keep', 'scoped-recheck');
    expect(mode, { changed: ['.oxlintrc.json'] }, 'keep', 'scoped-recheck');
  });

  test(`fa2c1383 ${mode}: a disjoint sub-package manifest mover keeps the run to carry (placement)`, () => {
    expect(mode, { changed: ['packages/x/package.json'] }, 'keep', 'carry');
    // A docs pass may carry, and an unknown main still carries through the main receipt.
    expect(mode, { changed: ['packages/x/package.json'], run: { gate: 'docs' } }, 'keep', 'carry');
    expect(mode, { changed: ['packages/x/package.json'], main: { status: 'unknown' } }, 'keep', 'carry');
  });

  test(`fa2c1383 ${mode}: both sides placing a sub-package manifest is not a carry (placedRiskBetween)`, () => {
    const pair = { paths: ['packages/y/package.json'], changed: ['packages/x/package.json'] };
    expect(mode, pair, 'keep', 'scoped-recheck');
    expect(mode, { ...pair, run: { standard: false } }, 'cancel', 'cannot-scope');
  });

  test(`fa2c1383 ${mode}: overlapping movers still retire the run (Lane B probes them first)`, () => {
    expect(mode, { changed: ['src/b.ts'] }, 'cancel', 'code-overlap');
    expect(mode, { changed: ['src/b.ts', 'package.json'] }, 'cancel', 'code-overlap');
    expect(mode, { changed: ['src'], paths: ['src/b.ts'] }, 'cancel', 'code-overlap');
  });

  test(`fa2c1383 ${mode}: a shared Markdown file alone is not code overlap`, () => {
    const paths = ['docs/a.md', 'src/b.ts'];
    assert.equal(codeOverlap(paths, ['docs/a.md', 'package.json']), false);
    assert.equal(codeOverlap(paths, ['docs/a.md', 'src/b.ts']), true);
    assert.deepEqual(sharedDocs(paths, ['docs/a.md', 'src/b.ts']), ['docs/a.md']);
    expect(mode, { paths, changed: ['docs/a.md', 'convex/schema.ts'] }, 'keep', 'scoped-recheck');
  });

  test(`fa2c1383 ${mode}: a global mover retires runs whose pass could never be used`, () => {
    const changed = ['convex/schema.ts'];
    for (const [extra, reason] of [
      [{ paths: null }, 'unknown-paths'],
      [{ paths: [] }, 'unknown-paths'],
      [{ acceptance: { mode: 'review' } }, 'policy'],
      [{ acceptance: { hostedCrossHeadReuse: false, scopedRecheck: false } }, 'policy'],
      [{ reducedEvidence: false }, 'actor'],
      [{ landing: { recovery: true } }, 'recovery'],
      [{ landing: { revert: true } }, 'revert'],
      [{ landing: { cohort: true } }, 'cohort'],
      [{ landing: { semanticPlan: true } }, 'semantic-plan'],
      [{ run: { gate: 'partial' } }, 'partial-run'],
      [{ main: { status: 'red' } }, 'main-red'],
      [{ main: { debt: true } }, 'audit-debt'],
      [{ acceptance: { scopedRecheck: false } }, 'cannot-scope'],
      [{ run: { standard: false } }, 'cannot-scope'],
      [{ protectedPaths: true }, 'cannot-scope'],
    ])
      expect(mode, { changed, ...extra }, 'cancel', reason);
  });

  test(`fa2c1383 ${mode}: a scoped-recheck keep needs a direct runner, a full (non-docs) pass and a green main`, () => {
    const changed = ['convex/schema.ts'];
    // enqueueHostedCheck emits a scoped gate only on the direct runner; scopedRecheckBasis needs a full
    // gate; scopedRecheckEligible needs a green main. Each would pay a full replacement anyway.
    expect(mode, { changed, run: { direct: false } }, 'cancel', 'cannot-scope');
    expect(mode, { changed, run: { gate: 'docs' } }, 'cancel', 'cannot-scope');
    expect(mode, { changed, main: { status: 'unknown' } }, 'cancel', 'cannot-scope');
  });

  test(`fa2c1383 ${mode}: a scoped-recheck keep needs the project's measured costs to show it pays`, () => {
    const changed = ['convex/schema.ts'];
    expect(mode, { changed, economics: null }, 'cancel', 'scoped-unmeasured');
    expect(mode, { changed, economics: { ...ECONOMICS, elapsed: 0.5 } }, 'cancel', 'scoped-costs-more');
    expect(mode, { changed, economics: { ...ECONOMICS, elapsed: 0.8 } }, 'keep', 'scoped-recheck');
    // A measured red share pays earlier: a red kept run ends the landing with no recheck.
    expect(
      mode,
      { changed, economics: { ...ECONOMICS, elapsed: 0.6, redShare: 0.3 } },
      'keep',
      'scoped-recheck',
    );
    // Carry never needs the measurement: it always saves the replacement run.
    expect(
      mode,
      { changed: ['packages/x/package.json'], economics: { ...ECONOMICS, elapsed: 0 } },
      'keep',
      'carry',
    );
  });

  test(`fa2c1383 ${mode}: a dependency bump under a late disjoint order-sensitive mover retires (its recheck is full)`, () => {
    // Review 563c595b finding 1: a Lane changing package.json and package-lock.json, 80% through its
    // full check, when tsconfig.json or .oxlintrc.json lands. scopedRecheckSelection sends a change
    // with a top-level config file to the full suite (scoped-root-config), so keeping pays (1 - e) + 1.
    const paths = ['package.json', 'package-lock.json'];
    for (const changed of [['tsconfig.json'], ['.oxlintrc.json']])
      expect(mode, { paths, changed, economics: { ...ECONOMICS, elapsed: 0.8 } }, 'cancel', 'cannot-scope');
    // A top-level Markdown file is documentation, not configuration: the scoped keep stands.
    expect(
      mode,
      { paths: ['README.md', 'src/b.ts'], changed: ['convex/schema.ts'] },
      'keep',
      'scoped-recheck',
    );
  });

  test(`fa2c1383 / 687d1eda ${mode}: a coverage mover retires the run (no narrow interaction exists)`, () => {
    for (const changed of [['.github/workflows/ci.yml'], ['scripts/forge-check.mjs']])
      expect(mode, { changed, coverageMover: true }, 'cancel', 'coverage-mover');
    // Selection inputs are not global risk: today's unrelated keep must not skip the coverage cancel.
    for (const changed of [
      ['scripts/browser-test-policy.mjs'],
      ['scripts/check-browser-runtime.mjs'],
      ['tests/browser-runtime.mjs'],
    ]) {
      const input = keepInput({ changed, acceptance: { landingMode: mode } });
      assert.equal(input.globalMover, false, changed[0]);
      assert.equal(input.coverageMover, true, changed[0]);
      expect(mode, { changed }, 'cancel', 'coverage-mover');
      expect(mode, { changed, paths: null }, 'cancel', 'coverage-mover');
    }
  });

  test(`fa2c1383 ${mode}: carry off but scope on still keeps the run (split of the old global-risk row)`, () => {
    expect(
      mode,
      { changed: ['build.rs'], acceptance: { hostedCrossHeadReuse: false } },
      'keep',
      'scoped-recheck',
    );
    expect(
      mode,
      { changed: ['build.rs'], acceptance: { hostedCrossHeadReuse: false, scopedRecheck: false } },
      'cancel',
      'policy',
    );
  });

  test(`fa2c1383 ${mode}: a non-standard command keeps the run only where carry is possible`, () => {
    expect(mode, { changed: ['packages/x/package.json'], run: { standard: false } }, 'keep', 'carry');
    expect(mode, { changed: ['convex/schema.ts'], run: { standard: false } }, 'cancel', 'cannot-scope');
  });

  test(`fa2c1383 ${mode}: a keep that replaces a retire holds queue order; today's unrelated keep does not`, () => {
    assert.deepEqual(decide(mode, {}), { action: 'keep', reason: 'unrelated', holdOrder: false });
    assert.deepEqual(decide(mode, { changed: ['packages/x/package.json'] }), {
      action: 'keep',
      reason: 'carry',
      holdOrder: true,
    });
    assert.deepEqual(decide(mode, { changed: ['convex/schema.ts'] }), {
      action: 'keep',
      reason: 'scoped-recheck',
      holdOrder: true,
    });
  });
}

test('fa2c1383 fast: a relaxable root-config mover carries only when the fast mode holds on main', () => {
  const changed = ['package.json'];
  expect('strict', { changed }, 'keep', 'scoped-recheck');
  expect('fast', { changed, fastMain: true }, 'keep', 'carry');
  expect('fast', { changed, fastMain: false }, 'keep', 'scoped-recheck');
  // Non-standard command: the fast-main read is the only way the pass is still usable.
  const blind = { changed, run: { standard: false } };
  assert.equal(needsFastMain(keepInput({ ...blind, acceptance: { landingMode: 'fast' } })), true);
  assert.equal(needsFastMain(keepInput({ ...blind, acceptance: { landingMode: 'strict' } })), false);
  assert.equal(needsFastMain(keepInput({ changed, acceptance: { landingMode: 'fast' } })), true);
  assert.equal(
    needsFastMain(keepInput({ changed: ['convex/schema.ts'], acceptance: { landingMode: 'fast' } })),
    false,
  );
  expect('fast', { ...blind, fastMain: true }, 'keep', 'carry');
  expect('fast', { ...blind, fastMain: false }, 'cancel', 'cannot-scope');
});

test('fa2c1383: a shared Markdown file carries only on a fast main (the proof refuses tested docs otherwise)', () => {
  // analyzeCrossHeadReuse returns `tested-doc` without the fast mode; the sweep cannot see the
  // pinned tested-docs list, so a shared Markdown file is taken as tested.
  const overlap = { paths: ['docs/a.md', 'src/b.ts'], changed: ['docs/a.md'] };
  expect('strict', overlap, 'keep', 'scoped-recheck');
  expect('strict', { ...overlap, fastMain: true }, 'keep', 'scoped-recheck');
  expect('fast', { ...overlap, fastMain: false }, 'keep', 'scoped-recheck');
  expect('fast', { ...overlap, fastMain: true }, 'keep', 'carry');
  expect('strict', { ...overlap, run: { standard: false } }, 'cancel', 'cannot-scope');
  assert.equal(needsFastMain(keepInput({ ...overlap, acceptance: { landingMode: 'fast' } })), true);
});

test('fa2c1383: the keep rule reads the same root-config predicate as the runner-side selection', () => {
  const selection = paths => scopedRecheckSelection({ lanePaths: paths, mainPaths: [], files: new Map() });
  for (const paths of [['package.json'], ['tsconfig.json', 'src/b.ts'], ['.oxlintrc.json']]) {
    assert.ok(scopedRootConfig(paths), JSON.stringify(paths));
    assert.equal(selection(paths).fallback, 'scoped-root-config', JSON.stringify(paths));
  }
  for (const paths of [['README.md'], ['src/b.ts', 'docs/a.md']]) {
    assert.equal(scopedRootConfig(paths), undefined, JSON.stringify(paths));
    assert.notEqual(selection(paths).fallback, 'scoped-root-config', JSON.stringify(paths));
  }
});

test('fa2c1383: the scoped-recheck payback is the measured share, discounted by the red share', () => {
  const shares = { jobs: 0.68, wall: 0.77 };
  // The larger of the two shares decides: both runner-minutes and time to main must improve.
  assert.equal(scopedRecheckPays({ elapsed: 0.76, scopedShare: shares, redShare: 0 }), false);
  assert.equal(scopedRecheckPays({ elapsed: 0.78, scopedShare: shares, redShare: 0 }), true);
  assert.equal(scopedRecheckPays({ elapsed: 0.5, scopedShare: shares, redShare: 0.3 }), false);
  assert.equal(scopedRecheckPays({ elapsed: 0.55, scopedShare: shares, redShare: 0.3 }), true);
  // Selector precision (5dcfce75) narrows the scoped share, and the keep moves earlier by itself.
  assert.equal(
    scopedRecheckPays({ elapsed: 0.3, scopedShare: { jobs: 0.2, wall: 0.25 }, redShare: 0 }),
    true,
  );
});

const SIDES = [
  ['src/b.ts'],
  ['src/a.ts'],
  ['docs/a.md'],
  ['package.json'],
  ['packages/x/package.json'],
  ['packages/y/package.json'],
  ['package-lock.json'],
  ['convex/schema.ts'],
  ['.oxlintrc.json'],
  ['.github/workflows/ci.yml'],
  ['scripts/forge-check.mjs'],
  ['scripts/browser-test-policy.mjs'],
  ['migrations/0005_a.sql'],
  ['migrations/0005_b.sql'],
  ['tests/fixtures/x.json'],
  ['build.rs'],
  ['src/b.ts', 'docs/a.md'],
];
const VARIANTS = [
  {},
  { acceptance: { hostedCrossHeadReuse: false } },
  { acceptance: { scopedRecheck: false } },
  { reducedEvidence: false },
  { main: { status: 'red' } },
  { main: { status: 'unknown' } },
  { run: { gate: 'partial' } },
  { run: { gate: 'docs' } },
  { run: { standard: false } },
  { run: { direct: false } },
  { landing: { cohort: true } },
  { protectedPaths: true },
  { economics: null },
  { economics: { ...ECONOMICS, elapsed: 0.3 } },
];
const grid = function* () {
  for (const mode of MODES)
    for (const paths of SIDES)
      for (const changed of SIDES)
        for (const variant of VARIANTS)
          for (const fastMain of [false, true])
            yield keepInput({
              ...variant,
              paths,
              changed,
              fastMain,
              acceptance: { landingMode: mode, ...variant.acceptance },
            });
};

test('fa2c1383 guard: every run today keeps is still kept, except under a coverage mover', () => {
  let kept = 0;
  let tightened = 0;
  for (const input of grid()) {
    const decided = staleCheckDisposition(input);
    if (input.coverageMover) {
      // Intended tightening (687d1eda): a coverage mover retires every running check.
      assert.deepEqual(decided, { action: 'cancel', reason: 'coverage-mover' }, JSON.stringify(input));
      if (todayKeeps(input)) tightened++;
    } else if (todayKeeps(input)) {
      kept++;
      assert.equal(decided.action, 'keep', JSON.stringify(input));
    }
  }
  assert(kept > 0 && tightened > 0);
});

test('fa2c1383 guard: strict and fast proof rules are never widened by a carry keep', () => {
  for (const input of grid()) {
    const { action, reason } = staleCheckDisposition(input);
    if (action !== 'keep' || reason !== 'carry') continue;
    const { paths, changed } = input;
    const fastOnMain = () => {
      assert.equal(input.acceptance.landingMode, 'fast', JSON.stringify(input));
      assert.equal(input.fastMain, true, JSON.stringify(input));
    };
    assert.equal(input.acceptance.hostedCrossHeadReuse === false, false, 'carry needs reuse on');
    assert.equal(codeOverlap(paths, changed), false, 'carry never crosses code overlap');
    const oneSided = !(
      firstCheckRiskPaths(paths, STANDARD_ENTRIES).length &&
      firstCheckRiskPaths(changed, STANDARD_ENTRIES).length
    );
    if (
      globalRiskBetween(paths, changed, STANDARD_ENTRIES) &&
      !(placeableRisk(paths, changed, STANDARD_ENTRIES) && oneSided)
    ) {
      // Only the fast rule may relax global risk, never the order-sensitive part, and only on a fast main.
      fastOnMain();
      assert.deepEqual(orderSensitiveRisk(paths, changed, STANDARD_ENTRIES), [], JSON.stringify(input));
    }
    // A shared Markdown file may be a tested doc: only the fast proof relaxes it.
    if (sharedDocs(paths, changed).length) fastOnMain();
  }
});

test('fa2c1383 guard: a scoped-recheck keep is only for a basis today can scope, where it pays', () => {
  for (const input of grid()) {
    const { action, reason } = staleCheckDisposition(input);
    if (action !== 'keep' || reason !== 'scoped-recheck') continue;
    const at = JSON.stringify(input);
    assert(input.run.gate === 'full' && input.run.standard && input.run.direct, at);
    assert(!input.protectedPaths && input.paths?.length && !scopedRootConfig(input.paths), at);
    assert(input.acceptance.scopedRecheck !== false && input.reducedEvidence, at);
    assert(input.main.status === 'green' && !input.main.debt && !input.landing.cohort, at);
    assert(input.economics && scopedRecheckPays(input.economics), at);
  }
});

test('fa2c1383 guard: every keep that replaces a retire holds queue order, and only those', () => {
  for (const input of grid()) {
    const decided = staleCheckDisposition(input);
    if (decided.action !== 'keep') continue;
    assert.equal(decided.holdOrder, !todayKeeps(input), JSON.stringify(input));
    assert.equal(decided.holdOrder, decided.reason !== 'unrelated', JSON.stringify(input));
  }
});
