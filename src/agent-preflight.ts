// SPDX-License-Identifier: Apache-2.0
import { durableReplace } from './native-durability.js';
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
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { safeRelative } from './files.js';
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
import { learnFailures, learnedTests, recentFailedTests } from './preflight-learned.js';
import { commentOnlyPaths } from './preflight-comment-only.js';
import { spawnMeasured } from './agent-preflight-measure.js';
import {
  runStaticChecks,
  selectGuards,
  selectStaticChecks,
  preflightGuards,
  staticChecks,
  type StaticCheckResult,
} from './agent-preflight-static.js';
import type { NativeFile } from './native-state-format.js';
import { sourceTree } from './source-tree.js';
import {
  deltaPaths,
  preflightDefinition,
  readPreflightEvidence,
  savedInventory,
  writePreflightEvidence,
  type PreflightEvidence,
} from './agent-preflight-evidence.js';
import { shellQuote } from './agent-brief-render.js';
import {
  orderRunnerTests,
  projectTestRunner,
  runnerCommand,
  runnerLabel,
  runnerSelection,
  type TestRunner,
  type TestRunnerResolution,
} from './project-test-runner.js';
import { FORGE_CONFIG_FILE } from './project-config.js';
import {
  packageGraphFor,
  packageGraphKey,
  type PackageGraph,
  type SelectedPackage,
} from './package-graph.js';
import { packageRunnerTests, packageTestSelection } from './package-test-selection.js';
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
    selection: z.string(),
    exitCode: z.number().int().nullable(),
    passed: z.boolean(),
    durationMs: z.number().nonnegative(),
    at: z.string(),
    environment: z.union([filesystemEnvironmentSchema, toolchainEnvironmentSchema]).optional(),
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
            outcome: z.enum(['passed', 'failed', 'timed-out']),
            ms: z.number().nonnegative(),
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
  /** false: run every ranked local tier, no time budget (the rerun command). */
  trim?: false;
  /** Changed paths whose edit is comment-only: they add only tests that read their text. */
  commentOnly?: string[];
  /** Set when the plan runs only the files a previous run stopped for time. */
  only?: 'stopped';
  deferred: number;
  /** Declared guards this change triggered: always run first, never trimmed; `seconds` is the cost
   * (measured on this machine where known, else the per-file estimate). */
  guards?: { name: string; tests: string[]; seconds: number }[];
  /** Cheap tests an earlier run timed, added last with budget the ranked tiers left over. */
  filler?: number;
  deferredTo: 'pre-queue';
  summary: string;
};
export type PreflightPlan =
  | { status: 'unavailable'; reason: string }
  | {
      status: 'planned';
      scope: string;
      reason: string;
      tests: string[];
      estimateMinutes: number;
      command: string | null;
      deferredTests?: string[];
      /** Static checks this change triggers, run before any test; `untouched` names the rest. */
      static?: { selected: { name: string; command: string[] }[]; untouched: string[] };
      local?: LocalSelection;
      reusedTests?: string[];
      reusedFrom?: z.infer<typeof reusedFromSchema>;
      deltaPaths?: string[];
      totalEstimateMinutes?: number;
      /** Set when the server projection lacked this head's paths and the pinned State manifests supplied them. */
      changedPathsFrom?: 'manifests';
      /** A project runner other than Forge's Node layout (src/project-test-runner.ts) runs the tests. */
      runner?: { label: string; command: string[] };
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
    };

const preparedEvidence = new WeakMap<PreflightPlan, PreflightEvidence>();
/** The changed paths a plan was made for, so a failing run can teach them (never printed). */
const plannedPaths = new WeakMap<PreflightPlan, string[]>();
const receiptPath = (root: string, laneId: string) =>
  join(clientCacheRoot(root), 'agent', 'preflight', `${laneId}.json`);

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
): PreflightPlan {
  const checks = planStatic(packageJson, paths, forgeJson);
  if ('reason' in checks) return { status: 'unavailable', reason: checks.reason };
  const statics =
    checks.selected.length || checks.untouched.length
      ? {
          static: {
            selected: checks.selected.map(({ name, command }) => ({ name, command })),
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
  if (runner.layout === 'packages') return packagePlan(root, runner, paths, graph!(), statics, keep);
  const selection = runnerSelection(runner, allPaths, paths);
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
  const mandatory = [...new Set([...guards.flatMap(guard => guard.tests), ...selection.changedTests])];
  const named = new Set([...mandatory, ...selection.namedTests]);
  const tiers = [
    { tier: 'mandatory', tests: keep(mandatory) },
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
  const timing = preflightSecondsPerFile(root);
  const stats = preflightFileStats(root);
  const secondsFor = (test: string) => (stats[test] ? stats[test].ms / 1000 : timing.secondsPerFile);
  const budgetSeconds = options.budgetSeconds ?? PREFLIGHT_LOCAL_BUDGET_SECONDS;
  const trim = options.trim !== false;
  const seconds = tests.reduce((sum, test) => sum + secondsFor(test), 0);
  const label = runnerLabel(runner);
  const rule = `${label}: changed test files, then tests named for a changed module (closest folder first), then tests in affected packages`;
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
    ...(only ? { only: 'stopped' as const } : {}),
    deferredTo: 'pre-queue',
    summary: `Local rule: ${rule}. ${selection.reason}.`,
    ...(guards.length
      ? {
          guards: guards.map(guard => ({
            name: guard.name,
            tests: guard.tests,
            seconds: Math.round(guard.tests.reduce((sum, test) => sum + secondsFor(test), 0) * 10) / 10,
          })),
        }
      : {}),
  };
  const plan: PreflightPlan = {
    status: 'planned',
    scope: selection.scope,
    reason: selection.reason,
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
    runner: { label, command: runner.command },
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

/** A package-graph runner's plan: one queued unit per ecosystem command (src/package-graph.ts). */
function packagePlan(
  root: string,
  runner: TestRunner,
  paths: string[],
  graph: PackageGraph,
  statics: Partial<Pick<PreflightPlan & { status: 'planned' }, 'static'>>,
  keep: (tests: string[]) => string[],
): PreflightPlan {
  const selection = packageTestSelection(graph, paths);
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
    advisory: INFERRED_RUNNER_ADVISORY,
    packageCommands: commands,
    packages: selection.packages,
    command: selection.command,
  };
  plannedPaths.set(plan, paths);
  return plan;
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
export function preflightPlan(
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
      );
      if (plan.status === 'planned' && changed.source === 'manifests') plan.changedPathsFrom = 'manifests';
      return plan;
    }
    const timing = preflightSecondsPerFile(root);
    const stats = preflightFileStats(root);
    const budgetSeconds = options?.budgetSeconds ?? PREFLIGHT_LOCAL_BUDGET_SECONDS;
    const trim = options?.trim !== false;
    const secondsFor = (test: string) => (stats[test] ? stats[test].ms / 1000 : timing.secondsPerFile);
    const declaredGuards = preflightGuards(files.get('package.json'), path => files.has(path), forgeJson);
    const guards = selectGuards(declaredGuards, changed.paths);
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
    const selection = selectPreflightTests({
      files,
      paths: changed.paths,
      guards: guards.selected.flatMap(guard => guard.tests),
      learned: learnedTests(root, changed.paths),
      recent: recentFailedTests(root),
      ...(commentOnly.length ? { commentOnly } : {}),
      // Direct tests of the most specific changed modules are protected while they fit the budget.
      ...(trim ? { hubBudget: { seconds: budgetSeconds, secondsFor } } : {}),
    });
    selection.tiers = orderByHistory(
      selection.tiers,
      stats,
      timing.secondsPerFile * 1000,
      selection.ranks,
      selection.relevance,
    );
    selection.tests = selection.tiers.flatMap(item => item.tests);
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
      guards: guards.selected.map(guard => ({
        name: guard.name,
        tests: guard.tests,
        seconds: Math.round(guard.tests.reduce((sum, test) => sum + secondsFor(test), 0) * 10) / 10,
      })),
      filler: filler.length,
      trimmedTests: only ? [] : cut.filter(test => !filled.has(test)).sort(),
      rerun: context ? rerunCommand(root, context.laneId) : undefined,
      trim,
      commentOnly,
      only: !!only,
    });
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
              selected: checks.selected.map(({ name, command }) => ({ name, command })),
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

/** One line naming what a run will do: scope, file counts, budget, estimate, static checks and why. */
export function planLine(plan: PreflightPlan & { status: 'planned' }) {
  const deferred = plan.deferredTests?.length ?? 0;
  const reused = plan.reusedTests?.length ?? 0;
  const budget = plan.local
    ? plan.local.trim === false
      ? 'no time budget (trim:false)'
      : `${plan.local.budgetSeconds} s budget`
    : 'no time budget';
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
      ? ` Protected tests (changed, learned, direct) alone exceed the ${budgetSeconds} s budget: they run first, closest first, and the wall clock stops the rest by name.`
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
        ? `${input.deferred} test file(s) deferred; they run in the pre-queue Lane check (on by default; ` +
          'acceptance.admissionCheck:false opts out, then the queue check runs them first).'
        : 'No test file deferred.'),
  };
}

const observationSchema = z.union([
  z
    .array(z.string())
    .transform(passed => ({ passed, failed: [] as string[], ms: {} as Record<string, number> })),
  z
    .object({
      passed: z.array(z.string()),
      failed: z.array(z.string()),
      ms: z.record(z.string(), z.number()),
    })
    .strict(),
]);

/** Runs the triggered static checks, then builds (Forge's own Node layout with build:core) and runs the
 * selected tests here, output to stderr, then records the result for this saved head. stdout stays
 * one JSON receipt. Static checks run first: they take seconds, catch what the landing check's
 * static job would reject, and a failure there ends the run before any build or test. Tests then
 * run mandatory first in groups sized from the speed already observed; an earlier failure or the
 * spent time budget stops later groups and names them. */
export function runPreflight(
  root: string,
  laneId: string,
  head: string,
  plan: PreflightPlan & { status: 'planned' },
  tree?: string,
) {
  const started = Date.now();
  // Before anything runs: a long run must never be silent about what it is doing and why.
  process.stderr.write(`${planLine(plan)}\n`);
  let exitCode: number | null = 0;
  let environment: PreflightReceipt['environment'];
  const environmentNext = `nforge agent ${shellQuote(root)} land --save ${shellQuote(JSON.stringify({ laneId }))}`;
  const passedTests: string[] = [];
  const notRun: string[] = [];
  const stopped: string[] = [];
  const fileMs: Record<string, number> = {};
  const failedFiles: string[] = [];
  // Units whose program is not installed here: an environment result, never a failed run.
  const missingPrograms: string[] = [];
  const environmentUnits: string[] = [];
  let buildMs: number | undefined;
  let testMs: number | undefined;
  let peakRssMb: number | null = null;
  let staticResults: StaticCheckResult[] = [];
  if (plan.static?.selected.length) {
    staticResults = runStaticChecks(
      root,
      plan.static.selected.map(({ name, command }) => ({
        name,
        command,
        inputs: null,
        source: 'declared' as const,
      })),
    );
    if (staticResults.some(result => result.outcome === 'failed')) exitCode = 1;
  }
  if (plan.tests.length && exitCode === 0) {
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
        stdio: ['ignore', 2, 2],
      });
      exitCode = build.status;
      buildMs = Date.now() - buildStarted;
    }
    if (exitCode === 0) {
      const health = preflightRuntime.filesystemEventHealth(root);
      if (!health.ok) environment = filesystemEnvironment(health, environmentNext);
    }
    if (exitCode === 0 && !environment) {
      // A surrounding test runner's protocol variable would swallow this run's own exit code.
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const directory = mkdtempSync(join(tmpdir(), 'forge-preflight-'));
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
      const queue = [...plan.tests];
      let ran = 0;
      let index = 0;
      const runGroup = (group: string[]) => {
        const report = join(directory, `passed-${index++}.json`);
        const groupStarted = Date.now();
        if (plan.packageCommands) {
          // Package commands: one process per unit, in its package folder; a pass covers that unit.
          for (const [at, unit] of group.entries()) {
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
            const run = spawnMeasured(command.argv[0]!, command.argv.slice(1), {
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
            if (run.status === 0) passedTests.push(unit);
            else {
              failedFiles.push(unit);
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
        const run = spawnMeasured(argv[0]!, argv.slice(1), {
          cwd: root,
          env: { ...env, FORGE_PREFLIGHT_REPORT: report },
          stdio: ['ignore', 2, 2],
        });
        if (plan.runner && missingProgramExit(run.status, run.errorCode)) {
          // The runner's program is not installed here: these files are the landing check's.
          missingPrograms.push(argv[0]!);
          environmentUnits.push(...group);
          process.stderr.write(`preflight: ${argv[0]} is not installed here (exit 127); not run\n`);
          return Date.now() - groupStarted;
        }
        ran += group.length;
        if (run.status !== 0 && exitCode === 0) exitCode = run.status;
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
          passedTests.push(...group.filter(test => observed.passed.includes(test)));
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
          const remaining = (budgetMs - (Date.now() - testStarted)) / 1000;
          // The first group always runs (a budget of 0 still runs one file, the most relevant).
          if (remaining <= 0 && ran) {
            notRun.push(...queue.splice(0));
            break;
          }
          const window = Math.max(0, Math.min(remaining, PREFLIGHT_GROUP_SECONDS));
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
  if (!environment && missingPrograms.length)
    environment = toolchainEnvironment(missingPrograms, environmentUnits, environmentNext);
  if (plan.tests.length && (Object.keys(fileMs).length || failedFiles.length))
    recordFileStats(root, { passed: passedTests, failed: failedFiles, ms: fileMs });
  // A failure here is evidence that these tests matter for these paths: the next plan protects them.
  const paths = plannedPaths.get(plan);
  if (paths && failedFiles.length) learnFailures(root, paths, failedFiles);
  const slowest = Object.entries(fileMs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([file, ms]) => ({ file, ms: Math.round(ms) }));
  const evidence = preparedEvidence.get(plan);
  const skipped = notRun.length + stopped.length + environmentUnits.length;
  const skippedFiles = [...(plan.local?.trimmedTests ?? []), ...notRun].sort();
  const rerun = skippedFiles.length ? (plan.local?.rerun ?? rerunCommand(root, laneId)) : undefined;
  const stoppedRerun = notRun.length ? stoppedCommand(root, laneId) : undefined;
  const receipt: PreflightReceipt = {
    schema: 1,
    laneId,
    head,
    ...(tree ? { tree } : {}),
    tests: plan.tests.length - skipped,
    ...(evidence && tree === sourceTree(evidence.files)
      ? {
          evidence: writePreflightEvidence(root, {
            ...evidence,
            covered: [...passedTests, ...(plan.reusedTests ?? [])].sort(),
          }),
        }
      : {}),
    ...(plan.reusedTests?.length
      ? { reusedTests: plan.reusedTests.length, reusedFrom: plan.reusedFrom }
      : {}),
    ...(plan.deferredTests?.length || skipped
      ? { deferredTests: (plan.deferredTests?.length ?? 0) + skipped }
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
    ...(buildMs !== undefined ? { buildMs } : {}),
    ...(testMs !== undefined ? { testMs } : {}),
    ...(peakRssMb !== null ? { peakRssMb } : {}),
    selection: plan.deferredTests?.length || skipped ? 'local' : plan.scope,
    exitCode,
    passed: exitCode === 0 && !environment,
    ...(environment ? { environment, exitCode: exitCode || null } : {}),
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  };
  writePreflightReceipt(root, receipt);
  process.stderr.write(`${runSummary(receipt, plan)}\n`);
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

/** Longest skipped list the closing line spells out; the receipt always names every file. */
const SKIPPED_NAMED = 20;
/** The builder's closing line: what ran, how long it took, and what waits for the pre-queue check. */
function runSummary(receipt: PreflightReceipt, plan: PreflightPlan & { status: 'planned' }) {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const timing = [
    receipt.buildMs !== undefined ? `build ${seconds(receipt.buildMs)}` : '',
    receipt.testMs !== undefined ? `tests ${seconds(receipt.testMs)}` : '',
    receipt.peakRssMb !== undefined ? `peak RSS ${receipt.peakRssMb} MB` : 'peak RSS unmeasured',
  ].filter(Boolean);
  const deferred = receipt.deferredTests ?? 0;
  const stopped = receipt.stoppedForTime
    ? ` The ${receipt.budgetSeconds} s local budget ran out, so ${receipt.stoppedForTime} planned test file(s) were not started` +
      ` (receipt.stopped names them${
        receipt.stopped && receipt.stopped.length <= SKIPPED_NAMED ? `: ${receipt.stopped.join(' ')}` : ''
      }); run just those: ${receipt.stoppedRerun}.`
    : '';
  const failedFirst = receipt.stoppedForFailure
    ? ` ${receipt.stoppedForFailure} planned test file(s) were not started because an earlier group failed; fix it and run preflight again (passed files are reused).`
    : '';
  const checks = receipt.static?.length
    ? ` Static: ${receipt.static.map(item => `${item.name} ${item.outcome} ${seconds(item.ms)}`).join(', ')}${
        receipt.static.some(item => item.outcome === 'failed') ? ' (tests not run)' : ''
      }.` +
      (receipt.static.some(item => item.outcome === 'timed-out')
        ? ' A timed-out static check was not run here; the landing check runs it.'
        : '')
    : '';
  const untouched = plan.static?.untouched.length
    ? ` Static checks not triggered by this change: ${plan.static.untouched.join(', ')}.`
    : '';
  const slow = receipt.slowest?.length
    ? ` Slowest: ${receipt.slowest.map(item => `${item.file} ${seconds(item.ms)}`).join(', ')}.`
    : '';
  return (
    `preflight: ${receipt.passed ? 'passed' : 'FAILED'}, ${receipt.tests} test file(s) in ${seconds(receipt.durationMs)} (${timing.join(', ')}).` +
    checks +
    untouched +
    stopped +
    failedFirst +
    slow +
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
      ? ` ${deferred} test file(s) deferred; they run in the pre-queue Lane check (on by default).`
      : ' No test file deferred.')
  );
}
