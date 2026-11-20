// SPDX-License-Identifier: Apache-2.0
import { durableReplace } from './state/durability.js';
import { clientCacheRoot, retainedRootSibling } from './root-paths.js';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { laneOf, recordHold } from './heavy-queue.js';
import { slotCapEnv } from './heavy-hold.js';
import { safeRelative } from './files.js';
import { AGENT_WAIT_SECONDS } from './agent-operation-wait.js';
import { z } from 'zod';
import {
  documentation,
  fitPreflightBudget,
  preflightTierRule,
  protectedTiers,
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
import { commentOnlyPaths } from './preflight-comment-only.js';
import { spawnCaptured, failureExcerpt } from './agent-preflight-capture.js';
import {
  dependenciesEnvironmentSchema,
  dependenciesMissing,
  runnerDependenciesMissing,
} from './preflight-dependencies.js';
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
import { isTypecheck, runTypecheckSetup, selectTypechecks, typecheckEnv } from './preflight-typecheck.js';
import { baseStateFiles, cachedObject } from './hosted-changed-paths.js';
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
import {
  filesystemEventHealth,
  filesystemEnvironment,
  filesystemEnvironmentSchema,
} from './filesystem-event-health.js';

import {
  missingProgramExit,
  missingToolchain,
  toolchainEnvironment,
  toolchainEnvironmentSchema,
} from './preflight-toolchain.js';
import { hostedCheckSeconds } from './preflight-hosted-timing.js';

export const preflightRuntime = { filesystemEventHealth };

/** Default local cost per selected test file at concurrency 1, used for the time estimate. */
export const PREFLIGHT_SECONDS_PER_FILE = 4;
/** Default cost of one package command (it builds and tests whole packages) when neither this
 * machine nor a hosted check has timed one yet. */
export const PREFLIGHT_SECONDS_PER_PACKAGE_COMMAND = 60;
/** Why a plan from a runner Forge inferred never blocks landing (src/agent-default-gates.ts). */
export const INFERRED_RUNNER_ADVISORY =
  'Forge inferred these commands (no runner declared): their result is reported, never required, because they can need setup only CI does (fixtures, services, a toolchain). Declare preflight.tests in forge.json to require it.';
/** Local time budget (seconds). The plan trims unprotected tiers by estimated time, never by file
 * count; the run is a wall-time cap on the test phase: it starts no file once the budget is spent and
 * names every file it did not start. Whatever either cuts runs in the pre-queue Lane check. */
export const PREFLIGHT_LOCAL_BUDGET_SECONDS = 180;
/** Longest any one local test phase runs (seconds), whatever its budget, trim:false, finish or retry
 * (Item 8dbd2683): on 2026-11-19, runs over 600 s held half of all preflight slot time and caught
 * nothing. No file starts past it, declared guards included; what it stops goes to the landing check
 * as a budget stop does. An explicit budgetSeconds above it raises it for that one run. */
export const PREFLIGHT_RUN_CEILING_SECONDS = 600;
/** The ceiling a run keeps: the default, or the caller's explicit larger budget (named as an override). */
export const runCeiling = (budgetSeconds: number | undefined): { seconds: number; override?: true } =>
  budgetSeconds !== undefined && budgetSeconds > PREFLIGHT_RUN_CEILING_SECONDS
    ? { seconds: budgetSeconds, override: true }
    : { seconds: PREFLIGHT_RUN_CEILING_SECONDS };
/** The ceiling a planned run keeps, wherever its plan carries it; the default when it carries none. */
const planCeiling = (plan: PreflightPlan & { status: 'planned' }) =>
  plan.local?.ceiling ?? plan.ceiling ?? runCeiling(undefined);
/** Longest a group is planned to run (seconds). The run re-checks the budget between groups and sizes
 * the next one from the speed it observed and the time left, so this is only how finely it can stop,
 * never how many tests may run. */
const PREFLIGHT_GROUP_SECONDS = 30;
const SOURCE_DIRS = ['src', 'web', 'convex', 'netlify', 'tests', 'scripts'];

const reusedFromSchema = z.object({ head: z.string(), tree: z.string(), evidence: z.string() }).strict();
export const preflightReceiptSchema = z
  .object({
    schema: z.literal(1),
    laneId: z.string(),
    head: z.string(),
    tree: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    tests: z.number().int().nonnegative(),
    /** Only static commands ran; this receipt never satisfies the test gate. */
    staticOnly: z.literal(true).optional(),
    /** Land's quick head run of a plan over the gate's minutes (src/agent-default-gates.ts): a short
     * budget of the top-ranked tests. Its failure refuses the land; otherwise it never satisfies the
     * test gate, as staticOnly. */
    quick: z.literal(true).optional(),
    /** The test files this run passed or reused, as the land gate's 4-character keys (13ea93bf), when
     * no evidence file records them (a land gate's own run plans without the checkout's file list). */
    ran: z
      .string()
      .max(1024)
      .regex(/^(?:[A-Za-z0-9_-]{4})*$/)
      .optional(),
    selection: z.string(),
    exitCode: z.number().int().nullable(),
    passed: z.boolean(),
    /** What the run means, one word (preflightOutcome): passed, incomplete, environment or failed. */
    outcome: z.enum(['passed', 'incomplete', 'environment', 'failed']).optional(),
    /** Test files plus static checks that failed: 0 for every outcome but `failed`. */
    failed: z.number().int().nonnegative().optional(),
    durationMs: z.number().nonnegative(),
    at: z.string(),
    environment: z
      .union([filesystemEnvironmentSchema, toolchainEnvironmentSchema, dependenciesEnvironmentSchema])
      .optional(),
    /** Why a failed run failed (not an environment result): the files and the start of its error
     * output, so the refusal and the advice name the cause and not only an exit code (9ab983fd). */
    failure: z
      .object({ files: z.array(z.string()).max(10), excerpt: z.string().max(700) })
      .strict()
      .optional(),
    evidence: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    reusedTests: z.number().int().nonnegative().optional(),
    reusedFrom: reusedFromSchema.optional(),
    deferredTests: z.number().int().nonnegative().optional(),
    /** Cheap repository-wide checks the landing check also runs; a failure here skips the tests. */
    static: z
      .array(
        z
          .object({
            name: z.string(),
            outcome: z.enum(['passed', 'failed', 'timed-out', 'pre-existing', 'unjudged', 'forge-metadata']),
            ms: z.number().nonnegative(),
            command: z.array(z.string()).optional(),
            fix: z.array(z.string()).optional(),
            excerpt: z.string().max(700).optional(),
            files: z.array(z.string()).max(200).optional(),
            advisory: z.string().max(700).optional(),
          })
          .strict(),
      )
      .optional(),
    /** Planned tests not started because an earlier group had already failed. */
    stoppedForFailure: z.number().int().nonnegative().optional(),
    /** The slowest test files of this run, so a long preflight names its cause. */
    slowest: z
      .array(z.object({ file: z.string(), ms: z.number().nonnegative() }).strict())
      .max(3)
      .optional(),
    /** Selection rule, budget and cut, so a receipt says what was left for the pre-queue check. */
    rule: z.string().optional(),
    budgetSeconds: z.number().nonnegative().optional(),
    /** The run's wall-time ceiling (8dbd2683): `override` when an explicit budget raised it, `reached`
     * when it stopped files. */
    ceiling: z
      .object({
        seconds: z.number().positive(),
        override: z.literal(true).optional(),
        reached: z.literal(true).optional(),
      })
      .strict()
      .optional(),
    trimmedTiers: z.array(z.string()).optional(),
    deferredTo: z.literal('pre-queue').optional(),
    buildMs: z.number().nonnegative().optional(),
    testMs: z.number().nonnegative().optional(),
    /** Largest resident set of any test process; absent where the platform cannot report it. */
    peakRssMb: z.number().nonnegative().optional(),
    /** Tests that were planned to run here but not started because the time budget was spent. */
    stoppedForTime: z.number().int().nonnegative().optional(),
    /** Those files by name, in plan order (most relevant first). */
    stopped: z.array(z.string()).optional(),
    /** The one command that runs exactly the `stopped` files on the saved head. */
    stoppedRerun: z.string().optional(),
    /** Every local-tier file this run skipped for time (trimmed by the plan or not started). */
    skipped: z.array(z.string()).optional(),
    /** The one command that runs exactly the skipped files (passed ones are reused). */
    rerun: z.string().optional(),
    /** Must-run files the budget did not start: the run is NOT COMPLETE (passed is false, nothing
     * failed), with the one command that finishes them. */
    incomplete: z
      .object({
        mustRun: z.number().int().nonnegative(),
        finish: z.string().optional(),
        estimateMinutes: z.number().int().positive(),
        /** Test files that skipped because a runtime they need is not installed here (fix 5). */
        needs: z
          .object({ runtime: z.string(), files: z.array(z.string()).min(1), next: z.string() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PreflightReceipt = z.infer<typeof preflightReceiptSchema>;
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
  /** Leading tests that always run: changed tests, explicit coverage and smoke not already passed. */
  mandatory: number;
  /** Leading tests the budget never trims or stops: mandatory, learned and direct (not yet passed). */
  protected?: number;
  /** Ranked local-tier files the budget trimmed from this run, by name. */
  trimmedTests?: string[];
  /** The one command that runs every trimmed file (passed ones are reused). */
  rerun?: string;
  /** false: run every ranked local tier, no time budget (the rerun command); the ceiling still holds. */
  trim?: false;
  /** Hard wall-time ceiling of the test phase (8dbd2683); absent in a caller-built plan (the default holds). */
  ceiling?: { seconds: number; override?: true };
  /** Changed paths whose edit is comment-only: they add only tests that read their text. */
  commentOnly?: string[];
  /** Set when the plan runs only the files a previous run stopped for time. */
  only?: 'stopped';
  deferred: number;
  /** Declared guards this change triggered: always run first, never trimmed; `seconds` is the cost
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
      reusedFrom?: z.infer<typeof reusedFromSchema>;
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
    };

const preparedEvidence = new WeakMap<PreflightPlan, PreflightEvidence>();
/** The changed paths a plan was made for, so a failing run can teach them (never printed). */
const plannedPaths = new WeakMap<PreflightPlan, string[]>();
const receiptPath = (root: string, laneId: string) =>
  join(clientCacheRoot(root), 'agent', 'preflight', `${laneId}.json`);
/** The same plan, run order and evidence with a different wall-time budget (land's quick head run):
 * no re-plan, and the run still records what it ran for the guard-set learner. */
export function planWithBudget(
  plan: PreflightPlan & { status: 'planned' },
  budgetSeconds: number,
): PreflightPlan & { status: 'planned' } {
  if (!plan.local) return plan;
  const copy = { ...plan, local: { ...plan.local, budgetSeconds } };
  const evidence = preparedEvidence.get(plan);
  if (evidence) preparedEvidence.set(copy, evidence);
  const paths = plannedPaths.get(plan);
  if (paths) plannedPaths.set(copy, paths);
  return copy;
}

export function readPreflightReceipt(root: string, laneId: string): PreflightReceipt | null {
  try {
    return preflightReceiptSchema.parse(JSON.parse(readFileSync(receiptPath(root, laneId), 'utf8')));
  } catch {
    return null;
  }
}
function writePreflightReceipt(root: string, receipt: PreflightReceipt) {
  const path = receiptPath(root, receipt.laneId);
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, JSON.stringify(receipt), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** Learn from completed local runs, including build time and this machine's load.
 * Sibling Lanes share this clone-local disposable record. It is never uploaded. */
const timingsPath = (root: string) =>
  join(retainedRootSibling(root, '.forge-client'), 'agent', 'preflight-timings.json');
const timingsSchema = z
  .array(z.object({ tests: z.number().int().positive(), ms: z.number().positive() }).strict())
  .max(8);
export function preflightSecondsPerFile(root: string) {
  // One run is a noisy sample (test mix, machine load), so prefer the last few completed runs.
  try {
    const runs = timingsSchema.parse(JSON.parse(readFileSync(timingsPath(root), 'utf8')));
    const tests = runs.reduce((sum, run) => sum + run.tests, 0);
    if (tests > 0)
      return {
        secondsPerFile: runs.reduce((sum, run) => sum + run.ms, 0) / tests / 1000,
        basis: 'measured' as const,
      };
  } catch {
    /* No rolling window yet: fall back to the latest completed run. */
  }
  try {
    const sample = preflightReceiptSchema.parse(
      JSON.parse(
        readFileSync(
          join(retainedRootSibling(root, '.forge-client'), 'agent', 'preflight-estimate.json'),
          'utf8',
        ),
      ),
    );
    if (sample.passed && sample.tests > 0)
      return { secondsPerFile: sample.durationMs / sample.tests / 1000, basis: 'measured' as const };
  } catch {
    /* A cold or corrupt model uses the documented fallback. */
  }
  return { secondsPerFile: PREFLIGHT_SECONDS_PER_FILE, basis: 'default' as const };
}
function recordTiming(root: string, receipt: PreflightReceipt) {
  try {
    let runs: z.infer<typeof timingsSchema> = [];
    try {
      runs = timingsSchema.parse(JSON.parse(readFileSync(timingsPath(root), 'utf8')));
    } catch {
      /* Start a fresh window. */
    }
    runs = [...runs, { tests: receipt.tests, ms: Math.max(1, receipt.durationMs) }].slice(-8);
    mkdirSync(join(timingsPath(root), '..'), { recursive: true, mode: 0o700 });
    durableReplace(timingsPath(root), JSON.stringify(runs));
  } catch {
    /* Estimates never invalidate a completed run. */
  }
}
/** What earlier local runs saw per test file: smoothed run time and whether the last run failed.
 * A disposable clone-local record, never uploaded, bounded; it only orders and prices tests. */
const fileStatsPath = (root: string) =>
  join(retainedRootSibling(root, '.forge-client'), 'agent', 'preflight-files.json');
const fileStatsSchema = z.record(
  z.string(),
  z.object({ ms: z.number().nonnegative(), failed: z.boolean() }).strict(),
);
export type PreflightFileStats = z.infer<typeof fileStatsSchema>;
const MAX_FILE_STATS = 5000;
export function preflightFileStats(root: string): PreflightFileStats {
  try {
    return fileStatsSchema.parse(JSON.parse(readFileSync(fileStatsPath(root), 'utf8')));
  } catch {
    return {};
  }
}
function recordFileStats(
  root: string,
  observed: { passed: string[]; failed: string[]; ms: Record<string, number> },
) {
  try {
    const stats = preflightFileStats(root);
    for (const file of [...observed.passed, ...observed.failed]) {
      const ms = observed.ms[file];
      const previous = stats[file];
      delete stats[file];
      stats[file] = {
        ms: ms === undefined ? (previous?.ms ?? 0) : previous ? (previous.ms + ms) / 2 : ms,
        failed: observed.failed.includes(file),
      };
    }
    const kept = Object.entries(stats).slice(-MAX_FILE_STATS);
    mkdirSync(join(fileStatsPath(root), '..'), { recursive: true, mode: 0o700 });
    durableReplace(fileStatsPath(root), JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* Ordering hints never invalidate a completed run. */
  }
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
      modules,
      declaredPackageFlags(forgeJson),
      wrappers?.value === true,
    );
    // Same object: plannedPaths keys on it. Package commands have no time budget, but the ceiling holds.
    if (plan.status === 'planned') plan.ceiling = runCeiling(options.budgetSeconds);
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
  const budgetSeconds = options.budgetSeconds ?? PREFLIGHT_LOCAL_BUDGET_SECONDS;
  const declaredTests = new Set(guards.flatMap(guard => guard.tests));
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
            budgetSeconds,
            [...declaredTests, ...selection.changedTests],
            secondsFor,
          ),
        },
      );
  const learnedGuards = (guardSet?.tests ?? []).filter(test => !declaredTests.has(test));
  const mandatory = [...new Set([...declaredTests, ...learnedGuards, ...selection.changedTests])];
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
  const tests = tiers.flatMap(item => item.tests);
  const trim = options.trim !== false;
  const seconds = tests.reduce((sum, test) => sum + secondsFor(test), 0);
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
    tiers: tiers.map(item => ({ tier: item.tier, total: item.tests.length, local: item.tests.length })),
    tierTests: Object.fromEntries(tiers.map(item => [item.tier, item.tests])),
    trimmed: [],
    mandatoryOverBudget: false,
    mandatory: tiers[0]?.tier === 'mandatory' ? tiers[0].tests.length : 0,
    protected: tests.length,
    deferred: 0,
    ...(trim ? {} : { trim: false as const }),
    ceiling: runCeiling(options.budgetSeconds),
    ...(only ? { only: 'stopped' as const } : {}),
    deferredTo: 'pre-queue',
    summary: `Local rule: ${rule}. ${reason}.${guardSet ? ` ${guardSetLine(guardSet)}` : ''}`,
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
    reason,
    tests,
    deferredTests: [],
    ...statics,
    local,
    reusedTests: [],
    estimateMinutes: Math.ceil(
      Math.min(
        seconds,
        trim ? budgetSeconds + tests.reduce((most, test) => Math.max(most, secondsFor(test)), 0) : Infinity,
      ) / 60,
    ),
    totalEstimateMinutes: estimatePreflightMinutes(root, tests.length),
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
    command: commands.map(command => packageCommandLine(command, shellWord)).join(' && '),
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
  modules?: () => ModuleGraph,
  flags?: PackageFlagSource | { refusal: string },
  treeWrappers = false,
): PreflightPlan {
  const selection = treeWrapperRule(packageTestSelection(graph, paths, modules, flags), treeWrappers);
  const units = keep(selection.units);
  const commands = Object.fromEntries(
    selection.commands.map(command => [
      selection.units[selection.commands.indexOf(command)]!,
      { cwd: command.cwd, argv: command.argv, ecosystem: command.ecosystem },
    ]),
  );
  const estimate = packageEstimate(root, units);
  const label = runnerLabel(runner);
  const plan: PreflightPlan = {
    status: 'planned',
    scope: selection.scope,
    reason: selection.reason,
    tests: units,
    deferredTests: [],
    ...statics,
    reusedTests: [],
    estimateMinutes: Math.ceil(estimate.seconds / 60),
    totalEstimateMinutes: Math.ceil(estimate.seconds / 60),
    estimateBasis: estimate.basis,
    runner: { label, command: [] },
    advisory: selection.replacedWrappers.length
      ? `${INFERRED_RUNNER_ADVISORY} ${selection.replacedWrappers.join(' and ')} in the tree ${selection.replacedWrappers.length > 1 ? 'are' : 'is'} not declared, so the build tool on PATH runs instead; declare "preflight": {"wrappers": true} in forge.json to run the wrapper.`
      : INFERRED_RUNNER_ADVISORY,
    packageCommands: commands,
    packages: selection.packages,
    command: selection.command,
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

/** Seconds the package units should take: each unit this machine already ran at its smoothed time;
 * the rest at the hosted check's recent median (the whole CI build bounds any subset of packages),
 * else the per-command default. Never the per-test-file constant: one unit builds whole packages. */
function packageEstimate(root: string, units: string[]) {
  const stats = preflightFileStats(root);
  const known = units.filter(unit => stats[unit] && stats[unit].ms > 0);
  const unknown = units.length - known.length;
  const hosted = unknown ? hostedCheckSeconds(root) : null;
  const seconds =
    known.reduce((sum, unit) => sum + stats[unit]!.ms / 1000, 0) +
    (unknown ? (hosted ?? unknown * PREFLIGHT_SECONDS_PER_PACKAGE_COMMAND) : 0);
  const basis = !unknown ? 'measured' : hosted !== null ? 'hosted' : 'default';
  return { seconds, basis } as const;
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
    let resolved: TestRunnerResolution;
    try {
      resolved = projectTestRunner(files.get('package.json'), allPaths, {
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
        files.get('package.json'),
        options,
        graph,
        forgeJson,
        modules,
      );
      if (plan.status === 'planned' && changed.source === 'manifests') plan.changedPathsFrom = 'manifests';
      return plan;
    }
    const timing = preflightSecondsPerFile(root);
    const stats = preflightFileStats(root);
    const budgetSeconds = options?.budgetSeconds ?? PREFLIGHT_LOCAL_BUDGET_SECONDS;
    const trim = options?.trim !== false;
    const secondsFor = (test: string) => (stats[test] ? stats[test].ms / 1000 : timing.secondsPerFile);
    const packageJson = files.get('package.json');
    const declaredGuards = preflightGuards(packageJson, path => files.has(path), forgeJson);
    const guards = selectGuards(declaredGuards, changed.paths);
    const declaredTests = new Set(guards.selected.flatMap(guard => guard.tests));
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
              budgetSeconds,
              [...declaredTests, ...changed.paths.filter(isTest)],
              secondsFor,
            ),
          },
        );
    const learnedGuards = (guardSet?.tests ?? []).filter(test => !declaredTests.has(test));
    const guardTests = [...declaredTests, ...learnedGuards];
    // Comment-only edits (an SPDX header, a reworded comment) run the same program: they rank only the
    // tests that read the file. Needs the base bytes on this machine; otherwise nothing is skipped.
    const commentOnly = context?.base
      ? commentOnlyPaths(
          root,
          context.base,
          context.files,
          changed.paths,
          path => files.get(path) ?? laneText(root, path),
        )
      : [];
    const learnedForPaths = learnedTests(root, changed.paths, undefined, test =>
      runnerTestPath(resolved.runner, test),
    );
    const selection = selectPreflightTests({
      files,
      paths: changed.paths,
      guards: guardTests,
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
    let reusedFrom: z.infer<typeof reusedFromSchema> | undefined;
    const saved = context && savedInventory(context.files, files);
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
    tests = [...tests, ...filler];
    const filled = new Set(filler);
    const deferredTests = [...selection.deferredTests, ...cut].filter(test => !filled.has(test)).sort();
    const complete = tests.length + reusedTests.length + deferredTests.length;
    const guarded = new Set(
      selection.tiers.filter(item => protectedTiers.has(item.tier)).flatMap(item => item.tests),
    );
    const local = localSelection({
      selection,
      fit,
      timing,
      budgetSeconds,
      kept,
      mandatory: tests.filter(test => selection.tiers[0]?.tests.includes(test)).length,
      protected: tests.filter(test => guarded.has(test)).length,
      deferred: deferredTests.length,
      guards: [
        ...guards.selected.map(guard => ({
          name: guard.name,
          tests: guard.tests,
          seconds: Math.round(guard.tests.reduce((sum, test) => sum + secondsFor(test), 0) * 10) / 10,
        })),
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
      filler: filler.length,
      trimmedTests: only ? [] : cut.filter(test => !filled.has(test)).sort(),
      rerun: context ? rerunCommand(root, context.laneId) : undefined,
      trim,
      commentOnly,
      only: !!only,
    });
    local.ceiling = runCeiling(options?.budgetSeconds);
    const checks = planStatic(files.get('package.json'), changed.paths, forgeJson);
    if ('reason' in checks) return { status: 'unavailable', reason: checks.reason };
    const plan: PreflightPlan = {
      status: 'planned',
      scope: selection.scope,
      reason: selection.reason,
      tests,
      deferredTests,
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
      ...(selection.tiers.length ? { local } : {}),
      reusedTests,
      ...(reusedFrom ? { reusedFrom } : {}),
      ...(delta ? { deltaPaths: delta } : {}),
      ...(changed.source === 'manifests' ? { changedPathsFrom: 'manifests' as const } : {}),
      // The run's wall-time cap bounds what this plan can cost here: the budget plus one file.
      estimateMinutes: Math.ceil(
        Math.min(
          tests.reduce((sum, test) => sum + secondsFor(test), 0),
          trim ? budgetSeconds + tests.reduce((most, test) => Math.max(most, secondsFor(test)), 0) : Infinity,
        ) / 60,
      ),
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

/** The guard entry the learned set adds to `local.guards`. */
const LEARNED_GUARD_NAME = 'learned guard set';
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
  return (
    `preflight plan: scope ${plan.scope}, ${plan.tests.length} test file(s) here` +
    (reused ? `, ${reused} passed before (reused)` : '') +
    `, ${deferred} deferred to the pre-queue check; ${budget}, about ${plan.estimateMinutes} min.` +
    (plan.runner ? ` Runner: ${plan.runner.label}.` : '') +
    checks +
    (why ? ` Why: ${why}` : '')
  );
}
const PLAN_REASON_CHARS = 400;

/** Runs every ranked local tier with no time budget; reused passes make it run only what was skipped. */
const rerunCommand = (root: string, laneId: string) =>
  `nforge agent ${shellQuote(root)} preflight ${shellQuote(JSON.stringify({ laneId, trim: false }))}`;
/** Runs exactly the files the last run stopped for time (under the same wall-time budget). */
const stoppedCommand = (root: string, laneId: string) =>
  `nforge agent ${shellQuote(root)} preflight ${shellQuote(JSON.stringify({ laneId, retry: true }))}`;

/** What judges a static failure (src/agent-preflight-static.ts): the saved changed paths and, in a
 * hosted Lane, each one's base bytes from the base State manifest and objects already on this machine
 * (no server call). Elsewhere, or when they are not cached, there is no base copy to compare with. */
function staticScope(root: string, changed: string[] | null): StaticScope {
  let marker: ReturnType<typeof readHostedLaneCheckout> = null;
  try {
    marker = readHostedLaneCheckout(root);
  } catch {
    /* Not a hosted Lane: no base copy. */
  }
  const files = marker && changed ? baseStateFiles(root, marker) : null;
  // A folder for checks that keep a cache, and (with CHANGED) hints so they do less on a small change.
  const cache = join(clientCacheRoot(root), 'agent', 'preflight', 'static-cache');
  if (!files) return { changed, cache };
  const base = new Map(files.map(file => [file.path, file]));
  return {
    changed,
    cache,
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
  guards: { name: string; tests: string[]; seconds: number }[];
  guardSet?: GuardSetReport;
  filler: number;
  trimmedTests: string[];
  rerun: string | undefined;
  trim: boolean;
  commentOnly: string[];
  only: boolean;
}): LocalSelection {
  const { fit, timing, budgetSeconds } = input;
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
    ? ' trim:false: every ranked local tier runs, no time budget.'
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
    estimateSeconds: fit.estimateSeconds,
    tiers,
    tierTests,
    trimmed,
    mandatoryOverBudget: fit.mandatoryOverBudget,
    ...(fit.protectedOverBudget ? { protectedOverBudget: true } : {}),
    mandatory: input.mandatory,
    protected: input.protected,
    deferred: input.deferred,
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
      `Local rule: ${preflightTierRule}.` +
      (input.guards.length
        ? ` Guards always run first, never trimmed: ${input.guards.map(guard => `${guard.name} ~${guard.seconds} s`).join(', ')}.`
        : '') +
      (input.guardSet ? ` ${guardSetLine(input.guardSet)}` : '') +
      `${cutNote}${over}${skippedNote}` +
      (input.commentOnly.length
        ? ` ${input.commentOnly.length} comment-only path(s) add only the tests that read them.`
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
  })),
  z
    .object({
      passed: z.array(z.string()),
      failed: z.array(z.string()),
      ms: z.record(z.string(), z.number()),
      skipped: z.record(z.string(), z.string()).default({}),
    })
    .strict(),
]);

/** Runs the triggered static checks, then builds (Forge's own Node layout with build:core) and runs the
 * selected tests here, output to stderr, then records the result for this saved head. stdout stays
 * one JSON receipt. Static checks run first: they take seconds, catch what the landing check's
 * static job would reject, and a failure there ends the run before any build or test. Tests then
 * run mandatory first in groups sized from the speed already observed; an earlier failure or the
 * spent time budget stops later groups and names them. */
type HeldHeavySlot = { env: Record<string, string>; release(): void };
/** One `nforge heavy` slot for this preflight's build and tests, held for this process (c180152a). The
 * synchronous run waits for it in a child (FIFO with every other heavy command); a preflight inside
 * `nforge heavy` reuses that slot. Null when slots are off or the claim fails (the run goes on, said once). */
function holdHeavySlot(cwd: string, base: NodeJS.ProcessEnv): HeldHeavySlot | null {
  const claim = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./preflight-heavy-claim.js', import.meta.url)), String(process.pid), cwd],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let held: { slot: string | null; parent: string | null; slots?: number } | undefined;
  try {
    held = claim.status === 0 ? JSON.parse(claim.stdout) : undefined;
  } catch {}
  if (!held) {
    process.stderr.write('preflight: could not take an nforge heavy slot; running without one.\n');
    return null;
  }
  if (!held.parent) return null;
  const since = Date.now();
  const { slot } = held;
  // The build's checker and any nested test runner get the slot's core share (7008ff18); its own
  // test groups already run --test-concurrency=1.
  const cap = slotCapEnv(base, availableParallelism(), held.slots ?? 0);
  return {
    env: {
      ...cap.env,
      FORGE_HEAVY_PARENT: held.parent,
      ...(process.env.FORGE_HEAVY_DIR ? { FORGE_HEAVY_DIR: process.env.FORGE_HEAVY_DIR } : {}),
    },
    release() {
      cap.dispose();
      if (!slot) return;
      rmSync(slot, { recursive: true, force: true });
      // A synchronous run cannot sample its tree; the load when it ends is the one reading.
      const load = process.platform === 'win32' ? null : Math.round(loadavg()[0]! * 10) / 10;
      recordHold(dirname(slot), Date.now() - since, { at: since, lane: laneOf(cwd), kind: 'test', load });
    },
  };
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
  /** Hold one `nforge heavy` slot for the build and tests (c180152a). The preflight action and the
   * land gate's inline run set it; a fixture run inside a test (already in its runner's slot) does not. */
  options: {
    heavySlot?: boolean;
    quick?: boolean;
    /** This head's static results from the run just before: kept, not run again (land's quick run). */
    staticDone?: NonNullable<PreflightReceipt['static']>;
  } = {},
) {
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
  const failedFiles: string[] = [];
  // Units whose program is not installed here: an environment result, never a failed run.
  const missingPrograms: string[] = [];
  const environmentUnits: string[] = [];
  // The group whose run failed and the start of its error output (file-pinned failures replace the group).
  let failingGroup: string[] = [];
  let failureTail: string | undefined;
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
  let heavy: HeldHeavySlot | null = null;
  try {
    if (options.staticDone) {
      // The receipt kept every field the earlier run returned.
      staticResults = options.staticDone as StaticCheckResult[];
      if (staticResults.some(result => result.outcome === 'failed')) exitCode = 1;
    } else if (plan.static?.selected.length) {
      const checks = plan.static.selected.map(check => ({ ...check, inputs: null }));
      const scope = changed === undefined ? undefined : staticScope(root, changed);
      staticResults = runStaticChecks(
        root,
        checks.filter(check => !isTypecheck(check)),
        cleanEnv(),
        undefined,
        scope,
      );
      // The typecheck script's compiler steps (fix 6): only those whose program holds a changed path.
      const typechecks = checks.filter(isTypecheck);
      if (typechecks.length) {
        const env = typecheckEnv(root, cleanEnv());
        const narrowed = selectTypechecks(root, typechecks, changed, env, command =>
          runTypecheckSetup(root, command, env, STATIC_CHECK_TIMEOUT_MS),
        );
        typecheckUntouched = narrowed.untouched;
        if (narrowed.untouched.length)
          process.stderr.write(
            `preflight: not run here, no changed file is in its program (the landing check still runs it): ${narrowed.untouched.join(', ')}\n`,
          );
        staticResults.push(...runStaticChecks(root, narrowed.selected, env, undefined, scope));
      }
      if (staticResults.some(result => result.outcome === 'failed')) exitCode = 1;
    }
    if (!staticOnly && plan.tests.length && exitCode === 0) {
      // The build and tests count against the machine-wide `nforge heavy` limit (c180152a); their own
      // nested `nforge heavy` calls inherit this lease instead of waiting for a second slot.
      heavy = options.heavySlot ? holdHeavySlot(root, cleanEnv()) : null;
      if (heavy) Object.assign(cleanEnv(), heavy.env);
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
        const build = spawnSync('npm', ['run', '-s', 'build:core'], {
          cwd: root,
          env: cleanEnv(),
          stdio: ['ignore', 2, 2],
        });
        exitCode = build.status;
        buildMs = Date.now() - buildStarted;
      }
      // Degraded file events do not stop the tests (eb9b94ba): they run from the saved file list, which
      // needs no events, and are probed only if they fail, to tell a watcher loss from a real failure.
      if (exitCode === 0) {
        // The clean environment also drops a surrounding test runner's protocol variable
        // (NODE_TEST_CONTEXT), which would swallow this run's own exit code.
        const env = { ...cleanEnv() };
        const directory = mkdtempSync(join(tmpdir(), 'forge-preflight-'));
        // Every group shares one compiled-module cache, removed with the directory (Item dceb1bef).
        // The clean environment never carries an outer one, so this preflight always owns it.
        env.FORGE_TEST_MODULE_DIRECTORY = join(directory, 'modules');
        const testStarted = Date.now();
        const budgetMs = plan.local && plan.local.trim !== false ? plan.local.budgetSeconds * 1000 : Infinity;
        const stats = preflightFileStats(root);
        const fallbackSeconds = plan.local?.secondsPerFile ?? PREFLIGHT_SECONDS_PER_FILE;
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
              env: { ...env, FORGE_PREFLIGHT_REPORT: report },
              stdio: ['ignore', 2, 2],
              ...(left !== null ? { timeout: Math.max(1_000, left) } : {}),
            },
            left === null,
          );
          if (left !== null && run.errorCode === 'ETIMEDOUT') {
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
    heavy?.release();
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
  const rerun = skippedFiles.length ? (plan.local?.rerun ?? rerunCommand(root, laneId)) : undefined;
  const stoppedRerun = notRun.length ? stoppedCommand(root, laneId) : undefined;
  // A clean run that left must-run files unstarted proved nothing about them: NOT COMPLETE.
  const incomplete =
    exitCode === 0 && !environment
      ? incompletePreflight({
          root,
          laneId,
          tierTests: plan.local?.tierTests,
          notRun,
          secondsPerFile,
          ...(needsBrowser.length ? { needs: { ...NEEDS_CHROMIUM, files: [...needsBrowser].sort() } } : {}),
        })
      : undefined;
  const receipt: PreflightReceipt = {
    schema: 1,
    laneId,
    head,
    ...(tree ? { tree } : {}),
    tests: staticOnly ? 0 : plan.tests.length - skipped,
    ...(staticOnly ? { staticOnly: true as const } : {}),
    ...(options.quick && !staticOnly ? { quick: true as const } : {}),
    ...(!staticOnly && evidence && tree === sourceTree(evidence.files)
      ? {
          evidence: writePreflightEvidence(root, {
            ...evidence,
            covered: [...passedTests, ...(plan.reusedTests ?? [])].sort(),
          }),
        }
      : {}),
    ...(!staticOnly && !(evidence && tree === sourceTree(evidence.files)) && plan.tests.length
      ? (() => {
          const ran = ranEvidence([...passedTests, ...(plan.reusedTests ?? [])]);
          return ran === undefined ? {} : { ran };
        })()
      : {}),
    ...(!staticOnly && plan.reusedTests?.length
      ? { reusedTests: plan.reusedTests.length, reusedFrom: plan.reusedFrom }
      : {}),
    ...(plan.deferredTests?.length || skipped || (staticOnly && plan.tests.length)
      ? { deferredTests: (plan.deferredTests?.length ?? 0) + skipped + (staticOnly ? plan.tests.length : 0) }
      : {}),
    ...(notRun.length ? { stoppedForTime: notRun.length, stopped: notRun, stoppedRerun } : {}),
    ...(skippedFiles.length ? { skipped: skippedFiles } : {}),
    ...(rerun ? { rerun } : {}),
    ...(stopped.length ? { stoppedForFailure: stopped.length } : {}),
    ...(staticResults.length ? { static: staticResults } : {}),
    ...(slowest.length ? { slowest } : {}),
    ...(plan.local
      ? {
          rule: plan.local.rule,
          budgetSeconds: plan.local.budgetSeconds,
          ...(plan.local.trimmed.length ? { trimmedTiers: plan.local.trimmed.map(item => item.tier) } : {}),
          ...(plan.deferredTests?.length || skipped ? { deferredTo: plan.local.deferredTo } : {}),
        }
      : {}),
    ...(!staticOnly && plan.tests.length
      ? {
          ceiling: {
            seconds: ceilingMs / 1000,
            ...(ceiling.override ? { override: true as const } : {}),
            ...(ceilingReached ? { reached: true as const } : {}),
          },
        }
      : {}),
    ...(buildMs !== undefined ? { buildMs } : {}),
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
  writePreflightReceipt(root, receipt);
  process.stderr.write(`${runSummary(receipt, plan, typecheckUntouched)}\n`);
  // An incomplete run is still a clean timing sample; only a pass seeds the fallback estimate.
  if (receipt.incomplete && receipt.tests > 0) recordTiming(root, receipt);
  if (receipt.passed && receipt.tests > 0) {
    recordTiming(root, receipt);
    const path = join(retainedRootSibling(root, '.forge-client'), 'agent', 'preflight-estimate.json');
    try {
      mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
      durableReplace(path, JSON.stringify(receipt));
    } catch {
      /* Estimates never invalidate a completed run. */
    }
  }
  return receipt;
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
    ? ` ${receipt.incomplete.mustRun} must-run test file(s) (changed, learned or direct) not started, 0 failed: ${ranOut}` +
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
