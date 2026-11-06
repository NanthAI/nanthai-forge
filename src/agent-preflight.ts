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
import { z } from 'zod';
import {
  fitPreflightBudget,
  preflightTierRule,
  selectTests,
  selectPreflightTests,
  selectionSourcePath,
} from '../scripts/test-impact.mjs';
import { spawnMeasured } from './agent-preflight-measure.js';
import {
  runStaticChecks,
  selectStaticChecks,
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
  filesystemEventHealth,
  filesystemEnvironment,
  filesystemEnvironmentSchema,
} from './filesystem-event-health.js';

export const preflightRuntime = { filesystemEventHealth };

/** Default local cost per selected test file at concurrency 1, used for the time estimate. */
export const PREFLIGHT_SECONDS_PER_FILE = 4;
/** Local time budget (seconds) for tests beyond the mandatory set. It trims by estimated time, never
 * by file count; whatever it cuts is named in the plan and runs in the pre-queue Lane check. */
export const PREFLIGHT_LOCAL_BUDGET_SECONDS = 180;
/** Longest a later group is planned to run (seconds). The run re-checks the budget between groups and
 * sizes the next one from the speed it observed, so this is only how finely it can stop, never how
 * many tests may run. */
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
    environment: filesystemEnvironmentSchema.optional(),
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
  trimmed: { tier: string; kept: number; total: number }[];
  mandatoryOverBudget: boolean;
  /** Leading tests that always run: changed tests, explicit coverage and smoke not already passed. */
  mandatory: number;
  deferred: number;
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
    };

const preparedEvidence = new WeakMap<PreflightPlan, PreflightEvidence>();
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
 * ends the run), then the cheapest known first so more of the neighbourhood fits the budget. The
 * `watch` tier keeps its evidence order. Tier membership never changes. */
export function orderByHistory<T extends { tier: string; tests: string[] }>(
  tiers: T[],
  stats: PreflightFileStats,
  fallbackMs: number,
): T[] {
  const cost = (test: string) => stats[test]?.ms ?? fallbackMs;
  return tiers.map(item => {
    const index = new Map(item.tests.map((test, i) => [test, i]));
    const order = (test: string) => index.get(test) ?? 0;
    const tests = [...item.tests].sort((a, b) => {
      const failed = Number(stats[b]?.failed ?? false) - Number(stats[a]?.failed ?? false);
      if (failed) return failed;
      return item.tier === 'watch' ? order(a) - order(b) : cost(a) - cost(b) || order(a) - order(b);
    });
    return { ...item, tests };
  });
}

export function estimatePreflightMinutes(root: string, files: number) {
  return Math.ceil((files * preflightSecondsPerFile(root).secondsPerFile) / 60);
}

/** Selector input from the Lane checkout; absent directories are simply absent. */
function laneFiles(root: string) {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && selectionSourcePath(path))
        files.set(path, readFileSync(join(root, path), 'utf8'));
    }
  };
  for (const dir of SOURCE_DIRS) if (existsSync(join(root, dir))) walk(dir);
  for (const file of ['package.json', 'package-lock.json'])
    if (existsSync(join(root, file))) files.set(file, readFileSync(join(root, file), 'utf8'));
  return files;
}

const testArgs = (root: string, tests: string[]) => [
  ...(existsSync(join(root, 'tests/check-runtime.mjs')) ? ['--import', './tests/check-runtime.mjs'] : []),
  '--test',
  '--test-concurrency=1',
  ...tests,
];

/** The landing check's shared selector over the saved changes (base to head). Unknown paths mean
 * no plan: missing observations never block a landing. */
export function preflightPlan(
  root: string,
  changed: { paths: string[]; complete: boolean; source?: 'projection' | 'manifests' } | undefined,
  context?: { laneId: string; files: NativeFile[] },
  options?: { budgetSeconds?: number | undefined },
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
    const files = laneFiles(root);
    const selection = selectPreflightTests({ files, paths: changed.paths });
    const timing = preflightSecondsPerFile(root);
    const stats = preflightFileStats(root);
    selection.tiers = orderByHistory(selection.tiers, stats, timing.secondsPerFile * 1000);
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
      selection.reason += '; incomplete local source inventory: full landing coverage, no receipt reuse';
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
    const budgetSeconds = options?.budgetSeconds ?? PREFLIGHT_LOCAL_BUDGET_SECONDS;
    const fit = fitPreflightBudget({
      tiers: selection.tiers,
      budgetSeconds,
      secondsPerFile: timing.secondsPerFile,
      secondsFor: test => (stats[test] ? stats[test].ms / 1000 : timing.secondsPerFile),
      free: new Set(reusedTests),
    });
    const kept = new Set(fit.tests);
    const cut = fit.trimmed.flatMap(item => item.deferred);
    tests = tests.filter(test => kept.has(test));
    // Budget the tiers did not use goes to the cheapest landing-covered tests an earlier run timed
    // (a computed-path guard that takes milliseconds should not wait for the pre-queue check). Tests
    // never timed here are not guessed at, and these run last, after every ranked test.
    const pool = [...selection.deferredTests, ...cut].filter(
      test => stats[test] && !reusedTests.includes(test),
    );
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
    const local = localSelection({
      selection,
      fit,
      timing,
      budgetSeconds,
      kept,
      mandatory: tests.filter(test => selection.tiers[0]?.tests.includes(test)).length,
      deferred: deferredTests.length,
      filler: filler.length,
    });
    const checks = planStatic(files.get('package.json'), changed.paths);
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
      estimateMinutes: estimatePreflightMinutes(root, tests.length),
      totalEstimateMinutes: estimatePreflightMinutes(root, complete),
      command: tests.length
        ? ['node', ...testArgs(root, tests)]
            .map(arg => (/^[\w./=-]+$/.test(arg) ? arg : shellQuote(arg)))
            .join(' ')
        : null,
    };
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

function planStatic(packageJson: string | undefined, paths: string[]) {
  try {
    return selectStaticChecks(staticChecks(packageJson), paths);
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
  deferred: number;
  filler: number;
}): LocalSelection {
  const { fit, timing, budgetSeconds } = input;
  const tiers = input.selection.tiers.map(item => ({
    tier: item.tier,
    total: item.tests.length,
    local: item.tests.filter(test => input.kept.has(test)).length,
  }));
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
  const over = fit.mandatoryOverBudget
    ? ` Changed tests, explicit coverage and smoke alone exceed the ${budgetSeconds} s budget; they still all run.`
    : '';
  return {
    rule: preflightTierRule,
    budgetSeconds,
    secondsPerFile: timing.secondsPerFile,
    basis: timing.basis,
    estimateSeconds: fit.estimateSeconds,
    tiers,
    trimmed,
    mandatoryOverBudget: fit.mandatoryOverBudget,
    mandatory: input.mandatory,
    deferred: input.deferred,
    ...(input.filler ? { filler: input.filler } : {}),
    deferredTo: 'pre-queue',
    summary:
      `Local rule: ${preflightTierRule}.${cutNote}${over}` +
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

/** Runs the triggered static checks, then builds (when the project has build:core) and runs the
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
  let exitCode: number | null = 0;
  let environment: PreflightReceipt['environment'];
  const environmentNext = `nforge agent ${shellQuote(root)} land --save ${shellQuote(JSON.stringify({ laneId }))}`;
  const passedTests: string[] = [];
  const notRun: string[] = [];
  const stopped: string[] = [];
  const fileMs: Record<string, number> = {};
  const failedFiles: string[] = [];
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
    const scripts = (() => {
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
      const budgetMs = plan.local ? plan.local.budgetSeconds * 1000 : Infinity;
      const stats = preflightFileStats(root);
      const fallbackSeconds = plan.local?.secondsPerFile ?? PREFLIGHT_SECONDS_PER_FILE;
      // Mandatory tests always run, in one process. Later tests run in proximity order in groups of
      // about PREFLIGHT_GROUP_SECONDS, each sized from this run's observed speed (so a machine
      // slower than the estimate gets small groups), and the budget is re-checked between groups: a
      // slow machine stops early and says so, it never overruns silently on a wrong estimate.
      const mandatory = plan.local?.mandatory ?? plan.tests.length;
      const queue = plan.tests.slice(mandatory);
      let ran = 0;
      let index = 0;
      const runGroup = (group: string[]) => {
        const report = join(directory, `passed-${index++}.json`);
        const groupStarted = Date.now();
        const run = spawnMeasured(
          process.execPath,
          [
            // dot: one character per passing test and the full detail of failures only (TAP printed every
            // subtest, about 150 KB of an agent's context per preflight).
            '--test-reporter=dot',
            '--test-reporter-destination=stderr',
            `--test-reporter=${new URL('./agent-preflight-reporter.js', import.meta.url).href}`,
            '--test-reporter-destination=stdout',
            ...testArgs(root, group),
          ],
          {
            cwd: root,
            env: { ...env, FORGE_PREFLIGHT_REPORT: report },
            stdio: ['ignore', 2, 2],
          },
        );
        ran += group.length;
        if (run.status !== 0 && exitCode === 0) exitCode = run.status;
        if (run.peakRssMb !== null) peakRssMb = Math.max(peakRssMb ?? 0, run.peakRssMb);
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
        const first = plan.tests.slice(0, mandatory);
        let spent = first.length ? runGroup(first) : 0;
        // Seconds per file seen in this run; the estimate stands in until a group has run.
        let observed = first.length ? spent / 1000 / first.length : fallbackSeconds;
        while (queue.length) {
          if (exitCode !== 0) {
            stopped.push(...queue.splice(0));
            break;
          }
          const remaining = (budgetMs - (Date.now() - started)) / 1000;
          if (remaining <= 0) {
            notRun.push(...queue.splice(0));
            break;
          }
          const window = Math.min(remaining, PREFLIGHT_GROUP_SECONDS);
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
          observed = spent / 1000 / ran;
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
  if (plan.tests.length && (Object.keys(fileMs).length || failedFiles.length))
    recordFileStats(root, { passed: passedTests, failed: failedFiles, ms: fileMs });
  const slowest = Object.entries(fileMs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([file, ms]) => ({ file, ms: Math.round(ms) }));
  const evidence = preparedEvidence.get(plan);
  const skipped = notRun.length + stopped.length;
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
    ...(notRun.length ? { stoppedForTime: notRun.length } : {}),
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
    ? ` The ${receipt.budgetSeconds} s local budget ran out, so ${receipt.stoppedForTime} planned test file(s) were not started.`
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
    (deferred
      ? ` ${deferred} test file(s) deferred; they run in the pre-queue Lane check (on by default).`
      : ' No test file deferred.')
  );
}
