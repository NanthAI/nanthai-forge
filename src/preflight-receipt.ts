// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { clientCacheRoot } from './root-paths.js';
import { dependenciesEnvironmentSchema } from './preflight-dependencies.js';
import { filesystemEnvironmentSchema } from './filesystem-event-health.js';
import { preflightTimeSettingsSchema } from './preflight-time-settings.js';
import { toolchainEnvironmentSchema } from './preflight-toolchain.js';

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
    /** Files killed at the per-file limit (a fixture that never resolves), with their run time. */
    timedOut: z
      .array(z.object({ file: z.string(), seconds: z.number().nonnegative() }).strict())
      .max(10)
      .optional(),
    /** The slowest test files of this run, so a long preflight names its cause. */
    slowest: z
      .array(z.object({ file: z.string(), ms: z.number().nonnegative() }).strict())
      .max(3)
      .optional(),
    /** Selection rule, budget and cut, so a receipt says what was left for the pre-queue check. */
    rule: z.string().optional(),
    budgetSeconds: z.number().nonnegative().optional(),
    timeSettings: preflightTimeSettingsSchema.optional(),
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

const receiptPath = (root: string, laneId: string) =>
  join(clientCacheRoot(root), 'agent', 'preflight', `${laneId}.json`);
export function readPreflightReceipt(root: string, laneId: string): PreflightReceipt | null {
  try {
    return preflightReceiptSchema.parse(JSON.parse(readFileSync(receiptPath(root, laneId), 'utf8')));
  } catch {
    return null;
  }
}
export function retainedReceipt(receipt: PreflightReceipt) {
  // Earlier CLIs validate this cache strictly. Keep its format across CLI rollbacks.
  const { timeSettings, ...retained } = receipt;
  void timeSettings;
  return JSON.stringify(retained);
}

export function writePreflightReceipt(root: string, receipt: PreflightReceipt) {
  const path = receiptPath(root, receipt.laneId);
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, retainedReceipt(receipt), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
