// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
import { pathsOverlap } from '../dist/hosted-cross-head-proof.js';
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

  test(`fa2c1383 Lane B ${mode}: an overlapping run keeps for a scoped recheck only on a clean probe`, () => {
    const late = { economics: { ...ECONOMICS, elapsed: 0.9 } };
    for (const changed of [['src/b.ts'], ['src/b.ts', 'package.json'], ['src/b.ts', 'convex/schema.ts']]) {
      expect(mode, { changed, ...late, overlapProbe: 'clean' }, 'keep', 'scoped-recheck');
      // A conflicting probe ends the landing at once (COMPOSITION_CONFLICT), with no recheck.
      expect(mode, { changed, ...late, overlapProbe: 'conflict' }, 'cancel', 'compose-conflict');
    }
    expect(mode, { changed: ['src'], paths: ['src/b.ts'], overlapProbe: 'clean' }, 'keep', 'scoped-recheck');
    // Code overlap never carries, even where carry is on and the fast mode holds on main.
    expect(
      mode,
      { changed: ['src/b.ts'], overlapProbe: 'clean', fastMain: true, run: { standard: false } },
      'cancel',
      'cannot-scope',
    );
    // A clean probe lifts only the overlap: payback and every other cancel still apply.
    for (const [extra, reason] of [
      [{ economics: { ...ECONOMICS, elapsed: 0.5 } }, 'scoped-costs-more'],
      [{ economics: null }, 'scoped-unmeasured'],
      [{ main: { status: 'red' } }, 'main-red'],
      [{ run: { gate: 'partial' } }, 'partial-run'],
      [{ landing: { cohort: true } }, 'cohort'],
      [{ reducedEvidence: false }, 'actor'],
      [{ protectedPaths: true }, 'cannot-scope'],
      [{ paths: ['src/b.ts', 'package.json'] }, 'cannot-scope'],
    ])
      expect(mode, { changed: ['src/b.ts'], overlapProbe: 'clean', ...extra }, 'cancel', reason);
    expect(
      mode,
      { changed: ['src/b.ts'], overlapProbe: 'clean', coverageMover: true },
      'cancel',
      'coverage-mover',
    );
  });

  test(`fa2c1383 Lane B ${mode}: a pending probe keeps the run only until the precompose probe answers`, () => {
    assert.deepEqual(decide(mode, { changed: ['src/b.ts'], overlapProbe: 'pending' }), {
      action: 'keep',
      reason: 'scoped-recheck',
      holdOrder: true,
      probe: true,
    });
    // A shared Markdown file can text-conflict too: under a pending probe it is probed before it carries.
    const docs = { paths: ['docs/a.md', 'src/b.ts'], changed: ['docs/a.md'] };
    assert.equal(decide(mode, { ...docs, overlapProbe: 'pending' }).probe, true);
    expect(mode, { ...docs, overlapProbe: 'conflict' }, 'cancel', 'compose-conflict');
    // A run that shares no path with the mover is never probed: a pending probe keeps it as before.
    for (const changed of [['src/a.ts'], ['convex/schema.ts']])
      assert.equal(
        decide(mode, { changed, overlapProbe: 'pending' }).action,
        'keep',
        JSON.stringify({ changed }),
      );
    assert.equal(decide(mode, { changed: ['convex/schema.ts'], overlapProbe: 'pending' }).probe, false);
    // A pending probe does not keep what a clean probe would not.
    expect(
      mode,
      { changed: ['src/b.ts'], overlapProbe: 'pending', economics: null },
      'cancel',
      'scoped-unmeasured',
    );
  });

  test(`fa2c1383 Lane B ${mode}: a conflict answer cancels even when the latest mover is disjoint`, () => {
    // Review 0c7f9440 finding 1: the probe composes on cumulative main, so a disjoint mover that lands
    // while it runs leaves the conflict standing. No earlier answer (unrelated, coverage, policy) keeps it.
    for (const extra of [
      {},
      { changed: ['src/a.ts'] },
      { changed: ['convex/schema.ts'] },
      { changed: ['packages/x/package.json'] },
      { changed: ['scripts/browser-test-policy.mjs'] },
      { paths: null },
      { acceptance: { mode: 'review' } },
    ])
      expect(mode, { ...extra, overlapProbe: 'conflict' }, 'cancel', 'compose-conflict');
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
    assert.deepEqual(decide(mode, {}), {
      action: 'keep',
      reason: 'unrelated',
      holdOrder: false,
      probe: false,
    });
    assert.deepEqual(decide(mode, { changed: ['packages/x/package.json'] }), {
      action: 'keep',
      reason: 'carry',
      holdOrder: true,
      probe: false,
    });
    assert.deepEqual(decide(mode, { changed: ['convex/schema.ts'] }), {
      action: 'keep',
      reason: 'scoped-recheck',
      holdOrder: true,
      probe: false,
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
const PROBES = [undefined, 'pending', 'clean', 'conflict'];
const sameDecision = (a, b) =>
  a.action === b.action && a.reason === b.reason && a.holdOrder === b.holdOrder && a.probe === b.probe;
// The message is built only on failure: stringifying every grid row was most of this file's time.
const fail = (input, message) => assert.fail(`${message}: ${JSON.stringify(input)}`);
let cells;
// Built once for every guard: each input with its decision, today's answer, whether it shares a path
// with the mover, and the same row's answers with no probe and with a clean probe (probe is innermost).
const grid = () => {
  if (cells) return cells;
  cells = [];
  for (const mode of MODES)
    for (const paths of SIDES)
      for (const changed of SIDES)
        for (const variant of VARIANTS)
          for (const fastMain of [false, true]) {
            const base = keepInput({
              ...variant,
              paths,
              changed,
              fastMain,
              acceptance: { landingMode: mode, ...variant.acceptance },
            });
            const row = PROBES.map(overlapProbe => {
              const input = { ...base, overlapProbe };
              return { input, decided: staleCheckDisposition(input) };
            });
            const today = todayKeeps(base);
            const shared = Boolean(base.paths?.length) && pathsOverlap([...base.paths], [...base.changed]);
            for (const cell of row)
              cells.push({ ...cell, without: row[0].decided, clean: row[2].decided, today, shared });
          }
  return cells;
};

test('fa2c1383 guard: every run today keeps is still kept, except under a coverage mover or a conflict', () => {
  let kept = 0;
  let tightened = 0;
  for (const { input, decided, today } of grid()) {
    // A conflict answer on current main always ends the landing (review 0c7f9440; Lane B guard below).
    if (input.overlapProbe === 'conflict') continue;
    if (input.coverageMover) {
      // Intended tightening (687d1eda): a coverage mover retires every running check.
      if (decided.action !== 'cancel' || decided.reason !== 'coverage-mover')
        fail(input, 'coverage mover kept');
      if (today) tightened++;
    } else if (today) {
      kept++;
      if (decided.action !== 'keep') fail(input, 'today keeps this run');
    }
  }
  assert(kept > 0 && tightened > 0);
});

test('fa2c1383 guard: strict and fast proof rules are never widened by a carry keep', () => {
  let carried = 0;
  for (const { input, decided } of grid()) {
    if (decided.action !== 'keep' || decided.reason !== 'carry') continue;
    carried++;
    const { paths, changed } = input;
    const fastOnMain = () => {
      if (input.acceptance.landingMode !== 'fast' || input.fastMain !== true)
        fail(input, 'carry needs a fast main');
    };
    if (input.acceptance.hostedCrossHeadReuse === false) fail(input, 'carry needs reuse on');
    if (codeOverlap(paths, changed)) fail(input, 'carry never crosses code overlap');
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
      if (orderSensitiveRisk(paths, changed, STANDARD_ENTRIES).length) fail(input, 'order-sensitive carry');
    }
    // A shared Markdown file may be a tested doc: only the fast proof relaxes it.
    if (sharedDocs(paths, changed).length) fastOnMain();
  }
  assert(carried > 0);
});

test('fa2c1383 guard: a scoped-recheck keep is only for a basis today can scope, where it pays', () => {
  let scoped = 0;
  for (const { input, decided } of grid()) {
    if (decided.action !== 'keep' || decided.reason !== 'scoped-recheck') continue;
    scoped++;
    if (!(input.run.gate === 'full' && input.run.standard && input.run.direct)) fail(input, 'run');
    if (!(!input.protectedPaths && input.paths?.length && !scopedRootConfig(input.paths)))
      fail(input, 'paths');
    if (!(input.acceptance.scopedRecheck !== false && input.reducedEvidence)) fail(input, 'policy');
    if (!(input.main.status === 'green' && !input.main.debt && !input.landing.cohort)) fail(input, 'main');
    if (!(input.economics && scopedRecheckPays(input.economics))) fail(input, 'payback');
    // Lane B: code overlap keeps only on a clean or pending probe, and a pending one is flagged.
    if (
      codeOverlap(input.paths, input.changed) &&
      input.overlapProbe !== 'clean' &&
      input.overlapProbe !== 'pending'
    )
      fail(input, 'overlap keep without a probe');
  }
  assert(scoped > 0);
});

test('fa2c1383 Lane B guard: the probe only ever lifts a code-overlap retire, and a conflict never keeps', () => {
  let lifted = 0;
  let conflicts = 0;
  for (const { input, decided, without, clean, shared } of grid()) {
    // Review 0c7f9440: a conflict cancels every run, shared paths or not.
    if (input.overlapProbe === 'conflict') {
      conflicts++;
      if (decided.action !== 'cancel' || decided.reason !== 'compose-conflict') fail(input, 'conflict kept');
      continue;
    }
    // Any other probe answer changes nothing for a run that shares no path with the mover.
    if (!shared && !sameDecision(decided, without)) fail(input, 'probe changed a disjoint run');
    // Wherever it lifts a retire, it was a code-overlap retire, and the keep is a scoped recheck.
    if (decided.action === 'keep' && without.action === 'cancel') {
      lifted++;
      if (without.reason !== 'code-overlap' || decided.reason !== 'scoped-recheck') fail(input, 'lifted');
    }
    if (decided.action === 'keep' && decided.probe !== (input.overlapProbe === 'pending' && shared))
      fail(input, 'probe flag');
    // A pending probe never keeps what a clean probe would retire.
    if (input.overlapProbe === 'pending' && decided.action === 'keep' && clean.action !== 'keep')
      fail(input, 'pending keeps what clean retires');
  }
  assert(lifted > 0 && conflicts > 0);
});

test('fa2c1383 guard: every keep that replaces a retire holds queue order, and only those', () => {
  for (const { input, decided, today } of grid()) {
    if (decided.action !== 'keep') continue;
    if (decided.holdOrder !== !today) fail(input, 'holdOrder vs today');
    if (decided.holdOrder !== (decided.reason !== 'unrelated')) fail(input, 'holdOrder vs reason');
  }
});
