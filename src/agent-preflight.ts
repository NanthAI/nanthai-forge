// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { clientCacheRoot, retainedRootSibling } from './root-paths.js';
import { pinImportFacts } from '../scripts/test-import-cache.mjs';
import { existsSync, mkdirSync, readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { laneOf, recordHold, type HeavyKind } from './heavy-queue.js';
import { commandKind, slotCapEnv } from './heavy-hold.js';
import { safeRelative } from './files.js';
import { AGENT_WAIT_SECONDS } from './agent-operation-wait.js';
import { z } from 'zod';
import {
  type PreflightReceipt,
  preflightReceiptSchema,
  readPreflightReceipt,
  writePreflightReceipt,
} from './preflight-receipt.js';
import {
  PREFLIGHT_SECONDS_PER_FILE,
  type PreflightFileStats,
  preflightFileStats,
  preflightSecondsPerFile,
  recordFileStats,
  recordPreflightTiming,
} from './preflight-timings.js';
import {
  alteredSurface,
  documentation,
  fitPreflightBudget,
  preflightTierRule,
  protectedTiers,
  removedNames as removedNamesOf,
  selectTests,
  selectPreflightTests,
  selectionSourcePath,
} from '../scripts/test-impact.mjs';
import { learnFailures, learnedTests, recentFailedTests, recordedFailures } from './preflight-learned.js';
import { protectedRunOrder } from './preflight-run-order.js';
import { cachedGuardCandidates } from './preflight-guard-cache.js';
import { type GuardSetReport, planGuardSet, recordPreflightRun } from './preflight-guard-set.js';
import { ranEvidence } from './preflight-guard-learning.js';
export { guardGateFields } from './preflight-guard-set.js';
import { changedSources, commentOnlyEdit } from './preflight-comment-only.js';
import { spawnCaptured, failureExcerpt } from './agent-preflight-capture.js';
import {
  dropKeptStatic,
  keepPassedStatic,
  keptPassedStatic,
  staticScopeKey,
} from './preflight-kept-static.js';
import { dependenciesMissing, runnerDependenciesMissing } from './preflight-dependencies.js';
import {
  runStaticChecks,
  STATIC_CHECK_TIMEOUT_MS,
  selectGuards,
  selectStaticChecks,
  preflightGuards,
  staticChecks,
  type StaticCheckResult,
  type StaticCheck,
  type StaticScope,
} from './agent-preflight-static.js';
import {
  isTypecheck,
  isTypecheckCommand,
  runTypecheckSetup,
  selectTypechecks,
  typecheckEnv,
} from './preflight-typecheck.js';
import { baseStateFiles, cachedObject } from './hosted-changed-paths.js';
import { reviewPaths } from './source-review-format.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import type { NativeFile } from './state/format.js';
import { sourceTree } from './source-tree.js';
import { incompletePreflight, preflightOutcome, preflightVerdict } from './agent-preflight-incomplete.js';
import {
  missingBrowserTests,
  NEEDS_CHROMIUM,
  preflightBrowserEnv,
  skippedBrowserTests,
} from './preflight-browser.js';
import {
  deltaPaths,
  preflightDefinition,
  readPreflightEvidence,
  savedInventory,
  writePreflightEvidence,
  type PreflightEvidence,
} from './agent-preflight-evidence.js';
import { shellQuote } from './shell-quote.js';
import { noTestsCollected } from '../scripts/check-packages-run.mjs';
import { declaredPackageFlags, type PackageFlagSource } from './package-command-flags.js';
import {
  orderRunnerTests,
  projectTestRunner,
  runnerCommand,
  runnerLabel,
  runnerSelection,
  runnerTestPath,
  type RunnerPart,
  type TestRunner,
  type TestRunnerResolution,
} from './project-test-runner.js';
import { CODE_FILE, importGraphTests, jsImportGraph } from './js-import-graph.js';
import { declaredPreflight, FORGE_CONFIG_FILE } from './project-config.js';
import { FILE_TIMEOUT_ENV } from './agent-preflight-reporter.js';
import {
  PREFLIGHT_LOCAL_BUDGET_SECONDS,
  PREFLIGHT_RUN_CEILING_SECONDS,
  preflightTimeSettings,
  type PreflightTimeSettings,
} from './preflight-time-settings.js';
export { PREFLIGHT_LOCAL_BUDGET_SECONDS, PREFLIGHT_RUN_CEILING_SECONDS } from './preflight-time-settings.js';
import { cleanCommandEnvironment } from './clean-command-env.js';
import {
  packageCommandLine,
  packageCommandUnit,
  packageGraphFor,
  packageGraphKey,
  type PackageGraph,
  type SelectedPackage,
} from './package-graph.js';
import { packageRunnerTests, packageTestSelection } from './package-test-selection.js';
import { moduleGraphFor, moduleGraphKey, type ModuleGraph } from './module-graph.js';
import { filesystemEventHealth, filesystemEnvironment } from './filesystem-event-health.js';

import { missingProgramExit, missingToolchain, toolchainEnvironment } from './preflight-toolchain.js';
import { hostedCheckSeconds } from './preflight-hosted-timing.js';

export const preflightRuntime = { filesystemEventHealth };

export { PREFLIGHT_SECONDS_PER_FILE, preflightFileStats, preflightSecondsPerFile, type PreflightFileStats };
export { preflightReceiptSchema, readPreflightReceipt, type PreflightReceipt };
/** Per-file kill limit (Item 168e4ed8). Signal: the file's measured seconds on this machine.
 * Formula: 3 x measured, at least PREFLIGHT_FILE_LIMIT_FLOOR_SECONDS; a file never timed here gets
 * PREFLIGHT_FILE_LIMIT_UNKNOWN_SECONDS. Override: preflight.fileTimeoutSeconds (forge.json or
 * package.json forge). A file past it is killed with its process group and named as failed. */
export const PREFLIGHT_FILE_LIMIT_FLOOR_SECONDS = 120;
export const PREFLIGHT_FILE_LIMIT_UNKNOWN_SECONDS = 300;
export function preflightFileLimitSeconds(declared: number | undefined, measuredMs: number | undefined) {
  if (declared !== undefined) return declared;
  return measuredMs === undefined
    ? PREFLIGHT_FILE_LIMIT_UNKNOWN_SECONDS
    : Math.max(PREFLIGHT_FILE_LIMIT_FLOOR_SECONDS, Math.ceil((3 * measuredMs) / 1000));
}
/** The project's declared per-file limit, when it is a positive number. */
function declaredFileLimitSeconds(root: string) {
  try {
    const value = declaredPreflight(
      'fileTimeoutSeconds',
      laneText(root, 'package.json'),
      laneText(root, FORGE_CONFIG_FILE),
    )?.value;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
/** Default cost of one package command (it builds and tests whole packages) when neither this
 * machine nor a hosted check has timed one yet. */
export const PREFLIGHT_SECONDS_PER_PACKAGE_COMMAND = 60;
/** Why a plan from a runner Forge inferred never blocks landing (src/agent-default-gates.ts). */
export const INFERRED_RUNNER_ADVISORY =
  'Forge inferred these commands (no runner declared): their result is reported, never required, because they can need setup only CI does (fixtures, services, a toolchain). Declare preflight.tests in forge.json to require it.';
/** The ceiling a run keeps: the default, or the caller's explicit larger budget (named as an override). */
export const runCeiling = (
  budgetSeconds: number | undefined,
  settings?: PreflightTimeSettings,
): { seconds: number; override?: true } => {
  if (settings)
    return {
      seconds: settings.ceiling.seconds,
      ...(settings.ceiling.source === 'run' ? { override: true } : {}),
    };
  return budgetSeconds !== undefined && budgetSeconds > PREFLIGHT_RUN_CEILING_SECONDS
    ? { seconds: budgetSeconds, override: true }
    : { seconds: PREFLIGHT_RUN_CEILING_SECONDS };
};
/** The ceiling a planned run keeps, wherever its plan carries it; the default when it carries none. */
const planCeiling = (plan: PreflightPlan & { status: 'planned' }) =>
  plan.local?.ceiling ?? plan.ceiling ?? runCeiling(undefined, plan.timeSettings);
/** Fit a prefix of the existing run order, including protected tests. The wall clock still
 * handles estimates that turn out low. */
function fitRunCeiling(
  ranked: string[],
  ceilingSeconds: number,
  secondsFor: (test: string) => number,
  unit = 'test file',
) {
  let seconds = 0;
  let count = 0;
  for (const test of ranked) {
    const next = seconds + secondsFor(test);
    if (next - ceilingSeconds > 1e-9) break; // Ignore rounding noise from fractional estimates.
    seconds = next;
    count++;
  }
  const deferred = ranked.slice(count);
  return {
    tests: ranked.slice(0, count),
    seconds: Math.min(seconds, ceilingSeconds),
    deferred,
    note: deferred.length
      ? `${deferred.length} ${unit}(s) deferred by the ${ceilingSeconds} s ceiling (listed in deferredTests with --detail). `
      : '',
  };
}
/** Longest a group is planned to run (seconds). The run re-checks the budget between groups and sizes
 * the next one from the speed it observed and the time left, so this is only how finely it can stop,
 * never how many tests may run. */
const PREFLIGHT_GROUP_SECONDS = 30;
const SOURCE_DIRS = ['src', 'web', 'convex', 'site', 'tests', 'scripts'];

export type LocalSelection = {
  rule: string;
  budgetSeconds: number;
  secondsPerFile: number;
  basis: 'measured' | 'default';
  estimateSeconds: number;
  /** Per local tier: how many of its tests run here. Reused passes count as run. */
  tiers: { tier: string; total: number; local: number }[];
  /** Which tier each local test belongs to, so a builder sees the direct consumers and the tests
   * that failed for these paths before without guessing from one flat list (friction 0d403d25). */
  tierTests: Record<string, string[]>;
  trimmed: { tier: string; kept: number; total: number }[];
  mandatoryOverBudget: boolean;
  /** Protected tiers (mandatory, learned, direct) alone exceed the budget; they still all run. */
  protectedOverBudget?: boolean;
  /** Selected changed tests, explicit coverage and smoke that have not already passed. */
  mandatory: number;
  /** Selected mandatory, learned and direct tests that have not already passed. */
  protected?: number;
  /** Ranked local-tier files the local budget trimmed from this run, by name. */
  trimmedTests?: string[];
  /** The command that tries the ranked tiers up to the ceiling (passed files are reused). */
  rerun?: string;
  /** false: bypass the local budget and run the ranked tiers up to the ceiling. */
  trim?: false;
  /** Hard wall-time ceiling of the test phase (8dbd2683); absent in a caller-built plan (the default holds). */
  ceiling?: { seconds: number; override?: true };
  /** Changed paths whose edit is comment-only: they add only tests that read their text. */
  commentOnly?: string[];
  /** Set when the plan runs only the files a previous run stopped for time. */
  only?: 'stopped';
  deferred: number;
  /** Declared guards this change triggered: ordered early and protected from the local budget. `seconds` is the cost
   * (measured on this machine where known, else the per-file estimate). */
  guards?: { name: string; tests: string[]; seconds: number }[];
  /** The learned guard set (Automatic, manual or off) and why each file is in: p, C, r, t, saving. */
  guardSet?: GuardSetReport;
  /** Cheap tests an earlier run timed, added last with budget the ranked tiers left over. */
  filler?: number;
  deferredTo: 'pre-queue';
  summary: string;
};
type StaticSelection = {
  selected: Pick<StaticCheck, 'name' | 'command' | 'fix' | 'source' | 'typecheck'>[];
  untouched: string[];
};
export type PreflightPlan =
  | { static?: StaticSelection; status: 'unavailable'; reason: string }
  | {
      status: 'planned';
      scope: string;
      reason: string;
      tests: string[];
      estimateMinutes: number;
      command: string | null;
      deferredTests?: string[];
      /** Static checks this change triggers, run before any test; `untouched` names the rest. */
      static?: StaticSelection;
      local?: LocalSelection;
      reusedTests?: string[];
      reusedFrom?: NonNullable<PreflightReceipt['reusedFrom']>;
      deltaPaths?: string[];
      totalEstimateMinutes?: number;
      /** Set when the server projection lacked this head's paths and the pinned State manifests supplied them. */
      changedPathsFrom?: 'manifests';
      /** A project runner other than Forge's Node layout (src/project-test-runner.ts) runs the tests. */
      runner?: { label: string; command: string[]; parts?: RunnerPart[] };
      /** No test runner is declared or inferred: only static checks run, and this says why. */
      testsUnavailable?: string;
      /** Package-graph runner: each queued unit's command (cwd relative to the Lane root). */
      packageCommands?: Record<string, { cwd: string; argv: string[]; ecosystem?: string }>;
      /** Set when Forge inferred the runner: why this plan advises and never blocks landing. */
      advisory?: string;
      /** What priced the estimate: this machine's timings, the hosted check's, or the default. */
      estimateBasis?: 'measured' | 'hosted' | 'default';
      /** The packages the change affects (package-graph runner). */
      packages?: SelectedPackage[];
      /** A package-graph plan's run ceiling (8dbd2683); other plans keep it on `local`. */
      ceiling?: { seconds: number; override?: true };
      /** How many ranked tests moved to landing to fit the run ceiling. */
      ceilingDeferred?: number;
      timeSettings?: PreflightTimeSettings;
    };

const preparedEvidence = new WeakMap<PreflightPlan, PreflightEvidence>();
/** The changed paths a plan was made for, so a failing run can teach them (never printed). */
const plannedPaths = new WeakMap<PreflightPlan, string[]>();
/** The same plan, run order and evidence with a different wall-time budget (land's quick head run):
 * no re-plan, and the run still records what it ran for the guard-set learner. */
export function planWithBudget(
  plan: PreflightPlan & { status: 'planned' },
  budgetSeconds: number,
): PreflightPlan & { status: 'planned' } {
  if (!plan.local) return plan;
  if (plan.timeSettings && plan.timeSettings.budget.seconds <= budgetSeconds) return plan;
  const copy = {
    ...plan,
    local: { ...plan.local, budgetSeconds },
    ...(plan.timeSettings
      ? {
          timeSettings: {
            ...plan.timeSettings,
            budget: { seconds: budgetSeconds, source: 'quick' as const, reason: "Land's short preflight." },
          },
        }
      : {}),
  };
  const evidence = preparedEvidence.get(plan);
  if (evidence) preparedEvidence.set(copy, evidence);
  const paths = plannedPaths.get(plan);
  if (paths) plannedPaths.set(copy, paths);
  return copy;
}

/** Within a tier, the tests that failed last time run first (likely to fail again, and a failure
 * ends the run); then, in direct, wide and near, the closest consumers (`ranks`: product hops, carrier
 * fan-in, helper hops); then, among equally close ones, the more relevant (`relevance`: recent landing
 * failure, name affinity, mentions of a changed module); then the cheapest known first so more of the
 * neighbourhood fits the budget; then the selector's stable-hash order, never file names.
 * The `watch` tier keeps its evidence order. Tier membership never changes. */
export function orderByHistory<T extends { tier: string; tests: string[] }>(
  tiers: T[],
  stats: PreflightFileStats,
  fallbackMs: number,
  ranks: Record<string, readonly number[]> = {},
  relevance: Record<string, readonly number[]> = {},
): T[] {
  const cost = (test: string) => stats[test]?.ms ?? fallbackMs;
  const closer = (a: string, b: string) => {
    const left = ranks[a];
    const right = ranks[b];
    if (!left || !right) return 0;
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
    return 0;
  };
  const moreRelevant = (a: string, b: string) => {
    const left = relevance[a];
    const right = relevance[b];
    if (!left || !right) return 0;
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return right[i]! - left[i]!;
    return 0;
  };
  return tiers.map(item => {
    const index = new Map(item.tests.map((test, i) => [test, i]));
    const order = (test: string) => index.get(test) ?? 0;
    const ranked =
      item.tier === 'direct' || item.tier === 'wide' || item.tier === 'near' || item.tier === 'recent';
    const tests = [...item.tests].sort((a, b) => {
      const failed = Number(stats[b]?.failed ?? false) - Number(stats[a]?.failed ?? false);
      if (failed) return failed;
      if (item.tier === 'watch') return order(a) - order(b);
      return (ranked ? closer(a, b) || moreRelevant(a, b) : 0) || cost(a) - cost(b) || order(a) - order(b);
    });
    return { ...item, tests };
  });
}

/** Declared guards run first, in declared order, ahead of every other mandatory test: a guard pins a
 * contract the import graph cannot rank (an exact I/O count, a generated doc), so history, cost and
 * name order never put it behind other files the wall clock may stop (537e73d9). */
export function guardsFirst<T extends { tier: string; tests: string[] }>(
  tiers: T[],
  guardTests: string[],
): T[] {
  if (!guardTests.length) return tiers;
  const guards = new Set(guardTests);
  return tiers.map(item => {
    if (item.tier !== 'mandatory') return item;
    const present = new Set(item.tests);
    const first = [...guards].filter(test => present.has(test));
    return { ...item, tests: [...first, ...item.tests.filter(test => !guards.has(test))] };
  });
}

/** The wall-time budget is spent: every queued declared guard still starts (the budget never cuts a
 * guard), every other queued file is stopped and named. A run whose guards alone outlast the budget
 * runs over it by those files, never past them. */
export function budgetSpent(queue: string[], guards: ReadonlySet<string>) {
  return {
    start: queue.filter(test => guards.has(test)),
    stopped: queue.filter(test => !guards.has(test)),
  };
}

export function estimatePreflightMinutes(root: string, files: number) {
  return Math.ceil((files * preflightSecondsPerFile(root).secondsPerFile) / 60);
}

/** Selector input from the Lane checkout; absent directories are simply absent. With the saved
 * manifest (`saved`), only saved paths count: a file the save ignores (a build's generated
 * declarations, such as convex/_generated/api.d.ts after a typecheck) is not part of the head under
 * test, and must not make the inventory look incomplete (that widened a docs-only plan to the whole
 * suite). Unsaved edits are refused before any run. */
function laneFiles(root: string, saved?: Set<string>) {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && selectionSourcePath(path) && (!saved || saved.has(path)))
        files.set(path, readFileSync(join(root, path), 'utf8'));
    }
  };
  for (const dir of SOURCE_DIRS) if (existsSync(join(root, dir))) walk(dir);
  for (const file of ['package.json', 'package-lock.json'])
    if (existsSync(join(root, file))) files.set(file, readFileSync(join(root, file), 'utf8'));
  return files;
}

/** Every file path of the Lane checkout, without installed packages or hidden folders (used only
 * when no saved manifest is at hand, to resolve and select a project test runner by path). */
function lanePaths(root: string) {
  const paths: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(join(root, dir))) return;
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = dir ? posix.join(dir, entry.name) : entry.name;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) paths.push(path);
    }
  };
  walk('');
  return paths;
}

/** A plan for a project runner other than Forge's Node layout: changed tests, then tests named for a
 * changed module, each protected (the wall-time budget still stops later groups). Without a runner,
 * the static checks alone, and the reason; with no static check either, `unavailable`. */
function runnerPlan(
  root: string,
  resolved: TestRunnerResolution,
  paths: string[],
  allPaths: string[],
  packageJson: string | undefined,
  options: {
    budgetSeconds?: number | undefined;
    trim?: boolean | undefined;
    only?: string[] | undefined;
  } = {},
  graph?: () => PackageGraph,
  forgeJson?: string,
  modules?: () => ModuleGraph,
  timeSettings?: PreflightTimeSettings,
): PreflightPlan {
  const checks = planStatic(packageJson, paths, forgeJson);
  if ('reason' in checks) return { status: 'unavailable', reason: checks.reason };
  const statics =
    checks.selected.length || checks.untouched.length
      ? {
          static: {
            selected: checks.selected.map(({ name, command, fix, source, typecheck }) => ({
              name,
              command,
              ...(fix ? { fix } : {}),
              source,
              ...(typecheck ? { typecheck } : {}),
            })),
            untouched: checks.untouched,
          },
        }
      : {};
  if (resolved.status === 'unavailable') {
    // A docs-only change has nothing for a test runner to run: plan it, never report it unavailable.
    const docsOnly = paths.every(documentation);
    const reason = docsOnly
      ? `docs-only change; no test runner declared or inferred, so no test reads it here`
      : `tests unavailable: ${resolved.reason}`;
    if (!checks.selected.length && !docsOnly) return { status: 'unavailable', reason };
    const plan: PreflightPlan = {
      status: 'planned',
      scope: docsOnly ? 'docs' : 'none',
      reason: checks.selected.length ? `${reason}; static checks only` : reason,
      tests: [],
      deferredTests: [],
      ...statics,
      ...(docsOnly ? {} : { testsUnavailable: resolved.reason }),
      estimateMinutes: 0,
      command: null,
    };
    return plan;
  }
  const runner: TestRunner = resolved.runner;
  const only = options.only ? new Set(options.only) : null;
  const keep = (tests: string[]) => (only ? tests.filter(test => only.has(test)) : tests);
  const ceiling = runCeiling(options.budgetSeconds, timeSettings);
  if (runner.layout === 'packages') {
    // A wrapper script the tree commits (gradlew, mvnw) runs only when the project declares it.
    let wrappers: ReturnType<typeof declaredPreflight>;
    try {
      wrappers = declaredPreflight('wrappers', packageJson, forgeJson);
    } catch (error) {
      return { status: 'unavailable', reason: (error as Error).message.slice(0, 300) };
    }
    if (wrappers && typeof wrappers.value !== 'boolean')
      return { status: 'unavailable', reason: `${wrappers.label} is true or false` };
    const plan = packagePlan(
      root,
      runner,
      paths,
      graph!(),
      statics,
      keep,
      ceiling,
      modules,
      declaredPackageFlags(forgeJson),
      wrappers?.value === true,
    );
    if (plan.status === 'planned' && timeSettings) plan.timeSettings = timeSettings;
    return plan;
  }
  const selection = runnerSelection(runner, allPaths, paths, preflightImports(root, runner, allPaths, paths));
  // Tests that failed in a landing check or preflight while these paths changed run again, as for
  // Forge's own layout: the runner's globs decide which learned names are still test files here.
  const present = new Set(selection.available);
  const taken = new Set(selection.tests);
  const learned = learnedTests(root, paths, undefined, test => present.has(test) && !taken.has(test));
  // Test files inside the packages the change affects, when the manifests place it.
  const inPackages = graph
    ? packageRunnerTests(runner, graph(), allPaths, paths)
    : { tests: [], reason: null };
  // Declared guards (forge.json or package.json) join the mandatory tier for every runner, as in
  // Forge's own layout: a guard naming a test the project lacks fails the plan, never skips.
  const every = new Set(allPaths);
  const guards = selectGuards(
    preflightGuards(packageJson, path => every.has(path), forgeJson),
    paths,
  ).selected;
  const timing = preflightSecondsPerFile(root);
  const stats = preflightFileStats(root);
  const secondsFor = (test: string) => (stats[test] ? stats[test].ms / 1000 : timing.secondsPerFile);
  const budgetSeconds =
    timeSettings?.budget.seconds ?? options.budgetSeconds ?? PREFLIGHT_LOCAL_BUDGET_SECONDS;
  const declaredTests = new Set(guards.filter(guard => !guard.demote).flatMap(guard => guard.tests));
  // Demoted guards (`demote: true`) rank below the learned set and reserve none of its room.
  const demotedTests = guards
    .filter(guard => guard.demote)
    .flatMap(guard => guard.tests)
    .filter(test => !declaredTests.has(test));
  // The learned guard set joins the declared guards for every runner (13ea93bf), inside what they and
  // the change's own tests leave of the budget.
  const guardSet = only
    ? undefined
    : planGuardSet(
        root,
        { packageJson, forgeJson },
        {
          isTest: test => present.has(test),
          localSeconds: test => (stats[test] ? stats[test].ms / 1000 : undefined),
          defaultSeconds: timing.secondsPerFile,
          capSeconds: learnedGuardCap(
            Math.min(budgetSeconds, timeSettings?.ceiling.seconds ?? Infinity),
            [...declaredTests, ...selection.changedTests],
            secondsFor,
          ),
        },
      );
  const learnedGuards = (guardSet?.tests ?? []).filter(test => !declaredTests.has(test));
  const mandatory = [
    ...new Set([...declaredTests, ...learnedGuards, ...selection.changedTests, ...demotedTests]),
  ];
  const named = new Set([...mandatory, ...selection.namedTests, ...learned]);
  const tiers = [
    { tier: 'mandatory', tests: keep(mandatory) },
    { tier: 'learned', tests: keep(learned.filter(test => !mandatory.includes(test))) },
    {
      tier: 'direct',
      tests: keep(
        orderRunnerTests(
          selection.namedTests.filter(test => !mandatory.includes(test)),
          paths,
        ),
      ),
    },
    {
      tier: 'package',
      tests: keep(
        orderRunnerTests(
          inPackages.tests.filter(test => !named.has(test)),
          paths,
        ),
      ),
    },
  ].filter(item => item.tests.length);
  if (inPackages.reason) selection.reason = `${selection.reason}; ${inPackages.reason}`;
  const ranked = tiers.flatMap(item => item.tests);
  const { tests, seconds, deferred, note } = fitRunCeiling(ranked, ceiling.seconds, secondsFor);
  const selected = new Set(tests);
  const tierTests = tiers.map(item => ({ ...item, local: item.tests.filter(test => selected.has(test)) }));
  const trim = options.trim !== false;
  const label = runnerLabel(runner);
  const rule = `${label}: changed test files, learned failures, then tests named for a changed module (closest folder first) or reaching it through imports, then tests in affected packages`;
  const reason = learned.length
    ? `${selection.reason}; ${learned.length} re-run because they failed while these paths changed before`
    : selection.reason;
  const local: LocalSelection = {
    rule,
    budgetSeconds,
    secondsPerFile: timing.secondsPerFile,
    basis: timing.basis,
    estimateSeconds: seconds,
    tiers: tierTests.map(item => ({ tier: item.tier, total: item.tests.length, local: item.local.length })),
    tierTests: Object.fromEntries(tierTests.map(item => [item.tier, item.local])),
    trimmed: [],
    mandatoryOverBudget: false,
    mandatory: tierTests[0]?.tier === 'mandatory' ? tierTests[0].local.length : 0,
    protected: tests.length,
    deferred: deferred.length,
    ...(trim ? {} : { trim: false as const }),
    ceiling,
    ...(only ? { only: 'stopped' as const } : {}),
    deferredTo: 'pre-queue',
    summary: `${note}Local rule: ${rule}. ${reason}.${guardSet ? ` ${guardSetLine(guardSet)}` : ''}`,
    ...(guards.length || learnedGuards.length
      ? {
          guards: [
            ...guards,
            ...(learnedGuards.length ? [{ name: LEARNED_GUARD_NAME, tests: learnedGuards }] : []),
          ].map(guard => ({
            name: guard.name,
            tests: guard.tests,
            seconds: Math.round(guard.tests.reduce((sum, test) => sum + secondsFor(test), 0) * 10) / 10,
          })),
        }
      : {}),
    ...(guardSet ? { guardSet } : {}),
  };
  const plan: PreflightPlan = {
    status: 'planned',
    scope: selection.scope === 'none' && learned.length ? 'scoped' : selection.scope,
    reason: note + reason,
    tests,
    deferredTests: deferred,
    ...(deferred.length ? { ceilingDeferred: deferred.length } : {}),
    ...statics,
    local,
    ...(timeSettings ? { timeSettings } : {}),
    reusedTests: [],
    estimateMinutes: Math.ceil(seconds / 60),
    totalEstimateMinutes: estimatePreflightMinutes(root, ranked.length),
    runner: { label, command: runner.command, ...(runner.parts ? { parts: runner.parts } : {}) },
    ...(runner.source === 'dependency' ? { advisory: INFERRED_RUNNER_ADVISORY } : {}),
    command: tests.length
      ? runnerCommand(runner, tests)
          .map(arg => (/^[\w./=-]+$/.test(arg) ? arg : shellQuote(arg)))
          .join(' ')
      : null,
  };
  plannedPaths.set(plan, paths);
  return plan;
}

const shellWord = (value: string) => (/^[A-Za-z0-9_./=@:,{}-]+$/.test(value) ? value : shellQuote(value));
/** Build-tool wrapper scripts a repository commits, and the tool on PATH that runs instead. */
const TREE_WRAPPERS: Record<string, string> = { './gradlew': 'gradle', './mvnw': 'mvn' };
/** Local preflight runs a wrapper the tree commits (gradlew, mvnw) only when the project declares
 * `preflight.wrappers: true`; otherwise the build tool on PATH runs, and the plan names the wrapper. */
function treeWrapperRule(selection: ReturnType<typeof packageTestSelection>, declared: boolean) {
  const replaced = new Set<string>();
  if (declared) return { ...selection, replacedWrappers: [] };
  const commands = selection.commands.map(command => {
    const tool = TREE_WRAPPERS[command.argv[0] ?? ''];
    if (!tool) return command;
    replaced.add(command.argv[0]!);
    return { ...command, argv: [tool, ...command.argv.slice(1)] };
  });
  if (!replaced.size) return { ...selection, replacedWrappers: [] };
  return {
    ...selection,
    commands,
    units: commands.map(packageCommandUnit),
    replacedWrappers: [...replaced].sort(),
  };
}

/** A package-graph runner's plan: one queued unit per ecosystem command (src/package-graph.ts). */
function packagePlan(
  root: string,
  runner: TestRunner,
  paths: string[],
  graph: PackageGraph,
  statics: Partial<Pick<PreflightPlan & { status: 'planned' }, 'static'>>,
  keep: (tests: string[]) => string[],
  ceiling: ReturnType<typeof runCeiling>,
  modules?: () => ModuleGraph,
  flags?: PackageFlagSource | { refusal: string },
  treeWrappers = false,
): PreflightPlan {
  const selection = treeWrapperRule(packageTestSelection(graph, paths, modules, flags), treeWrappers);
  const units = keep(selection.units);
  const estimate = packageEstimate(root, units);
  const { tests, seconds, deferred, note } = fitRunCeiling(
    units,
    ceiling.seconds,
    estimate.secondsFor,
    'package command',
  );
  const commands = new Map(selection.units.map((unit, index) => [unit, selection.commands[index]!]));
  const selected = tests.map(unit => commands.get(unit)!);
  const label = runnerLabel(runner);
  const plan: PreflightPlan = {
    status: 'planned',
    scope: selection.scope,
    reason: note + selection.reason,
    tests,
    deferredTests: deferred,
    ...(deferred.length ? { ceilingDeferred: deferred.length } : {}),
    ceiling,
    ...statics,
    reusedTests: [],
    estimateMinutes: Math.ceil(seconds / 60),
    totalEstimateMinutes: Math.ceil(estimate.seconds / 60),
    estimateBasis: estimate.basis,
    runner: { label, command: [] },
    advisory: selection.replacedWrappers.length
      ? `${INFERRED_RUNNER_ADVISORY} ${selection.replacedWrappers.join(' and ')} in the tree ${selection.replacedWrappers.length > 1 ? 'are' : 'is'} not declared, so the build tool on PATH runs instead; declare "preflight": {"wrappers": true} in forge.json to run the wrapper.`
      : INFERRED_RUNNER_ADVISORY,
    packageCommands: Object.fromEntries(
      selected.map(({ cwd, argv, ecosystem }, index) => [tests[index]!, { cwd, argv, ecosystem }]),
    ),
    packages: selection.packages,
    command: selected.length
      ? selected.map(command => packageCommandLine(command, shellWord)).join(' && ')
      : null,
  };
  plannedPaths.set(plan, paths);
  return plan;
}

/** Tests reaching the change through a static JS/TS import graph of the Lane (any repository; Forge's
 * own layout has its own selector). Reads the Lane's code files, runs none; a docs-only change, a
 * repository without code or one over the graph bounds keeps path-only selection. */
function preflightImports(root: string, runner: TestRunner, allPaths: string[], paths: string[]) {
  if (paths.every(documentation) || !paths.some(path => CODE_FILE.test(path))) return undefined;
  const graph = jsImportGraph(allPaths, path => laneText(root, path));
  if ('error' in graph) return undefined;
  return importGraphTests(
    graph,
    allPaths.filter(path => runnerTestPath(runner, path)),
    paths,
  );
}

/** Price each package command at its smoothed local time, an equal share of the hosted median
 * for the untimed commands, or the cold per-command default. */
function packageEstimate(root: string, units: string[]) {
  const stats = preflightFileStats(root);
  const unknown = units.filter(unit => !stats[unit]?.ms).length;
  const hosted = unknown ? hostedCheckSeconds(root) : null;
  const fallback = hosted === null ? PREFLIGHT_SECONDS_PER_PACKAGE_COMMAND : hosted / unknown;
  const secondsFor = (unit: string) => (stats[unit]?.ms ? stats[unit].ms / 1000 : fallback);
  const seconds =
    units.reduce((sum, unit) => sum + (stats[unit]?.ms ?? 0) / 1000, 0) +
    (hosted ?? unknown * PREFLIGHT_SECONDS_PER_PACKAGE_COMMAND);
  const basis = !unknown ? 'measured' : hosted !== null ? 'hosted' : 'default';
  return { seconds, secondsFor, basis } as const;
}

/** One saved text file outside the selector inventory (a shell script, a workflow), for comparison. */
function laneText(root: string, path: string) {
  if (!safeRelative(path)) return undefined;
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch {
    return undefined;
  }
}

const testArgs = (root: string, tests: string[]) => {
  // An empty list would make `node --test` discover and run the whole suite (friction e4ce373a).
  if (!tests.length) throw new Error('No test files selected; refusing to run the default suite.');
  return [
    ...(existsSync(join(root, 'tests/check-runtime.mjs')) ? ['--import', './tests/check-runtime.mjs'] : []),
    '--test',
    '--test-concurrency=1',
    ...tests,
  ];
};

/** The landing check's shared selector over the saved changes (base to head). Unknown paths mean
 * no plan: missing observations never block a landing. */
/** Learned guards get only what declared guards and the change's own tests leave of the budget. */
const learnedGuardCap = (budget: number, reserved: string[], secondsFor: (test: string) => number) =>
  Math.max(0, budget - [...new Set(reserved)].reduce((sum, test) => sum + secondsFor(test), 0));

export function preflightPlan(...args: Parameters<typeof planTests>): PreflightPlan {
  const plan = planTests(...args);
  if (plan.status !== 'unavailable') return plan;
  // Static commands are independent of test selection. Unknown changed paths conservatively
  // trigger every declaration; a failed test inventory must not suppress formatting or lint.
  const [root, changed] = args;
  try {
    const checks = staticChecks(laneText(root, 'package.json'), laneText(root, FORGE_CONFIG_FILE));
    const selection = changed?.complete
      ? selectStaticChecks(checks, changed.paths)
      : { selected: checks, untouched: [] };
    return { ...plan, static: selection };
  } catch {
    return plan; // Keep the existing unavailable result for malformed project configuration.
  }
}

function planTests(
  root: string,
  changed: { paths: string[]; complete: boolean; source?: 'projection' | 'manifests' } | undefined,
  context?: { laneId: string; files: NativeFile[]; base?: string },
  options?: {
    budgetSeconds?: number | undefined;
    trim?: boolean | undefined;
    /** Run exactly these test files (the files a previous run stopped for time). */
    only?: string[] | undefined;
  },
): PreflightPlan {
  if (!changed?.complete)
    return {
      status: 'unavailable',
      reason: 'saved changed paths are unavailable',
    };
  if (!changed.paths.length)
    return {
      status: 'planned',
      scope: 'none',
      reason: 'no saved changes',
      tests: [],
      estimateMinutes: 0,
      command: null,
    };
  try {
    const files = laneFiles(root, context && new Set(context.files.map(file => file.path)));
    // Forge's Node layout (tests/*.test.mjs) keeps the import-graph selector below; any other runner
    // selects by path, and a project with no runner gets static checks only, never Forge's layout.
    const allPaths = () => (context ? context.files.map(file => file.path) : lanePaths(root));
    // The manifest package graph, built at most once per plan and cached per head (src/package-graph.ts).
    let built: PackageGraph | undefined;
    const graph = () =>
      (built ??= packageGraphFor(context && packageGraphKey(context.files), allPaths(), path =>
        laneText(root, path),
      ));
    // The module graph (imports) of the same head, for package-graph runners only; facts are cached
    // per blob, so a later save re-reads only changed sources (src/module-graph.ts).
    const modules = () =>
      moduleGraphFor(context && moduleGraphKey(context.files), {
        paths: allPaths(),
        read: path => laneText(root, path),
        blobs: context && new Map(context.files.map(file => [file.path, file.blob])),
      });
    // The language-neutral project file, read once per plan (src/project-config.ts).
    const forgeJson = laneText(root, FORGE_CONFIG_FILE);
    const packageJson = files.get('package.json');
    const timeSettings = preflightTimeSettings({ packageJson, forgeJson }, options?.budgetSeconds);
    let resolved: TestRunnerResolution;
    try {
      resolved = projectTestRunner(packageJson, allPaths, {
        forgeJson,
        packages: graph,
      });
    } catch (error) {
      return { status: 'unavailable', reason: (error as Error).message.slice(0, 300) };
    }
    if (resolved.status === 'unavailable' || resolved.runner.layout !== 'forge-node') {
      const plan = runnerPlan(
        root,
        resolved,
        changed.paths,
        allPaths(),
        packageJson,
        options,
        graph,
        forgeJson,
        modules,
        timeSettings,
      );
      if (plan.status === 'planned' && changed.source === 'manifests') plan.changedPathsFrom = 'manifests';
      return plan;
    }
    const timing = preflightSecondsPerFile(root);
    const stats = preflightFileStats(root);
    const budgetSeconds =
      timeSettings?.budget.seconds ?? options?.budgetSeconds ?? PREFLIGHT_LOCAL_BUDGET_SECONDS;
    const ceiling = runCeiling(options?.budgetSeconds, timeSettings);
    const trim = options?.trim !== false;
    const secondsFor = (test: string) => (stats[test] ? stats[test].ms / 1000 : timing.secondsPerFile);
    const declaredGuards = preflightGuards(packageJson, path => files.has(path), forgeJson);
    const guards = selectGuards(declaredGuards, changed.paths);
    const declaredTests = new Set(
      guards.selected.filter(guard => !guard.demote).flatMap(guard => guard.tests),
    );
    // Demoted guards (`demote: true`) stay mandatory but rank below the learned set, never trimmed from
    // the plan, stopped by the wall clock, and they reserve none of the learned set's room.
    const demotedTests = guards.selected
      .filter(guard => guard.demote)
      .flatMap(guard => guard.tests)
      .filter(test => !declaredTests.has(test));
    const isTest = (test: string) => files.has(test) && runnerTestPath(resolved.runner, test);
    // The learned guard set runs first with the declared guards (13ea93bf), inside what they and the
    // change's own tests leave of the budget, so it never pushes the change's tests out.
    const guardSet = options?.only
      ? undefined
      : planGuardSet(
          root,
          { packageJson, forgeJson },
          {
            isTest,
            localSeconds: test => (stats[test] ? stats[test].ms / 1000 : undefined),
            defaultSeconds: timing.secondsPerFile,
            capSeconds: learnedGuardCap(
              Math.min(budgetSeconds, timeSettings?.ceiling.seconds ?? Infinity),
              [...declaredTests, ...changed.paths.filter(isTest)],
              secondsFor,
            ),
          },
        );
    const learnedGuards = (guardSet?.tests ?? []).filter(test => !declaredTests.has(test));
    const guardTests = [...declaredTests, ...learnedGuards];
    // The base and saved text of each changed source, from the base bytes on this machine (else nothing,
    // which only costs precision). Comment-only edits (an SPDX header, a reworded comment) run the same
    // program: they rank only the tests that read the file. The change also tells what it took out of a
    // file (a literal an old test still asserts) and which exports it altered (consumers import them by name).
    const sources = context?.base
      ? changedSources(
          root,
          context.base,
          context.files,
          changed.paths,
          path => files.get(path) ?? laneText(root, path),
        )
      : new Map<string, { before: string; after: string }>();
    const commentOnly = [...sources]
      .filter(([path, { before, after }]) => commentOnlyEdit(path, before, after))
      .map(([path]) => path);
    // A changed test that names a cost move ("Writes N -> M") is a cost pin edit: it is a changed test, so
    // it is required and starts first; the plan says so instead of the landing check teaching it.
    const costTests = [...sources]
      .filter(([path, { before, after }]) => isTest(path) && costCommentAdded(before, after))
      .map(([path]) => path)
      .sort();
    const productSources = [...sources].filter(([path]) => !isTest(path));
    const removedNames = productSources.flatMap(([path, { before, after }]) =>
      removedNamesOf(path, before, after),
    );
    const alteredExports = new Map(
      productSources
        .map(([path, { before, after }]) => [path, alteredSurface(path, before, after)] as [string, string[]])
        .filter(([, names]) => names.length),
    );
    const learnedForPaths = learnedTests(root, changed.paths, undefined, test =>
      runnerTestPath(resolved.runner, test),
    );
    const saved = context && savedInventory(context.files, files);
    if (context && saved)
      pinImportFacts(
        files,
        new Map(context.files.map(file => [file.path, file.blob])),
        join(retainedRootSibling(root, '.forge-client'), 'agent', 'preflight', 'selector-facts'),
      );
    const selection = selectPreflightTests({
      files,
      paths: changed.paths,
      guards: [...guardTests, ...demotedTests],
      removedNames,
      changedExports: alteredExports,
      learned: learnedForPaths,
      recent: recentFailedTests(root),
      ...(commentOnly.length ? { commentOnly } : {}),
      // Direct tests of the most specific changed modules are protected while they fit the budget.
      ...(trim ? { hubBudget: { seconds: budgetSeconds, secondsFor } } : {}),
    });
    selection.tiers = guardsFirst(
      orderByHistory(
        selection.tiers,
        stats,
        timing.secondsPerFile * 1000,
        selection.ranks,
        selection.relevance,
      ),
      guardTests,
    );
    // Protected tiers run fast repo-wide guards and fast files with a learned saving (10 s always, up to
    // 30 s while the later protected steps fit), guards, the change's own tests, the tests that load a
    // changed module (most specific module first, failed-before loaders first, while they fit; Item
    // 13ea93bf), files that failed before (learned tier, failed for these paths or last run here), fast
    // files the room left out, named tests, then the rest by learned saving per second, smoke and
    // explicit coverage last (Item 5dcfce75 fixes 3, 4).
    // Saving is the 13ea93bf formula from the project's own record: p = failures of the file in the
    // window's landing outcomes, C and r from the server's candidates; 0 (keep the order) without them.
    const candidates = cachedGuardCandidates(root);
    const serverFailures = new Map((candidates?.files ?? []).map(item => [item.file, item.failures]));
    const localFailures = recordedFailures(root);
    const outcomes = candidates?.outcomes ?? 0;
    const perFailure = outcomes && candidates ? candidates.C / Math.max(1, candidates.r) / outcomes : 0;
    selection.tests = protectedRunOrder({
      tiers: selection.tiers,
      isProtected: tier => protectedTiers.has(tier),
      guards: new Set(guardTests),
      treeGuards: selection.treeGuards ?? [],
      pins: selection.pins ?? [],
      firstPins: selection.pinsFirst ?? [],
      leadTests: selection.leadTests ?? [],
      ownTests: changed.paths.filter(isTest),
      specificModules: selection.specificModules ?? [],
      // Files that failed for these paths (also when another tier holds them) or in this machine's last run.
      failing: new Set([...learnedForPaths, ...Object.keys(stats).filter(test => stats[test]!.failed)]),
      budgetSeconds,
      measuredSeconds: test => (stats[test] ? stats[test].ms / 1000 : undefined),
      secondsFor,
      failureSeconds: test =>
        Math.min(outcomes, Math.max(serverFailures.get(test) ?? 0, localFailures.get(test) ?? 0)) *
        perFailure,
    });
    let tests = [...new Set(selection.tests)];
    let reusedTests: string[] = [];
    let delta: string[] | undefined;
    let reusedFrom: PreflightReceipt['reusedFrom'];
    if (context && !saved) {
      // Sparse/mismatched local bytes cannot prove that an unseen consumer is independent.
      // Preserve local execution, put the complete manifest test inventory on the runner.
      const all = new Set([
        ...selection.tests,
        ...selection.deferredTests,
        ...context.files.map(file => file.path).filter(path => /^tests\/[^/]+\.test\.mjs$/.test(path)),
      ]);
      selection.scope = 'full';
      selection.deferredTests = [...all].filter(test => !selection.tests.includes(test)).sort();
      // First, so the printed plan says why the scope is full before any rule text.
      selection.reason = `Incomplete local source inventory (a saved source file is missing or differs here): full landing coverage, no receipt reuse; ${selection.reason}`;
    }
    if (context && saved) {
      const receipt = readPreflightReceipt(root, context.laneId);
      const previous =
        receipt?.tree && receipt.evidence
          ? readPreflightEvidence(root, receipt.evidence, receipt.tree)
          : null;
      if (previous) {
        delta = deltaPaths(previous.files, context.files);
        // Both inventories matter: removing an import/consumer must not erase its
        // old dependency proof. Full/unknown on either side invalidates reuse.
        const impacted = new Set<string>();
        for (const [inventory, manifest] of [
          [new Map(previous.inventory), previous.files],
          [files, context.files],
        ] as const) {
          // A newly added file has no old consumers; a deleted file's consumers
          // come from the old graph. Do not turn that absence into a full fallback.
          const present = new Set(manifest.map(file => file.path));
          const paths = delta.filter(path => present.has(path));
          if (!paths.length) continue;
          for (const test of selectTests({ files: inventory, paths }).tests) impacted.add(test);
        }
        // A guard whose inputs the delta touches runs again: its passes are not reused across them.
        for (const guard of selectGuards(declaredGuards, delta).selected)
          for (const test of guard.tests) impacted.add(test);
        // Learned guards are the tests the import graph misses: their passes are never reused.
        for (const test of learnedGuards) impacted.add(test);
        const covered = new Set(previous.covered);
        reusedTests = tests.filter(test => covered.has(test) && !impacted.has(test));
        tests = tests.filter(test => !reusedTests.includes(test));
        if (reusedTests.length && receipt?.tree && receipt.evidence)
          reusedFrom = {
            head: receipt.head,
            tree: receipt.tree,
            evidence: receipt.evidence,
          };
      }
    }
    // Tiers still hold reused passes: those cost nothing here, so they never consume the budget.
    const only = options?.only ? new Set(options.only) : null;
    const fit = fitPreflightBudget({
      tiers: selection.tiers,
      budgetSeconds: trim && !only ? budgetSeconds : Infinity,
      secondsPerFile: timing.secondsPerFile,
      secondsFor,
      free: new Set(reusedTests),
    });
    const kept = new Set(fit.tests);
    const cut = fit.trimmed.flatMap(item => item.deferred);
    tests = tests.filter(test => kept.has(test));
    // A rerun of stopped files runs exactly those (that still exist and have no reusable pass), in
    // plan order; everything else this plan would run stays as it is in coverage.
    if (only) {
      const order = new Map(selection.tests.map((test, i) => [test, i]));
      const named = [...only].filter(test => files.has(test) && !reusedTests.includes(test));
      named.sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity) || (a < b ? -1 : 1));
      selection.deferredTests = [...new Set([...selection.deferredTests, ...tests])].filter(
        test => !only.has(test),
      );
      tests = named;
    }
    // Budget the ranked tiers did not use goes to the cheapest ranked consumers the budget cut that an
    // earlier run timed. Unranked coverage (computed paths, by-name closures, far chains) never fills
    // it: those tests are not evidence about this change (friction 425ecd74). Tests never timed here are
    // not guessed at, and these run last, after every ranked test.
    const pool = (trim && !only ? cut : []).filter(test => stats[test] && !reusedTests.includes(test));
    pool.sort((a, b) => stats[a]!.ms - stats[b]!.ms || (a < b ? -1 : 1));
    let leftover = budgetSeconds - fit.estimateSeconds;
    const filler: string[] = [];
    for (const test of pool) {
      const seconds = stats[test]!.ms / 1000;
      if (seconds > leftover) break;
      leftover -= seconds;
      filler.push(test);
    }
    const capped = fitRunCeiling([...tests, ...filler], ceiling.seconds, secondsFor);
    tests = capped.tests;
    const filled = new Set(filler);
    const deferredTests = [
      ...new Set([...selection.deferredTests, ...cut.filter(test => !filled.has(test)), ...capped.deferred]),
    ].sort();
    const complete = tests.length + reusedTests.length + deferredTests.length;
    const selected = new Set([...tests, ...reusedTests]);
    const mandatory = new Set(selection.tiers[0]?.tests ?? []);
    const guarded = new Set(
      selection.tiers.filter(item => protectedTiers.has(item.tier)).flatMap(item => item.tests),
    );
    const local = localSelection({
      selection,
      fit,
      timing,
      budgetSeconds,
      kept: selected,
      mandatory: tests.filter(test => mandatory.has(test)).length,
      protected: tests.filter(test => guarded.has(test)).length,
      deferred: deferredTests.length,
      ceiling,
      ceilingNote: capped.note,
      estimateSeconds: Math.ceil(capped.seconds),
      guards: [
        ...guards.selected
          .filter(guard => !guard.demote)
          .map(guard => ({
            name: guard.name,
            tests: guard.tests,
            seconds: Math.round(guard.tests.reduce((sum, test) => sum + secondsFor(test), 0) * 10) / 10,
          })),
        ...(selection.pins?.length
          ? [
              {
                name: CONTRACT_PINS_NAME,
                tests: selection.pins,
                seconds:
                  Math.round(selection.pins.reduce((sum, test) => sum + secondsFor(test), 0) * 10) / 10,
              },
            ]
          : []),
        ...(learnedGuards.length
          ? [
              {
                name: LEARNED_GUARD_NAME,
                tests: learnedGuards,
                seconds: Math.round(learnedGuards.reduce((sum, test) => sum + secondsFor(test), 0) * 10) / 10,
              },
            ]
          : []),
      ],
      ...(guardSet ? { guardSet } : {}),
      filler: filler.filter(test => selected.has(test)).length,
      trimmedTests: only ? [] : cut.filter(test => !filled.has(test)).sort(),
      rerun: context ? rerunCommand(root, cut.filter(test => !filled.has(test)).sort()) : undefined,
      trim,
      commentOnly,
      costTests,
      only: !!only,
    });
    const checks = planStatic(files.get('package.json'), changed.paths, forgeJson);
    if ('reason' in checks) return { status: 'unavailable', reason: checks.reason };
    const plan: PreflightPlan = {
      status: 'planned',
      scope: selection.scope,
      reason: capped.note + selection.reason,
      tests,
      deferredTests,
      ...(capped.deferred.length ? { ceilingDeferred: capped.deferred.length } : {}),
      ...(checks.selected.length || checks.untouched.length
        ? {
            static: {
              selected: checks.selected.map(({ name, command, fix, source, typecheck }) => ({
                name,
                command,
                ...(fix ? { fix } : {}),
                source,
                ...(typecheck ? { typecheck } : {}),
              })),
              untouched: checks.untouched,
            },
          }
        : {}),
      ...(selection.tiers.length ? { local } : tests.length || capped.deferred.length ? { ceiling } : {}),
      ...(timeSettings ? { timeSettings } : {}),
      reusedTests,
      ...(reusedFrom ? { reusedFrom } : {}),
      ...(delta ? { deltaPaths: delta } : {}),
      ...(changed.source === 'manifests' ? { changedPathsFrom: 'manifests' as const } : {}),
      estimateMinutes: Math.ceil(capped.seconds / 60),
      totalEstimateMinutes: estimatePreflightMinutes(root, complete),
      command: tests.length
        ? ['node', ...testArgs(root, tests)]
            .map(arg => (/^[\w./=-]+$/.test(arg) ? arg : shellQuote(arg)))
            .join(' ')
        : null,
    };
    plannedPaths.set(plan, changed.paths);
    if (context && saved)
      preparedEvidence.set(plan, {
        definition: preflightDefinition,
        files: context.files,
        inventory: [...files],
        covered: [...tests, ...reusedTests].sort(),
      });
    return plan;
  } catch (error) {
    return {
      status: 'unavailable',
      reason: `test selection failed: ${(error as Error).message.slice(0, 200)}`,
    };
  }
}

/** A cost comment (`Writes 98 -> 99`, `Reads 3 -> 4`) on a line the edit added. */
const COST_COMMENT = /(?:\/\/|\/\*).*\b(?:Writes|Reads|Calls)\s+\d+\s*(?:->|→)\s*\d+/;
export function costCommentAdded(before: string, after: string) {
  const had = new Set(before.split('\n'));
  return after.split('\n').some(line => !had.has(line) && COST_COMMENT.test(line));
}

/** The guard entry the learned set adds to `local.guards`. */
const LEARNED_GUARD_NAME = 'learned guard set';
/** The guard entry the contract pins add to `local.guards`: budget, cost, registration and contract tests
 * the change reaches, promoted into the protected tier (at most CONTRACT_PIN_SECONDS). */
const CONTRACT_PINS_NAME = 'contract pins this change reaches';
/** The guard set's reason and, per file, why it is in: p x C / r - t = saving (seconds). */
function guardSetLine(report: GuardSetReport) {
  const why = report.files
    .filter(file => report.tests.includes(file.file))
    .map(file =>
      file.pinned && !file.failures
        ? `${file.file} (pinned)`
        : `${file.file} (${file.failures} landing failures, p ${file.p} x C ${file.C} s / r ${file.r} - t ${file.t} s = +${file.saving} s${file.pinned ? ', pinned' : ''})`,
    );
  return `${report.reason}${why.length ? ` First: ${why.join('; ')}.` : ''}`;
}

/** One line naming what a run will do: scope, file counts, budget, estimate, static checks and why. */
export function planLine(plan: PreflightPlan & { status: 'planned' }) {
  const deferred = plan.deferredTests?.length ?? 0;
  const reused = plan.reusedTests?.length ?? 0;
  const ceiling = planCeiling(plan);
  const budget = `${
    plan.local
      ? plan.local.trim === false
        ? 'no time budget (trim:false)'
        : `${plan.local.budgetSeconds} s budget`
      : 'no time budget'
  }, ${ceiling.seconds} s ceiling${ceiling.override ? ' (budgetSeconds override)' : ''}`;
  const checks = plan.static?.selected.length
    ? ` Static first: ${plan.static.selected.map(check => check.name).join(', ')}.`
    : '';
  // A caller-built plan may carry no reason; the line still prints.
  const reason = plan.reason ?? '';
  const why = reason.length > PLAN_REASON_CHARS ? `${reason.slice(0, PLAN_REASON_CHARS)}…` : reason;
  const settings = plan.timeSettings
    ? ` ${plan.local && plan.local.trim !== false ? `Budget: ${plan.timeSettings.budget.reason} ` : ''}Ceiling: ${plan.timeSettings.ceiling.reason}`
    : '';
  return (
    `preflight plan: scope ${plan.scope}, ${plan.tests.length} test file(s) here` +
    (reused ? `, ${reused} passed before (reused)` : '') +
    `, ${deferred} deferred to the pre-queue check; ${budget}, about ${plan.estimateMinutes} min.` +
    (plan.runner ? ` Runner: ${plan.runner.label}.` : '') +
    checks +
    (why ? ` Why: ${why}` : '') +
    settings
  );
}
const PLAN_REASON_CHARS = 400;

/** Whether a path lies inside a Forge checkout (a Lane or the main folder): its own or an ancestor's
 * `.forge` marker makes Forge resolve a fixture made there to that live checkout. */
export function insideForgeCheckout(path: string): boolean {
  for (let selected = path; ;) {
    if (
      existsSync(join(selected, '.forge/hosted-lane.json')) ||
      existsSync(join(selected, '.forge/native.json')) ||
      existsSync(join(selected, '.forge/hosted-main.json'))
    )
      return true;
    const parent = dirname(selected);
    if (parent === selected) return false;
    selected = parent;
  }
}
/** The directories test temp files may go under: `candidate` when no Forge checkout contains it, else
 * each system temp root that none does, in order (empty when there is none). */
export function tmpdirsOutsideCheckout(
  candidate: string,
  fallbacks: string[] = ['/tmp', '/var/tmp'],
): string[] {
  if (!insideForgeCheckout(candidate)) return [candidate];
  return fallbacks.filter(path => existsSync(path) && !insideForgeCheckout(path));
}
/** A fresh preflight scratch directory in the first of `roots` that accepts one. */
function scratchIn(roots: string[], prefix: string): string | undefined {
  for (const root of roots)
    try {
      return mkdtempSync(join(root, prefix));
    } catch {
      // Read-only or full: try the next root.
    }
  return undefined;
}

/** What to run for the test files a preflight left out. A short list is named for one runnable
 * command in the Lane folder; a long one is not worth a local run: the landing check is the full
 * run. Never `trim:false` (that runs the whole deferred plan locally, minutes over the budget). */
const RERUN_NAMED_FILES = 8;
const rerunCommand = (root: string, files: string[]) =>
  files.length && files.length <= RERUN_NAMED_FILES
    ? `cd ${shellQuote(root)} && nforge heavy node ${
        existsSync(join(root, 'tests/check-runtime.mjs')) ? '--import ./tests/check-runtime.mjs ' : ''
      }--test ${files.map(shellQuote).join(' ')}`
    : 'nothing to run here: the landing check is the full run and runs them';
/** Runs exactly the files the last run stopped for time (under the same wall-time budget). */
const stoppedCommand = (root: string, laneId: string) =>
  `nforge agent ${shellQuote(root)} preflight ${shellQuote(JSON.stringify({ laneId, retry: true }))}`;

/** What judges a static failure (src/agent-preflight-static.ts): the saved changed paths and, in a
 * hosted Lane, each one's base bytes from the base State manifest and objects already on this machine
 * (no server call). Elsewhere, or when they are not cached, there is no base copy to compare with. */
function staticScope(root: string, changed: string[] | null, comparisonBase?: string): StaticScope {
  let marker: ReturnType<typeof readHostedLaneCheckout> = null;
  try {
    marker = readHostedLaneCheckout(root);
  } catch {
    /* Not a hosted Lane: no base copy. */
  }
  // A folder for checks that keep a cache, and (with CHANGED) hints so they do less on a small change.
  const cache = join(clientCacheRoot(root), 'agent', 'preflight', 'static-cache');
  if (!marker || !changed) return { changed, cache };
  const files = baseStateFiles(root, comparisonBase ?? marker.selection.base.head);
  if (!files) return { changed, cache };
  const base = new Map(files.map(file => [file.path, file]));
  const saved = marker.state.files;
  return {
    changed,
    cache,
    comparisonPaths: () =>
      reviewPaths(files, saved)
        .filter(item => item.status !== 'unchanged')
        .map(item => item.path),
    hasBaseFile: path => base.has(path),
    scratch: join(clientCacheRoot(root), 'static-base'),
    base: path => {
      const file = base.get(path);
      if (!file) return null;
      // A link or submodule entry has no file bytes to put back: the copy would not be base.
      if (file.mode !== 'file' && file.mode !== 'executable') return undefined;
      return cachedObject(root, file.blob) ?? undefined;
    },
  };
}

function planStatic(packageJson: string | undefined, paths: string[], forgeJson?: string) {
  try {
    return selectStaticChecks(staticChecks(packageJson, forgeJson), paths);
  } catch (error) {
    return { reason: `static preflight checks misconfigured: ${(error as Error).message.slice(0, 200)}` };
  }
}

function localSelection(input: {
  selection: {
    tiers: { tier: string; tests: string[] }[];
    deferredTests: string[];
  };
  fit: ReturnType<typeof fitPreflightBudget>;
  timing: ReturnType<typeof preflightSecondsPerFile>;
  budgetSeconds: number;
  kept: Set<string>;
  mandatory: number;
  protected: number;
  deferred: number;
  ceiling: ReturnType<typeof runCeiling>;
  ceilingNote: string;
  estimateSeconds: number;
  guards: { name: string; tests: string[]; seconds: number }[];
  guardSet?: GuardSetReport;
  filler: number;
  trimmedTests: string[];
  rerun: string | undefined;
  trim: boolean;
  commentOnly: string[];
  costTests: string[];
  only: boolean;
}): LocalSelection {
  const { fit, timing, budgetSeconds } = input;
  // Only a cost test this run actually starts is named (a retry that left it out does not claim it).
  const costTests = input.costTests.filter(test => input.kept.has(test));
  const tiers = input.selection.tiers.map(item => ({
    tier: item.tier,
    total: item.tests.length,
    local: item.tests.filter(test => input.kept.has(test)).length,
  }));
  const tierTests = Object.fromEntries(
    input.selection.tiers
      .map(item => [item.tier, item.tests.filter(test => input.kept.has(test))] as const)
      .filter(([, tests]) => tests.length),
  );
  const trimmed = fit.trimmed.map(({ tier, kept, total }) => ({
    tier,
    kept,
    total,
  }));
  const cutNote = trimmed.length
    ? ` Trimmed ${trimmed.map(item => `${item.tier} ${item.kept} of ${item.total}`).join(', ')}: ` +
      `about ${Math.ceil(fit.estimateSeconds)} s fills the ${budgetSeconds} s local budget at ` +
      `${timing.secondsPerFile.toFixed(1)} s per file (${timing.basis === 'measured' ? 'measured on this machine' : 'default estimate, no run measured yet'}).`
    : '';
  const over = !input.trim
    ? ' trim:false: the ranked local tiers run up to the ceiling.'
    : fit.protectedOverBudget
      ? ` Protected tests (changed, learned, direct) alone exceed the ${budgetSeconds} s budget: they run first (fast repo-wide guards, guards, the change's own tests, files that failed for these paths, named tests, then most learned saving per second; smoke and explicit coverage last); the wall clock stops the rest by name, and the run is then NOT COMPLETE with one command to finish them.`
      : '';
  const skippedNote = input.trimmedTests.length
    ? ` ${input.trimmedTests.length} trimmed file(s) are named in trimmedTests${input.rerun ? `; run them: ${input.rerun}` : ''}.`
    : '';
  return {
    rule: preflightTierRule,
    budgetSeconds,
    secondsPerFile: timing.secondsPerFile,
    basis: timing.basis,
    estimateSeconds: input.estimateSeconds,
    tiers,
    tierTests,
    trimmed,
    mandatoryOverBudget: fit.mandatoryOverBudget,
    ...(fit.protectedOverBudget ? { protectedOverBudget: true } : {}),
    mandatory: input.mandatory,
    protected: input.protected,
    deferred: input.deferred,
    ceiling: input.ceiling,
    ...(input.guards.length ? { guards: input.guards } : {}),
    ...(input.guardSet ? { guardSet: input.guardSet } : {}),
    ...(input.filler ? { filler: input.filler } : {}),
    ...(input.trimmedTests.length ? { trimmedTests: input.trimmedTests } : {}),
    ...(input.trimmedTests.length && input.rerun ? { rerun: input.rerun } : {}),
    ...(input.trim ? {} : { trim: false as const }),
    ...(input.commentOnly.length ? { commentOnly: input.commentOnly } : {}),
    ...(input.only ? { only: 'stopped' as const } : {}),
    deferredTo: 'pre-queue',
    summary:
      `${input.ceilingNote}Local rule: ${preflightTierRule}.` +
      (input.guards.length
        ? ` Guards run early and are protected from the local budget: ${input.guards.map(guard => `${guard.name} ~${guard.seconds} s`).join(', ')}.`
        : '') +
      (input.guardSet ? ` ${guardSetLine(input.guardSet)}` : '') +
      `${cutNote}${over}${skippedNote}` +
      (input.commentOnly.length
        ? ` ${input.commentOnly.length} comment-only path(s) add only the tests that read them.`
        : '') +
      (costTests.length
        ? ` Cost-test comment ("Writes N -> M") in ${costTests.join(', ')}: a changed test is required, so it runs first here; run it before landing.`
        : '') +
      (input.only ? ' Runs only the files the last run stopped for time.' : '') +
      (input.filler
        ? ` ${input.filler} cheap test file(s) timed in earlier runs use the leftover budget, last.`
        : '') +
      ' ' +
      (input.deferred
        ? `${input.deferred} test file(s) deferred; the queue check runs them first by default ` +
          '(acceptance.admissionCheck:"full" runs them before queue entry).'
        : 'No test file deferred.'),
  };
}

const observationSchema = z.union([
  z.array(z.string()).transform(passed => ({
    passed,
    failed: [] as string[],
    ms: {} as Record<string, number>,
    skipped: {} as Record<string, string>,
    timedOut: undefined as { file: string; seconds: number }[] | undefined,
  })),
  z
    .object({
      passed: z.array(z.string()),
      failed: z.array(z.string()),
      ms: z.record(z.string(), z.number()),
      skipped: z.record(z.string(), z.string()).default({}),
      timedOut: z.array(z.object({ file: z.string(), seconds: z.number() }).strict()).optional(),
    })
    .strict(),
]);

/** Runs the triggered static checks, then builds (Forge's own Node layout with build:core) and runs the
 * selected tests here, output to stderr, then records the result for this saved head. stdout stays
 * one JSON receipt. Static checks run first: they take seconds, catch what the landing check's
 * static job would reject, and a failure there ends the run before any build or test. Tests then
 * run mandatory first in groups sized from the speed already observed; an earlier failure or the
 * spent time budget stops later groups and names them. */
type HeldHeavySlot = {
  apply(env: NodeJS.ProcessEnv): void;
  waited: boolean;
  release(kind: HeavyKind): void;
};
/** One `nforge heavy` slot for this preflight's static checks, build and tests, held for this process. The
 * synchronous run waits for it in a child (FIFO with every other heavy command); a preflight inside
 * `nforge heavy` reuses that slot. Null when slots are off or the claim fails (the run goes on, said once). */
function holdHeavySlot(cwd: string): HeldHeavySlot | null {
  const claim = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./preflight-heavy-claim.js', import.meta.url)), String(process.pid), cwd],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let held:
    | { slot: string | null; parent: string | null; slots?: number; waited?: boolean; waitedMs?: number }
    | undefined;
  try {
    held = claim.status === 0 ? JSON.parse(claim.stdout) : undefined;
  } catch {}
  if (!held) {
    process.stderr.write('preflight: could not take an nforge heavy slot; running without one.\n');
    return null;
  }
  if (!held.parent) return null;
  const since = Date.now();
  const { slot, waitedMs } = held;
  // The build's checker and any nested test runner get the slot's core share (7008ff18); its own
  // test groups already run --test-concurrency=1.
  const { parent, slots, waited } = held;
  let cap: ReturnType<typeof slotCapEnv> | undefined;
  let released = false;
  return {
    waited: waited === true,
    apply(env) {
      cap ??= slotCapEnv(env, availableParallelism(), slots ?? 0);
      Object.assign(env, cap.env, {
        FORGE_HEAVY_PARENT: parent,
        ...(process.env.FORGE_HEAVY_DIR ? { FORGE_HEAVY_DIR: process.env.FORGE_HEAVY_DIR } : {}),
      });
    },
    release(kind) {
      if (released) return;
      released = true;
      cap?.dispose();
      if (!slot) return;
      rmSync(slot, { recursive: true, force: true });
      // A synchronous run cannot sample its tree; the load when it ends is the one reading.
      const load = process.platform === 'win32' ? null : Math.round(loadavg()[0]! * 10) / 10;
      recordHold(dirname(slot), Date.now() - since, {
        at: since,
        lane: laneOf(cwd),
        kind,
        load,
        ...(typeof waitedMs === 'number' ? { wait: waitedMs } : {}),
      });
    },
  };
}

/** Standalone preflight can reselect its input after a queue wait, before any check runs. */
export function withPreflightSlot<T>(
  root: string,
  needed: boolean,
  run: (held: HeldHeavySlot | null) => T,
): T {
  const held = needed ? holdHeavySlot(root) : null;
  try {
    return run(held);
  } finally {
    held?.release('other');
  }
}

export function runPreflight(
  root: string,
  laneId: string,
  head: string,
  plan: PreflightPlan & { status: 'planned' },
  tree?: string,
  staticOnly = false,
  /** The saved paths base to head (null: unknown). Given, a static failure blocks only when it is the
   * change's (src/agent-preflight-static.ts); omitted, every static failure blocks. */
  changed?: string[] | null,
  /** Hold one `nforge heavy` slot for the static checks, build and tests. The preflight action and the
   * land gate's inline run set it; a fixture run inside a test (already in its runner's slot) does not. */
  options: {
    heavySlot?: boolean | HeldHeavySlot;
    /** Static failure comparison uses the same base as selection, including after conflict resolution. */
    comparisonBase?: string;
    /** The saved source pin must still match after this run waited for its slot. */
    afterHeavyWait?: () => void;
    /** Report the workspace run without writing or reusing a saved-head receipt. */
    workingTree?: boolean;
    quick?: boolean;
    /** This head's static results from the run just before: kept, not run again (land's quick run). */
    staticDone?: NonNullable<PreflightReceipt['static']>;
  } = {},
): PreflightReceipt & { quickTimedOut?: true } {
  const started = Date.now();
  // Before anything runs: a long run must never be silent about what it is doing and why.
  process.stderr.write(
    `${staticOnly ? 'preflight: static checks only; tests remain advised. ' : ''}${planLine(plan)}\n`,
  );
  let exitCode: number | null = 0;
  let environment: PreflightReceipt['environment'];
  const environmentNext = `nforge agent ${shellQuote(root)} land --save ${shellQuote(JSON.stringify({ laneId }))}`;
  const passedTests: string[] = [];
  const notRun: string[] = [];
  const stopped: string[] = [];
  const fileMs: Record<string, number> = {};
  const ceiling = planCeiling(plan);
  const ceilingMs = ceiling.seconds * 1000;
  let ceilingReached = false;
  let quickTimedOut = false;
  const failedFiles: string[] = [];
  // Units whose program is not installed here: an environment result, never a failed run.
  const missingPrograms: string[] = [];
  const environmentUnits: string[] = [];
  // The group whose run failed and the start of its error output (file-pinned failures replace the group).
  let failingGroup: string[] = [];
  let failureTail: string | undefined;
  const timedOut: { file: string; seconds: number }[] = [];
  let buildMs: number | undefined;
  let testMs: number | undefined;
  let peakRssMb: number | null = null;
  // Seconds per test file this run observed; prices the finish command of an incomplete run.
  let secondsPerFile = plan.local?.secondsPerFile ?? PREFLIGHT_SECONDS_PER_FILE;
  let staticResults: StaticCheckResult[] = [];
  let typecheckUntouched: string[] = [];
  // Every repository-declared command (static checks, the build, package commands, the runner) runs
  // in one clean environment per run, as checks do: private HOME/XDG/temp and npm config, allowlisted
  // variables only. Built only when something runs; removed when the run ends.
  let clean: ReturnType<typeof cleanCommandEnvironment> | undefined;
  // Plus the browser settings the landing check's test jobs get (fix 5), resolved before the isolation.
  const cleanEnv = () => {
    if (clean) return clean.env;
    const built = cleanCommandEnvironment('preflight');
    Object.assign(built.env, preflightBrowserEnv());
    return (clean = built).env;
  };
  // Browser test files that did not run their browser (not installed here, or a skip): NOT COMPLETE.
  const needsBrowser: string[] = [];
  let heavy: HeldHeavySlot | null | undefined =
    typeof options.heavySlot === 'object' ? options.heavySlot : undefined;
  let heavyConfigured = false;
  let heavyKind: HeavyKind = 'other';
  const heavyEnv = (kind: HeavyKind) => {
    const env = cleanEnv();
    if (options.heavySlot && !heavyConfigured) {
      heavy ??= holdHeavySlot(root);
      if (heavy?.waited) options.afterHeavyWait?.();
      heavy?.apply(env);
      heavyConfigured = true;
    }
    heavyKind = kind;
    return env;
  };
  // A run that passed these checks for this head and then stopped kept them (Item 3f76a3df).
  const staticNames = plan.static?.selected.map(check => check.name) ?? [];
  const keptScope = staticScopeKey(changed);
  const kept =
    options.staticDone || staticOnly || options.workingTree || !staticNames.length
      ? undefined
      : keptPassedStatic<StaticCheckResult>(root, laneId, head, keptScope, staticNames);
  if (kept)
    process.stderr.write(
      `preflight: static checks passed for this head in the run that stopped; kept, not run again: ${staticNames.join(', ')}\n`,
    );
  const staticDone = options.staticDone ?? kept;
  try {
    if (staticDone) {
      // The receipt kept every field the earlier run returned.
      staticResults = staticDone as StaticCheckResult[];
      if (staticResults.some(result => result.outcome === 'failed')) exitCode = 1;
    } else if (plan.static?.selected.length) {
      const checks = plan.static.selected.map(check => ({ ...check, inputs: null }));
      const scope = changed === undefined ? undefined : staticScope(root, changed, options.comparisonBase);
      const kinds = new Set(
        checks.map(check =>
          isTypecheck(check) || isTypecheckCommand(check) ? 'typecheck' : commandKind(check.command),
        ),
      );
      const kind = kinds.has('test')
        ? 'test'
        : kinds.has('typecheck')
          ? 'typecheck'
          : kinds.has('build')
            ? 'build'
            : 'other';
      const env = heavyEnv(kind);
      staticResults = runStaticChecks(
        root,
        checks.filter(check => !isTypecheck(check)),
        env,
        undefined,
        scope,
      );
      // The typecheck script's compiler steps (fix 6): only those whose program holds a changed path.
      const typechecks = checks.filter(isTypecheck);
      if (typechecks.length) {
        const compilerEnv = typecheckEnv(root, env);
        const narrowed = selectTypechecks(root, typechecks, changed, compilerEnv, command =>
          runTypecheckSetup(root, command, compilerEnv, STATIC_CHECK_TIMEOUT_MS),
        );
        typecheckUntouched = narrowed.untouched;
        if (narrowed.untouched.length)
          process.stderr.write(
            `preflight: not run here, no changed file is in its program (the landing check still runs it): ${narrowed.untouched.join(', ')}\n`,
          );
        staticResults.push(...runStaticChecks(root, narrowed.selected, compilerEnv, undefined, scope));
      }
      if (staticResults.some(result => result.outcome === 'failed')) exitCode = 1;
      else if (!staticOnly && !options.workingTree && !typecheckUntouched.length)
        keepPassedStatic(root, laneId, head, keptScope, staticNames, staticResults);
    }
    if (!staticOnly && plan.tests.length && exitCode === 0) {
      // Keep the static batch's lease if one was needed so this preflight waits at most once.
      const buildAndTestEnv = heavyEnv('test');
      // Only Forge's own Node layout (no project runner) builds first; another project's script of
      // that name is not Forge's to run, and its runner builds what it needs.
      const scripts = (() => {
        if (plan.runner) return undefined;
        try {
          return (
            JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
              scripts?: Record<string, string>;
            }
          ).scripts;
        } catch {
          return undefined;
        }
      })();
      if (scripts?.['build:core']) {
        const buildStarted = Date.now();
        // In its own process group like every preflight command: nothing it starts outlives preflight.
        const build = spawnCaptured(
          'npm',
          ['run', '-s', 'build:core'],
          { cwd: root, env: buildAndTestEnv },
          false,
        );
        exitCode = build.status;
        buildMs = Date.now() - buildStarted;
      }
      // Degraded file events do not stop the tests (eb9b94ba): they run from the saved file list, which
      // needs no events, and are probed only if they fail, to tell a watcher loss from a real failure.
      if (exitCode === 0) {
        // The clean environment also drops a surrounding test runner's protocol variable
        // (NODE_TEST_CONTEXT), which would swallow this run's own exit code.
        const env = { ...buildAndTestEnv };
        // A Lane-local TMPDIR sits inside the live checkout: a fixture made there would resolve to
        // that checkout (Item 29024bd1). Tests get a TMPDIR outside every Forge checkout instead.
        const wanted = env.TMPDIR ?? tmpdir();
        const outside = tmpdirsOutsideCheckout(wanted);
        const directory =
          scratchIn(outside, 'forge-preflight-') ?? mkdtempSync(join(tmpdir(), 'forge-preflight-'));
        if (outside.includes(dirname(directory)) && dirname(directory) !== wanted) {
          const scratch = join(directory, 'tmp');
          mkdirSync(scratch);
          env.TMPDIR = env.TMP = env.TEMP = scratch;
        }
        // Every group shares one compiled-module cache, removed with the directory (Item dceb1bef).
        // The clean environment never carries an outer one, so this preflight always owns it.
        env.FORGE_TEST_MODULE_DIRECTORY = join(directory, 'modules');
        const testStarted = Date.now();
        const budgetMs = plan.local && plan.local.trim !== false ? plan.local.budgetSeconds * 1000 : Infinity;
        const stats = preflightFileStats(root);
        const fallbackSeconds = plan.local?.secondsPerFile ?? PREFLIGHT_SECONDS_PER_FILE;
        const declaredFileLimit = declaredFileLimitSeconds(root);
        const fileLimitMs = (group: string[]) =>
          Math.max(...group.map(test => preflightFileLimitSeconds(declaredFileLimit, stats[test]?.ms))) *
          1000;
        // The budget is a wall-time cap on this test phase. Tests run in plan order (mandatory, then
        // learned, direct, then the ranked tiers) in groups of about PREFLIGHT_GROUP_SECONDS, each sized
        // from known per-file times or this run's observed speed and never past the time left, so a slow
        // machine gets small groups. No file starts once the budget is spent; near the end groups shrink
        // to one file, so the run ends within the budget plus about one file. Every file it did not
        // start is named in the receipt with a one-command rerun of exactly those.
        const absentBrowser = new Set(missingBrowserTests(root, plan.tests, env));
        if (absentBrowser.size) {
          needsBrowser.push(...absentBrowser);
          process.stderr.write(
            `preflight: ${absentBrowser.size} browser test file(s) skipped: needs ${NEEDS_CHROMIUM.runtime}; ${NEEDS_CHROMIUM.next}\n`,
          );
        }
        const queue = plan.tests.filter(test => !absentBrowser.has(test));
        // Declared guards are never stopped for time (docs/workflows.md#local-preflight-guards), except
        // in land's quick head run, whose budget is a hard cap.
        const guardTests = new Set(
          options.quick ? [] : (plan.local?.guards?.flatMap(guard => guard.tests) ?? []),
        );
        let ran = 0;
        let index = 0;
        const runGroup = (group: string[]) => {
          const report = join(directory, `passed-${index++}.json`);
          const groupStarted = Date.now();
          if (plan.packageCommands) {
            // Package commands: one process per unit, in its package folder; a pass covers that unit.
            for (const [at, unit] of group.entries()) {
              // Each unit is its own process, often minutes long: the ceiling is checked between them.
              if (ran && Date.now() - testStarted >= ceilingMs) {
                ceilingReached = true;
                notRun.push(...group.slice(at));
                break;
              }
              const command = plan.packageCommands[unit]!;
              const cwd = join(root, command.cwd);
              // A toolchain this machine lacks (cargo, go, uv, a JVM…) is not run and not failed.
              const absent = missingToolchain(command, cwd, env);
              if (absent) {
                missingPrograms.push(absent);
                environmentUnits.push(unit);
                process.stderr.write(`preflight: ${absent} is not installed here; not run: ${unit}\n`);
                continue;
              }
              const started = Date.now();
              const run = spawnCaptured(command.argv[0]!, command.argv.slice(1), {
                cwd,
                env,
                stdio: ['ignore', 2, 2],
              });
              if (missingProgramExit(run.status, run.errorCode)) {
                missingPrograms.push(command.argv[0]!);
                environmentUnits.push(unit);
                process.stderr.write(`preflight: a program ${unit} needs is not installed here (exit 127)\n`);
                continue;
              }
              ran++;
              fileMs[unit] = Date.now() - started;
              if (run.peakRssMb !== null) peakRssMb = Math.max(peakRssMb ?? 0, run.peakRssMb);
              if (run.status === 0 || noTestsCollected(command.argv, run.status)) passedTests.push(unit);
              else {
                failedFiles.push(unit);
                failureTail ??= run.tail;
                if (exitCode === 0) exitCode = run.status ?? 1;
                if (run.status === null) process.stderr.write(`preflight: ${command.argv[0]} was stopped\n`);
                stopped.push(...group.slice(at + 1));
                break;
              }
            }
            return Date.now() - groupStarted;
          }
          // A project runner reports one exit status per group: a pass covers every file in it, a
          // failure is pinned to a file only when the group held one.
          const argv = plan.runner
            ? runnerCommand(plan.runner, group)
            : [
                process.execPath,
                // dot: one character per passing test and the full detail of failures only (TAP printed every
                // subtest, about 150 KB of an agent's context per preflight).
                '--test-reporter=dot',
                '--test-reporter-destination=stderr',
                `--test-reporter=${new URL('./agent-preflight-reporter.js', import.meta.url).href}`,
                '--test-reporter-destination=stdout',
                ...testArgs(root, group),
              ];
          // Land's quick head run is a hard cap: a group still running at the budget (plus a short
          // grace) is stopped, its files left to the landing check (incomplete, never failed).
          const left = options.quick
            ? testStarted + budgetMs + Math.min(10_000, budgetMs) - Date.now()
            : null;
          const run = spawnCaptured(
            argv[0]!,
            argv.slice(1),
            {
              cwd: root,
              env: {
                ...env,
                FORGE_PREFLIGHT_REPORT: report,
                ...(plan.runner ? {} : { [FILE_TIMEOUT_ENV]: String(fileLimitMs(group)) }),
              },
              stdio: ['ignore', 2, 2],
              ...(left !== null ? { timeout: Math.max(1_000, left) } : {}),
            },
            left === null,
          );
          if (left !== null && run.errorCode === 'ETIMEDOUT') {
            quickTimedOut = true;
            notRun.push(...group);
            process.stderr.write(
              `preflight: the quick run reached its ${budgetMs / 1000} s cap; ${group.length} file(s) left\n`,
            );
            return Date.now() - groupStarted;
          }
          if (plan.runner && missingProgramExit(run.status, run.errorCode)) {
            // The runner's program is not installed here: these files are the landing check's.
            missingPrograms.push(argv[0]!);
            environmentUnits.push(...group);
            process.stderr.write(`preflight: ${argv[0]} is not installed here (exit 127); not run\n`);
            return Date.now() - groupStarted;
          }
          ran += group.length;
          if (run.status !== 0 && exitCode === 0) {
            exitCode = run.status;
            failingGroup = group;
            failureTail ??= run.tail;
          }
          if (run.peakRssMb !== null) peakRssMb = Math.max(peakRssMb ?? 0, run.peakRssMb);
          if (plan.runner) {
            if (run.status === 0) passedTests.push(...group);
            else if (group.length === 1) failedFiles.push(...group);
            const each = (Date.now() - groupStarted) / group.length;
            for (const test of group) fileMs[test] = each;
            return Date.now() - groupStarted;
          }
          try {
            const observed = observationSchema.parse(JSON.parse(readFileSync(report, 'utf8')));
            // A browser test that skipped never drove its browser: no pass, no timing sample.
            const skippedBrowser = new Set(
              skippedBrowserTests(observed.skipped).filter(test => group.includes(test)),
            );
            for (const test of skippedBrowser) {
              needsBrowser.push(test);
              delete observed.ms[test];
            }
            passedTests.push(
              ...group.filter(test => observed.passed.includes(test) && !skippedBrowser.has(test)),
            );
            failedFiles.push(...group.filter(test => observed.failed.includes(test)));
            Object.assign(fileMs, observed.ms);
            for (const hung of observed.timedOut ?? []) {
              timedOut.push(hung);
              if (exitCode === 0) exitCode = run.status || 124;
              failingGroup = group;
              const line = `✖ ${hung.file} timed out: killed after ${hung.seconds} s at the per-file limit of ${Math.round(fileLimitMs(group) / 1000)} s (a test that never resolves). Its process group was stopped.`;
              process.stderr.write(`preflight: ${line}\n`);
              failureTail = `${line}\n${failureTail ?? ''}`;
            }
          } catch {
            /* Missing report: no per-file pass is reusable. */
          }
          return Date.now() - groupStarted;
        };
        try {
          let spent = 0;
          // Seconds per file seen in this run; the estimate stands in until a group has run.
          let observed = fallbackSeconds;
          while (queue.length) {
            if (exitCode !== 0) {
              stopped.push(...queue.splice(0));
              break;
            }
            const elapsed = Date.now() - testStarted;
            // The ceiling stops every queued file, guards too: the landing check runs them (8dbd2683).
            if (elapsed >= ceilingMs && ran) {
              ceilingReached = true;
              notRun.push(...queue.splice(0));
              break;
            }
            const remaining = (budgetMs - elapsed) / 1000;
            // The first group always runs (a budget of 0 still runs one file, the most relevant).
            if (remaining <= 0 && ran) {
              const spent = budgetSpent(queue.splice(0), guardTests);
              notRun.push(...spent.stopped);
              queue.push(...spent.start);
              if (!queue.length) break;
            }
            const window = Math.max(
              0,
              Math.min(remaining, (ceilingMs - elapsed) / 1000, PREFLIGHT_GROUP_SECONDS),
            );
            const group: string[] = [];
            let planned = 0;
            while (queue.length) {
              const next = queue[0]!;
              const seconds = stats[next] ? stats[next].ms / 1000 : observed;
              if (group.length && planned + seconds > window) break;
              group.push(queue.shift()!);
              planned += seconds;
            }
            spent += runGroup(group);
            if (quickTimedOut) {
              notRun.push(...queue);
              break;
            }
            if (ran) observed = spent / 1000 / ran;
          }
          secondsPerFile = observed;
          testMs = Date.now() - testStarted;
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
        if (exitCode !== 0) {
          const health = preflightRuntime.filesystemEventHealth(root);
          if (!health.ok) environment = filesystemEnvironment(health, environmentNext);
        }
      }
    }
  } finally {
    heavy?.release(heavyKind);
    clean?.dispose();
  }
  if (!environment && missingPrograms.length)
    environment = toolchainEnvironment(missingPrograms, environmentUnits, environmentNext);
  // Test files that could not load because a declared package is not installed in the Lane are the
  // Lane's setup, not a failing test; only when no failed file is left unexplained (9ab983fd).
  if (!environment && exitCode && !plan.packageCommands) {
    environment =
      dependenciesMissing(root, failedFiles.length ? failedFiles : failingGroup, environmentNext) ??
      (plan.runner && failureTail !== undefined
        ? runnerDependenciesMissing(
            failureTail,
            plan.runner.command[0] ?? 'npx',
            failingGroup.length ? failingGroup : failedFiles,
            environmentNext,
          )
        : null) ??
      undefined;
    if (environment) {
      environmentUnits.push(...environment.units);
      failedFiles.length = 0;
    }
  }
  if (plan.tests.length && (Object.keys(fileMs).length || failedFiles.length))
    recordFileStats(root, { passed: passedTests, failed: failedFiles, ms: fileMs });
  // Every executed run counts on the guard set's cost side (r), test files or not: the land gate sends it.
  recordPreflightRun(root, laneId);
  // A failure here is evidence that these tests matter for these paths: the next plan protects them.
  const paths = plannedPaths.get(plan);
  if (paths && failedFiles.length) {
    const planned = new Set(plan.tests);
    learnFailures(root, paths, failedFiles, undefined, file => planned.has(file));
  }
  const slowest = Object.entries(fileMs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([file, ms]) => ({ file, ms: Math.round(ms) }));
  const evidence = preparedEvidence.get(plan);
  const skipped = notRun.length + stopped.length + environmentUnits.length + needsBrowser.length;
  const skippedFiles = [...(plan.local?.trimmedTests ?? []), ...notRun].sort();
  const rerun = skippedFiles.length ? rerunCommand(root, skippedFiles) : undefined;
  const stoppedRerun = notRun.length && !options.workingTree ? stoppedCommand(root, laneId) : undefined;
  const emptyAtCeiling =
    !staticOnly && !plan.tests.length && !plan.reusedTests?.length ? plan.ceilingDeferred : undefined;
  // A clean run that left must-run files unstarted proved nothing about them: NOT COMPLETE.
  const incomplete =
    exitCode === 0 && !environment
      ? emptyAtCeiling
        ? {
            mustRun: emptyAtCeiling,
            estimateMinutes: Math.max(Math.floor(ceiling.seconds / 60) + 1, plan.totalEstimateMinutes ?? 0),
          }
        : incompletePreflight({
            root,
            laneId,
            // Package plans list only selected commands, so a configured ceiling stopping one
            // leaves required coverage outstanding even though the plan has no file tiers.
            tierTests:
              plan.packageCommands && plan.timeSettings && ceilingReached
                ? { mandatory: plan.tests }
                : plan.local?.tierTests,
            notRun,
            secondsPerFile,
            ...(needsBrowser.length ? { needs: { ...NEEDS_CHROMIUM, files: [...needsBrowser].sort() } } : {}),
          })
      : undefined;
  if (options.workingTree && incomplete) delete incomplete.finish;
  // When a quick landing stops at its static gate, retain the static-only failure receipt.
  const receiptStaticOnly =
    staticOnly || (options.quick === true && staticResults.some(result => result.outcome === 'failed'));
  const receipt: PreflightReceipt = {
    schema: 1,
    laneId,
    head,
    ...(tree ? { tree } : {}),
    tests: receiptStaticOnly ? 0 : plan.tests.length - skipped,
    ...(receiptStaticOnly ? { staticOnly: true as const } : {}),
    ...(options.quick && !receiptStaticOnly ? { quick: true as const } : {}),
    ...(!receiptStaticOnly && evidence && tree === sourceTree(evidence.files)
      ? {
          evidence: writePreflightEvidence(root, {
            ...evidence,
            covered: [...passedTests, ...(plan.reusedTests ?? [])].sort(),
          }),
        }
      : {}),
    ...(!receiptStaticOnly && !(evidence && tree === sourceTree(evidence.files)) && plan.tests.length
      ? (() => {
          const ran = ranEvidence([...passedTests, ...(plan.reusedTests ?? [])]);
          return ran === undefined ? {} : { ran };
        })()
      : {}),
    ...(!receiptStaticOnly && plan.reusedTests?.length
      ? { reusedTests: plan.reusedTests.length, reusedFrom: plan.reusedFrom }
      : {}),
    ...(plan.deferredTests?.length || skipped || (receiptStaticOnly && plan.tests.length)
      ? {
          deferredTests:
            (plan.deferredTests?.length ?? 0) + skipped + (receiptStaticOnly ? plan.tests.length : 0),
        }
      : {}),
    ...(notRun.length ? { stoppedForTime: notRun.length, stopped: notRun, stoppedRerun } : {}),
    ...(skippedFiles.length ? { skipped: skippedFiles } : {}),
    ...(rerun ? { rerun } : {}),
    ...(stopped.length ? { stoppedForFailure: stopped.length } : {}),
    ...(timedOut.length ? { timedOut: timedOut.slice(0, 10) } : {}),
    ...(staticResults.length ? { static: staticResults } : {}),
    ...(slowest.length ? { slowest } : {}),
    ...(plan.local
      ? {
          rule: plan.local.rule,
          budgetSeconds: plan.local.budgetSeconds,
          ...(plan.local.trimmed.length ? { trimmedTiers: plan.local.trimmed.map(item => item.tier) } : {}),
        }
      : {}),
    ...(plan.deferredTests?.length || skipped ? { deferredTo: 'pre-queue' as const } : {}),
    ...(!receiptStaticOnly && (plan.tests.length || emptyAtCeiling)
      ? {
          ceiling: {
            seconds: ceilingMs / 1000,
            ...(ceiling.override ? { override: true as const } : {}),
            ...(ceilingReached ? { reached: true as const } : {}),
          },
        }
      : {}),
    ...(buildMs !== undefined ? { buildMs } : {}),
    ...(plan.timeSettings ? { timeSettings: plan.timeSettings } : {}),
    ...(testMs !== undefined ? { testMs } : {}),
    ...(peakRssMb !== null ? { peakRssMb } : {}),
    selection: plan.deferredTests?.length || skipped ? 'local' : plan.scope,
    exitCode,
    passed: exitCode === 0 && !environment && !incomplete,
    ...(incomplete ? { incomplete } : {}),
    ...(environment ? { environment, exitCode: exitCode || null } : {}),
    ...(!environment && exitCode && failureTail !== undefined
      ? {
          failure: {
            files: (failedFiles.length ? failedFiles : failingGroup).slice(0, 10),
            excerpt: failureExcerpt(failureTail),
          },
        }
      : {}),
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  };
  receipt.outcome = preflightOutcome(receipt);
  // A failed run names at least one failing unit (a build or runner failure names no file).
  receipt.failed =
    receipt.outcome === 'failed'
      ? Math.max(
          1,
          staticResults.filter(result => result.outcome === 'failed').length +
            (failedFiles.length || failingGroup.length),
        )
      : 0;
  if (!options.workingTree) {
    writePreflightReceipt(root, receipt);
    dropKeptStatic(root, laneId);
  }
  process.stderr.write(`${runSummary(receipt, plan, typecheckUntouched)}\n`);
  recordPreflightTiming(root, receipt);
  return quickTimedOut ? { ...receipt, quickTimedOut: true } : receipt;
}

/** Why a run stopped at its ceiling, and how to run longer once; undefined when the ceiling did not stop it. */
function ceilingWords(receipt: PreflightReceipt) {
  if (!receipt.ceiling?.reached) return undefined;
  return receipt.ceiling.override
    ? `the ${receipt.ceiling.seconds} s budgetSeconds override was reached`
    : `the ${receipt.ceiling.seconds} s run ceiling was reached (longer local runs hold a test slot and rarely catch what the landing check would not; pass a larger budgetSeconds to run longer once)`;
}
/** Longest skipped list the closing line spells out; the receipt always names every file. */
const SKIPPED_NAMED = 20;
/** The builder's closing line: what ran, how long it took, and what waits for the pre-queue check. */
function runSummary(
  receipt: PreflightReceipt,
  plan: PreflightPlan & { status: 'planned' },
  typecheckUntouched: string[] = [],
) {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const timing = [
    receipt.buildMs !== undefined ? `build ${seconds(receipt.buildMs)}` : '',
    receipt.testMs !== undefined ? `tests ${seconds(receipt.testMs)}` : '',
    receipt.peakRssMb !== undefined ? `peak RSS ${receipt.peakRssMb} MB` : 'peak RSS unmeasured',
  ].filter(Boolean);
  const deferred = receipt.deferredTests ?? 0;
  const needs = receipt.incomplete?.needs;
  const ranOut = ceilingWords(receipt) ?? `the ${receipt.budgetSeconds} s local budget ran out`;
  // Must-run files stopped, other files stopped for time, and browser files skipped are separate
  // sentences: a run can have the last two at once (needs with no must-run file still stops for time).
  const mustRun = receipt.incomplete?.mustRun
    ? !plan.tests.length
      ? ` The first ranked test is estimated above the ${receipt.ceiling?.seconds} s ceiling. Next: land --save; the landing check runs the deferred tests. Pass a larger budgetSeconds to run them here.`
      : ` ${receipt.incomplete.mustRun} must-run test file(s) (changed, learned or direct) not started, 0 failed: ${ranOut}` +
        ` (receipt.stopped names them, first). Next: land --save; the landing check runs them.` +
        (receipt.incomplete.finish
          ? ` To finish them here first (about ${receipt.incomplete.estimateMinutes} min): ${receipt.incomplete.finish}.`
          : ` Finishing them here takes about ${receipt.incomplete.estimateMinutes} min, longer than one agent wait (${AGENT_WAIT_SECONDS / 60} min).`)
    : '';
  const forTime =
    !mustRun && receipt.stoppedForTime
      ? ` ${ranOut[0]!.toUpperCase()}${ranOut.slice(1)}, so ${receipt.stoppedForTime} planned test file(s) were not started` +
        ` (receipt.stopped names them${
          receipt.stopped && receipt.stopped.length <= SKIPPED_NAMED ? `: ${receipt.stopped.join(' ')}` : ''
        }); run just those: ${receipt.stoppedRerun}.`
      : '';
  const browserNeeds = needs
    ? ` ${needs.files.length} test file(s) skipped: needs ${needs.runtime}, so they are not a pass (${
        needs.files.length <= SKIPPED_NAMED ? needs.files.join(' ') : 'receipt.incomplete.needs names them'
      }). To run them here: ${needs.next}; the landing check runs them either way.`
    : '';
  const stopped = mustRun + forTime + browserNeeds;
  const failedFirst = receipt.stoppedForFailure
    ? ` ${receipt.stoppedForFailure} planned test file(s) were not started because an earlier group failed; fix it and run preflight again (passed files are reused).`
    : '';
  const checks = receipt.static?.length
    ? ` Static: ${receipt.static.map(item => `${item.name} ${item.outcome} ${seconds(item.ms)}`).join(', ')}${
        receipt.static.some(item => item.outcome === 'failed') ? ' (tests not run)' : ''
      }.` +
      (receipt.static.some(item => item.outcome === 'timed-out')
        ? ' A timed-out static check was not run here; the landing check runs it.'
        : '') +
      receipt.static
        .filter(item => item.advisory)
        .map(item => ` ${item.name}: ${item.advisory}`)
        .join('')
    : '';
  const notTriggered = [...(plan.static?.untouched ?? []), ...typecheckUntouched];
  const untouched = notTriggered.length
    ? ` Static checks not triggered by this change: ${notTriggered.join(', ')}.`
    : '';
  const slow = receipt.slowest?.length
    ? ` Slowest: ${receipt.slowest.map(item => `${item.file} ${seconds(item.ms)}`).join(', ')}.`
    : '';
  return (
    `preflight: ${receipt.staticOnly ? 'static checks ' : ''}${preflightVerdict(receipt)}, ${receipt.tests} test file(s) in ${seconds(receipt.durationMs)} (${timing.join(', ')}).` +
    checks +
    untouched +
    stopped +
    failedFirst +
    slow +
    (receipt.environment
      ? ` ${receipt.environment.code}: this machine, not your change. No fix is needed to continue: the landing check runs the tests; next: ${receipt.environment.next}`
      : '') +
    ` Rule: ${receipt.rule ?? plan.scope}.` +
    (receipt.trimmedTiers?.length ? ` Trimmed tier(s): ${receipt.trimmedTiers.join(', ')}.` : '') +
    (receipt.skipped?.length
      ? ` Skipped for time: ${
          receipt.skipped.length <= SKIPPED_NAMED
            ? receipt.skipped.join(' ')
            : `${receipt.skipped.length} files (receipt.skipped names them)`
        }. Run them: ${receipt.rerun}`
      : '') +
    (deferred
      ? ` ${deferred} test file(s) deferred; the queue check runs them first by default (full admission opts in before queue entry).`
      : ' No test file deferred.')
  );
}
