// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The baseline arm for keep-the-run (Item fa2c1383): today's main-move sweep
// (convex/projectHostedLandingStaleChecks.ts with the O4 switch off, the only state main has run in)
// as a pure decision on the same inputs as src/stale-check-keep.ts. A run is kept only when the
// mover touches no global-risk file and does not overlap it (or its paths are unknown).
import { checkRunEntryPaths, coverageChangePaths, firstCheckRiskPaths } from '../dist/first-check-risk.js';
import { STANDARD_SELECTION_INPUTS } from '../dist/standard-check.js';
import { pathsOverlap } from '../dist/hosted-cross-head-proof.js';

export const todayKeeps = ({ globalMover, paths, changed }) =>
  !globalMover && (!paths || !pathsOverlap([...paths], [...changed]));

export const STANDARD_ENTRIES = checkRunEntryPaths({
  executable: '/usr/local/bin/node',
  args: ['scripts/forge-check.mjs'],
  recipe: 'forge-standard-v1',
});

/** Today's `global`: the mover touches a global-risk file for this check. */
export const globalMover = changed => firstCheckRiskPaths(changed, STANDARD_ENTRIES).length > 0;
/** convex coverageLanding (Item 687d1eda) for the standard check, on paths alone. */
export const coverageMover = changed =>
  coverageChangePaths(changed, [...STANDARD_ENTRIES, ...STANDARD_SELECTION_INPUTS]).length > 0;
/** Measured on the 11-17 trace: scoped recheck 71.7 / 105.2 job-min and 10.1 / 13.2 min wall; a run
 * kept at 90% of its wall pays. */
export const ECONOMICS = { elapsed: 0.9, scopedShare: { jobs: 0.68, wall: 0.77 }, redShare: 0 };
/** An owner agent's whole standard run on the direct runner and a green main, auto-on-pass with carry
 * and scope on. */
export const keepInput = (overrides = {}) => ({
  globalMover: globalMover(overrides.changed ?? ['src/a.ts']),
  coverageMover: coverageMover(overrides.changed ?? ['src/a.ts']),
  acceptance: { mode: 'auto-on-pass', landingMode: 'strict', ...overrides.acceptance },
  reducedEvidence: true,
  landing: { recovery: false, revert: false, cohort: false, semanticPlan: false, ...overrides.landing },
  run: { gate: 'full', standard: true, direct: true, ...overrides.run },
  paths: ['src/b.ts'],
  changed: ['src/a.ts'],
  checkEntries: STANDARD_ENTRIES,
  main: { status: 'green', debt: false, ...overrides.main },
  economics: ECONOMICS,
  protectedPaths: false,
  ...Object.fromEntries(
    Object.entries(overrides).filter(([key]) => !['acceptance', 'landing', 'run', 'main'].includes(key)),
  ),
});
