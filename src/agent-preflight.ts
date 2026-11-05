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
import { selectTests, selectPreflightTests, selectionSourcePath } from '../scripts/test-impact.mjs';
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

/** Default local cost per selected test file at concurrency 1, used for the time estimate. */
export const PREFLIGHT_SECONDS_PER_FILE = 4;
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
    evidence: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    reusedTests: z.number().int().nonnegative().optional(),
    reusedFrom: reusedFromSchema.optional(),
    deferredTests: z.number().int().nonnegative().optional(),
  })
  .strict();
export type PreflightReceipt = z.infer<typeof preflightReceiptSchema>;
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
      reusedTests?: string[];
      reusedFrom?: z.infer<typeof reusedFromSchema>;
      deltaPaths?: string[];
      totalEstimateMinutes?: number;
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
export function estimatePreflightMinutes(root: string, files: number) {
  let secondsPerFile = PREFLIGHT_SECONDS_PER_FILE;
  try {
    const sample = preflightReceiptSchema.parse(
      JSON.parse(
        readFileSync(
          join(retainedRootSibling(root, '.forge-client'), 'agent', 'preflight-estimate.json'),
          'utf8',
        ),
      ),
    );
    if (sample.passed && sample.tests > 0) secondsPerFile = sample.durationMs / sample.tests / 1000;
  } catch {
    /* A cold or corrupt model uses the documented fallback. */
  }
  return Math.ceil((files * secondsPerFile) / 60);
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
  changed: { paths: string[]; complete: boolean } | undefined,
  context?: { laneId: string; files: NativeFile[] },
): PreflightPlan {
  if (!changed?.complete) return { status: 'unavailable', reason: 'saved changed paths are unavailable' };
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
    let tests = [...new Set(selection.tests)].sort();
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
          reusedFrom = { head: receipt.head, tree: receipt.tree, evidence: receipt.evidence };
      }
    }
    const plan: PreflightPlan = {
      status: 'planned',
      scope: selection.scope,
      reason: selection.reason,
      tests,
      deferredTests: selection.deferredTests,
      reusedTests,
      ...(reusedFrom ? { reusedFrom } : {}),
      ...(delta ? { deltaPaths: delta } : {}),
      estimateMinutes: estimatePreflightMinutes(root, tests.length),
      totalEstimateMinutes: estimatePreflightMinutes(
        root,
        selection.tests.length + selection.deferredTests.length,
      ),
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

/** Builds (when the project has build:core) and runs the selected tests here, output to stderr, then
 * records the result for this saved head. stdout stays one JSON receipt. */
export function runPreflight(
  root: string,
  laneId: string,
  head: string,
  plan: PreflightPlan & { status: 'planned' },
  tree?: string,
) {
  const started = Date.now();
  let exitCode: number | null = 0;
  let passedTests: string[] = [];
  if (plan.tests.length) {
    const scripts = (() => {
      try {
        return (
          JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
        ).scripts;
      } catch {
        return undefined;
      }
    })();
    if (scripts?.['build:core']) {
      const build = spawnSync('npm', ['run', '-s', 'build:core'], { cwd: root, stdio: ['ignore', 2, 2] });
      exitCode = build.status;
    }
    if (exitCode === 0) {
      // A surrounding test runner's protocol variable would swallow this run's own exit code.
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const directory = mkdtempSync(join(tmpdir(), 'forge-preflight-'));
      const report = join(directory, 'passed.json');
      try {
        exitCode = spawnSync(
          process.execPath,
          [
            '--test-reporter=tap',
            '--test-reporter-destination=stderr',
            `--test-reporter=${new URL('./agent-preflight-reporter.js', import.meta.url).href}`,
            '--test-reporter-destination=stdout',
            ...testArgs(root, plan.tests),
          ],
          {
            cwd: root,
            env: { ...env, FORGE_PREFLIGHT_REPORT: report },
            stdio: ['ignore', 2, 2],
          },
        ).status;
        try {
          const observed = z.array(z.string()).parse(JSON.parse(readFileSync(report, 'utf8')));
          passedTests = plan.tests.filter(test => observed.includes(test));
        } catch {
          /* Missing report: no per-file pass is reusable. */
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
  const evidence = preparedEvidence.get(plan);
  const receipt: PreflightReceipt = {
    schema: 1,
    laneId,
    head,
    ...(tree ? { tree } : {}),
    tests: plan.tests.length,
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
    ...(plan.deferredTests?.length ? { deferredTests: plan.deferredTests.length } : {}),
    selection: plan.deferredTests?.length ? 'local' : plan.scope,
    exitCode,
    passed: exitCode === 0,
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  };
  writePreflightReceipt(root, receipt);
  if (receipt.passed && receipt.tests > 0) {
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
