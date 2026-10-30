import { semanticReportsSchema } from './intent-semantic-conflict.js';
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';
import { legacyCheckCredentialsRefSchema } from './legacy-check-credentials.js';
import { checkCostSchema } from './check-cost.js';
import type { CheckRun } from './work-types.js';
import { partitionTests } from '../scripts/test-shards.mjs';

export const legacyCostUsageSchema = z.array(
  z.object({
    executionId: z.string(),
    attempt: z.number().int().nonnegative().optional(),
    seconds: z.number().nonnegative().finite(),
    cpuCoreSeconds: z.number().nonnegative().finite(),
    memoryGiBSeconds: z.number().nonnegative().finite(),
    basis: z.enum(['worker-runtime', 'controller-time']),
    safetyMargin: z.number().min(1).finite().optional(),
  }),
);

export const checkBackendSchema = z.object({
  providerUrl: z.string().url().optional(),
  cost: checkCostSchema.optional(),
  credentialsRef: legacyCheckCredentialsRefSchema.nullable().optional(),
  retryable: z.boolean().optional(),
  verdict: z.enum(['clean', 'recovered', 'flake', 'quarantined', 'failed']).optional(),
  fileReports: semanticReportsSchema.optional(),
  testVerdicts: z
    .array(
      z.object({
        test: z.string(),
        verdict: z.enum(['passed', 'failed', 'recovered', 'flake', 'fixed']),
        recovery: z.enum(['related-change', 'unrelated-change', 'unchanged-source', 'unknown']).optional(),
        evidenceRunId: z.string().optional(),
        head: z.string().optional(),
        attempts: z
          .array(
            z.object({
              runId: z.string(),
              attempt: z.number().int().nonnegative().optional(),
              passed: z.boolean(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  ignoredTests: z.array(z.string()).optional(),
  quarantine: z
    .array(z.object({ test: z.string(), consecutivePasses: z.number().int().nonnegative() }))
    .optional(),
  requested: z.enum(['local', 'modal', 'github-actions']),
  actual: z.enum(['local', 'modal', 'github-actions']),
  fallback: z.string().optional(),
  pin: z.string().optional(),
  runtime: z.string().optional(),
  image: z.string().optional(),
  lockfile: z.string().optional(),
  executionIds: z.array(z.string()).optional(),
  billableMinutes: z.array(z.object({ jobId: z.number(), minutes: z.number().nonnegative() })).optional(),
  costUsage: legacyCostUsageSchema.optional(),
  estimatedCostUsd: z.number().nonnegative().finite().optional(),
});
/** Keep the real process exit while admitting an explicitly assessed quarantine pass. */
export const passingCheckExit = (run: Pick<CheckRun, 'exitCode' | 'backend'>) =>
  run.exitCode === 0 ||
  (run.exitCode === 1 && run.backend?.verdict === 'quarantined' && !!run.backend.ignoredTests?.length);

/** Shared by dispatch and retained-evidence comparison. */
export const actionsCheckRuntime = (repo: string | undefined, runsOn = 'ubuntu-latest') =>
  `github-actions;repo:${repo};node:24.22.1;runs-on:${runsOn};unfinished-retry:1`;

export function checkRoute(
  runner: 'local' | 'modal' | 'github-actions',
  check: CheckRun['check'],
  native: boolean,
) {
  invariant(
    runner !== 'modal',
    'RUNNER_UNAVAILABLE',
    'The Modal runner has been retired. Select checks.runner local or github-actions.',
  );
  const fallback =
    runner === 'local'
      ? undefined
      : !native
        ? 'Git-backed checks use the local runner.'
        : check.credentials?.length || check.env?.length
          ? 'Declared environment/credentials stay on the owner machine.'
          : undefined;
  return {
    requested: runner,
    actual: fallback ? ('local' as const) : runner,
    ...(fallback ? { fallback } : {}),
  };
}
/** Longest processing time first; ties are stable. No test file is split or omitted. */
export function balanceShards(files: string[], durations: Record<string, number> = {}, full = false) {
  const count = Math.min(files.length, full ? 16 : Math.max(1, Math.ceil(files.length / 8)));
  return count ? partitionTests(files, count, durations) : [];
}
