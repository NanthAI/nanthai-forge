// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, posix } from 'node:path';
import { z } from 'zod';
import { selectTests, selectionSourcePath } from '../scripts/test-impact.mjs';
import { shellQuote } from './agent-brief-render.js';

/** Default local cost per selected test file at concurrency 1, used for the time estimate. */
export const PREFLIGHT_SECONDS_PER_FILE = 4;
const SOURCE_DIRS = ['src', 'web', 'convex', 'netlify', 'tests', 'scripts'];

export const preflightReceiptSchema = z
  .object({
    schema: z.literal(1),
    laneId: z.string(),
    head: z.string(),
    tests: z.number().int().nonnegative(),
    selection: z.string(),
    exitCode: z.number().int().nullable(),
    passed: z.boolean(),
    durationMs: z.number().nonnegative(),
    at: z.string(),
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
    };

const receiptPath = (root: string, laneId: string) =>
  join(`${root}.forge-client`, 'agent', 'preflight', `${laneId}.json`);

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
    const selection = selectTests({ files: laneFiles(root), paths: changed.paths });
    const tests = [...new Set(selection.tests)].sort();
    return {
      status: 'planned',
      scope: selection.scope,
      reason: selection.reason,
      tests,
      estimateMinutes: Math.ceil((tests.length * PREFLIGHT_SECONDS_PER_FILE) / 60),
      command: tests.length
        ? ['node', ...testArgs(root, tests)]
            .map(arg => (/^[\w./=-]+$/.test(arg) ? arg : shellQuote(arg)))
            .join(' ')
        : null,
    };
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
) {
  const started = Date.now();
  let exitCode: number | null = 0;
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
      exitCode = spawnSync(process.execPath, testArgs(root, plan.tests), {
        cwd: root,
        env,
        stdio: ['ignore', 2, 2],
      }).status;
    }
  }
  const receipt: PreflightReceipt = {
    schema: 1,
    laneId,
    head,
    tests: plan.tests.length,
    selection: plan.scope,
    exitCode,
    passed: exitCode === 0,
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  };
  writePreflightReceipt(root, receipt);
  return receipt;
}
