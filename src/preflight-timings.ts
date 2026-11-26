// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { durableReplace } from './state/durability.js';
import { retainedRootSibling } from './root-paths.js';
import { type PreflightReceipt, preflightReceiptSchema, retainedReceipt } from './preflight-receipt.js';

/** Default local cost per selected test file at concurrency 1, used for the time estimate. */
export const PREFLIGHT_SECONDS_PER_FILE = 4;

/** Learn from completed local runs, including build time and this machine's load.
 * Sibling Lanes share this clone-local disposable record. It is never uploaded. */
const timingsPath = (root: string) =>
  join(retainedRootSibling(root, '.forge-client'), 'agent', 'preflight-timings.json');
const estimatePath = (root: string) =>
  join(retainedRootSibling(root, '.forge-client'), 'agent', 'preflight-estimate.json');
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
    const sample = preflightReceiptSchema.parse(JSON.parse(readFileSync(estimatePath(root), 'utf8')));
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

export function recordPreflightTiming(root: string, receipt: PreflightReceipt) {
  // An incomplete run is still a clean timing sample; only a pass seeds the fallback estimate.
  if (receipt.incomplete && receipt.tests > 0) recordTiming(root, receipt);
  if (receipt.passed && receipt.tests > 0) {
    recordTiming(root, receipt);
    const path = estimatePath(root);
    try {
      mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
      durableReplace(path, retainedReceipt(receipt));
    } catch {
      /* Estimates never invalidate a completed run. */
    }
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
export function recordFileStats(
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
