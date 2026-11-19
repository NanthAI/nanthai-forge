// SPDX-License-Identifier: Apache-2.0
/** Keep the run (Item fa2c1383): when main moves under a running whole check, decide whether the
 * run keeps going or is retired. A kept run's pass is never acceptance by itself: it either carries
 * through today's cross-head proof or becomes the basis of today's scoped recheck. So this rule
 * changes only which runs are thrown away, never what may land.
 *
 * Carry is kept whenever today's proof could use it: it saves the replacement run outright. A scoped
 * recheck is kept only where it pays: the run's remaining time plus the scoped recheck must cost less
 * than the full replacement a retire starts, in runner job-minutes and in wall time, on the project's
 * own measured check costs. Everything else retires as today.
 *
 * Pure: no I/O. Every input comes from rows the post-acceptance sweep already reads
 * (convex/projectHostedLandingStaleChecks.ts), plus the memoised main gate. */
import { firstCheckRiskPaths, globalRiskBetween, orderSensitiveRisk } from './first-check-risk.js';
import { pathsOverlap } from './hosted-cross-head-proof.js';
import { placeableRisk } from './package-placement.js';
import { scopedRootConfig } from './scoped-root-config.js';
import { markdownPath } from './tested-docs.js';

/** The project's own measured check costs, for the scoped-recheck keep. */
export type StaleCheckEconomics = {
  /** The run's elapsed time over the project's median whole-check wall. */
  elapsed: number;
  /** The project's median scoped recheck over its median whole check, in runner job-minutes and in wall. */
  scopedShare: { jobs: number; wall: number };
  /** Share of the project's whole first checks that fail. A red kept run ends the landing with no
   * recheck at all; 0 when unknown, which never over-keeps. */
  redShare: number;
};

export type StaleCheckInput = {
  /** The project's effective acceptance policy. */
  acceptance: {
    mode: string;
    hostedCrossHeadReuse?: boolean | undefined;
    scopedRecheck?: boolean | undefined;
    landingMode?: string | undefined;
  };
  /** `reducedEvidenceActor(policy, project, actor, best trust)`: the cheap upper bound. */
  reducedEvidence: boolean;
  landing: {
    recovery: boolean;
    revert: boolean;
    /** A shared (non-solo) cohort run: its retry stays the cohort's own. */
    cohort: boolean;
    semanticPlan: boolean;
  };
  run: {
    /** `fullGate(run)` → 'full', `docsGate(run)` → 'docs', anything else (a scoped run) → 'partial'.
     * A docs pass may carry; only a full pass seeds a scoped recheck (`scopedRecheckBasis`). */
    gate: 'full' | 'docs' | 'partial';
    /** Forge's standard check, the only command whose selection can narrow to a scoped recheck. */
    standard: boolean;
    /** The direct GitHub Actions runner, the only runner that enqueues a scoped recheck gate
     * (`enqueueHostedCheck`). */
    direct: boolean;
  };
  /** The checked Candidate's changed paths; null when its record is missing or has none. */
  paths: readonly string[] | null;
  /** The accepted mover's changed paths. */
  changed: readonly string[];
  /** `checkRunEntryPaths(run.check)`. */
  checkEntries: readonly string[];
  /** The project's check entries and declared global-risk paths matched the mover (today's `global`). */
  globalMover: boolean;
  /** The mover changes which tests run or how (Item 687d1eda `coverageLanding`). */
  coverageMover: boolean;
  /** `mainGate` at the mover, read once per sweep. `unknown` may still carry (`main-receipt`), but
   * never seeds a scoped recheck (`scopedRecheckEligible` needs green). */
  main: { status: 'green' | 'red' | 'unknown'; debt: boolean };
  /** The candidate touches a protected path: the contract gate, and so a scoped recheck, is refused. */
  protectedPaths: boolean;
  /** The project's measured check costs; null when unmeasured (then no scoped-recheck keep). */
  economics: StaleCheckEconomics | null;
  /** The fast mode is in effect on current main (the sweep's memoised `currentFastMode`). Read it
   * only when `needsFastMain` says the answer depends on it. */
  fastMain?: boolean | undefined;
};

export type StaleCheckKeep = 'unrelated' | 'carry' | 'scoped-recheck';
export type StaleCheckCancel =
  | 'unknown-paths'
  | 'code-overlap'
  | 'policy'
  | 'actor'
  | 'recovery'
  | 'revert'
  | 'cohort'
  | 'semantic-plan'
  | 'partial-run'
  | 'coverage-mover'
  | 'main-red'
  | 'audit-debt'
  | 'cannot-scope'
  | 'scoped-unmeasured'
  | 'scoped-costs-more';
/** `holdOrder`: the keep replaces a retire, so the kept run must take queue order in the same write
 * the retire would have made (plan 82bf7c75 section 0). An unrelated keep is today's keep and leaves
 * the row as it is. */
export type StaleCheckDisposition =
  | { action: 'keep'; reason: StaleCheckKeep; holdOrder: boolean }
  | { action: 'cancel'; reason: StaleCheckCancel };

/** Exact paths both sides changed that are Markdown: a docs merge the proof may still resolve. */
export const sharedDocs = (paths: readonly string[], changed: readonly string[]) => {
  const moved = new Set(changed);
  return paths.filter(path => markdownPath(path) && moved.has(path));
};

/** Overlap that is not only a shared Markdown file (a docs merge the proof may still resolve). */
export function codeOverlap(paths: readonly string[], changed: readonly string[]) {
  const shared = new Set(sharedDocs(paths, changed));
  return (
    pathsOverlap(
      paths.filter(path => !shared.has(path)),
      [...changed],
    ) ||
    pathsOverlap(
      [...paths],
      changed.filter(path => !shared.has(path)),
    )
  );
}

/** Whether today's cross-head proof could carry this pass, on paths alone ('fast-main' when that
 * depends on the fast mode being in effect on main). The proof itself still decides. */
function carryBound(input: StaleCheckInput, paths: readonly string[]): 'yes' | 'no' | 'fast-main' {
  const { changed, checkEntries } = input;
  if (input.acceptance.hostedCrossHeadReuse === false || codeOverlap(paths, changed)) return 'no';
  const fast = input.acceptance.landingMode === 'fast';
  let needsFast = false;
  // Placement needs every risk path to be a sub-package manifest, on one side only
  // (`placedRiskBetween` refuses both sides placing).
  const placeable =
    placeableRisk(paths, changed, checkEntries) &&
    !(firstCheckRiskPaths(paths, checkEntries).length && firstCheckRiskPaths(changed, checkEntries).length);
  if (globalRiskBetween(paths, changed, checkEntries) && !placeable) {
    if (!fast || orderSensitiveRisk(paths, changed, checkEntries).length) return 'no';
    needsFast = true;
  }
  // A shared Markdown file carries only when no test names it; the sweep cannot see the pinned
  // tested-docs list, so it is taken as tested, which the proof relaxes only on a fast main.
  if (sharedDocs(paths, changed).length) {
    if (!fast) return 'no';
    needsFast = true;
  }
  return needsFast ? 'fast-main' : 'yes';
}

/** A kept run that cannot carry pays its remaining time plus a scoped recheck; a retire pays a full
 * replacement (today's replacement has no basis, so it runs the whole suite). Keeping saves when
 * `(1 - elapsed) + (1 - redShare) * scopedShare < 1`, in job-minutes and in wall. */
export const scopedRecheckPays = (economics: StaleCheckEconomics) =>
  economics.elapsed >
  (1 - economics.redShare) * Math.max(economics.scopedShare.jobs, economics.scopedShare.wall);

const keep = (reason: StaleCheckKeep) =>
  ({ action: 'keep', reason, holdOrder: reason !== 'unrelated' }) as const;
const cancel = (reason: StaleCheckCancel) => ({ action: 'cancel', reason }) as const;

/** True when the decision reads `fastMain`; the caller loads it (memoised) only then. */
export const needsFastMain = (input: StaleCheckInput) =>
  staleCheckDisposition({ ...input, fastMain: false }).reason !==
  staleCheckDisposition({ ...input, fastMain: true }).reason;

export function staleCheckDisposition(input: StaleCheckInput): StaleCheckDisposition {
  const { paths, changed } = input;
  // A coverage mover changes which tests exist or run, so no running check's selection still holds:
  // the interaction is not a path set, the kept pass could seed no narrow recheck, and its own run is
  // never main's baseline (687d1eda). This comes before today's unrelated keep on purpose: selection
  // inputs (STANDARD_SELECTION_INPUTS) are not global risk, so today keeps runs under them.
  if (input.coverageMover) return cancel('coverage-mover');
  // Today's rule, unchanged: a mover that touches no global-risk file keeps every run whose paths it
  // does not overlap, and every run whose paths are unknown.
  if (!input.globalMover && (!paths || !pathsOverlap([...paths], [...changed]))) return keep('unrelated');
  // An empty path list is refused by the proof (`analyzeCrossHeadReuse`) and the scoped recheck alike.
  if (!paths?.length) return cancel('unknown-paths');
  // Lane B (probe first) is the change for overlapping movers; until then they retire as today.
  if (codeOverlap(paths, changed)) return cancel('code-overlap');
  const { acceptance } = input;
  if (
    acceptance.mode !== 'auto-on-pass' ||
    (acceptance.hostedCrossHeadReuse === false && acceptance.scopedRecheck === false)
  )
    return cancel('policy');
  if (!input.reducedEvidence) return cancel('actor');
  if (input.landing.recovery) return cancel('recovery');
  if (input.landing.revert) return cancel('revert');
  if (input.landing.cohort) return cancel('cohort');
  if (input.landing.semanticPlan) return cancel('semantic-plan');
  if (input.run.gate === 'partial') return cancel('partial-run');
  if (input.main.status === 'red') return cancel('main-red');
  if (input.main.debt) return cancel('audit-debt');
  const carry = carryBound(input, paths);
  if (carry === 'yes' || (carry === 'fast-main' && input.fastMain === true)) return keep('carry');
  if (
    acceptance.scopedRecheck === false ||
    !input.run.standard ||
    !input.run.direct ||
    input.run.gate !== 'full' ||
    input.main.status !== 'green' ||
    input.protectedPaths ||
    // A top-level config file on this change sends the recheck to the full suite (src/scoped-recheck.ts).
    scopedRootConfig(paths)
  )
    return cancel('cannot-scope');
  if (!input.economics) return cancel('scoped-unmeasured');
  return scopedRecheckPays(input.economics) ? keep('scoped-recheck') : cancel('scoped-costs-more');
}
