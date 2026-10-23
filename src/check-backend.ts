// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { modalUsageCost } from './modal-cost.js';
import { modalCredentialsRefSchema } from './check-runner-settings.js';
import { checkCostSchema } from './check-cost.js';
import type { CheckRun } from './work-types.js';

export const modalCostUsageSchema = z.array(
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
  cost: checkCostSchema.optional(),
  credentialsRef: modalCredentialsRefSchema.nullable().optional(),
  retryable: z.boolean().optional(),
  verdict: z.enum(['clean', 'recovered', 'flake', 'quarantined', 'failed']).optional(),
  testVerdicts: z
    .array(
      z.object({
        test: z.string(),
        verdict: z.enum(['passed', 'failed', 'recovered', 'flake', 'fixed']),
        recovery: z.enum(['related-change', 'unrelated-change', 'unchanged-source', 'unknown']).optional(),
        evidenceRunId: z.string().optional(),
      }),
    )
    .optional(),
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
  costUsage: modalCostUsageSchema.optional(),
  estimatedCostUsd: z.number().nonnegative().finite().optional(),
});
export function checkRoute(
  runner: 'local' | 'modal' | 'github-actions',
  check: CheckRun['check'],
  native: boolean,
) {
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
  const groups = Array.from({ length: count }, () => ({ files: [] as string[], seconds: 0 }));
  const duration = (file: string) =>
    Number.isFinite(durations[file]) && durations[file]! > 0 ? durations[file]! : 1;
  for (const file of [...new Set(files)].sort((a, b) => duration(b) - duration(a) || a.localeCompare(b))) {
    const group = groups.reduce((a, b) => (a.seconds <= b.seconds ? a : b));
    group.files.push(file);
    group.seconds += duration(file);
  }
  return groups.map(group => group.files);
}
export function modalMonthCost(runs: Iterable<Pick<CheckRun, 'startedAt' | 'backend'>>, now = new Date()) {
  const month = now.toISOString().slice(0, 7);
  let estimatedCostUsd = 0,
    recordedRuns = 0,
    legacyRuns = 0;
  const executions = new Set<string>();
  for (const run of runs) {
    if (run.backend?.actual === 'github-actions') continue;
    if (!run.startedAt.startsWith(month) || run.backend?.estimatedCostUsd === undefined) continue;
    recordedRuns++;
    if (!run.backend.costUsage) {
      estimatedCostUsd += run.backend.estimatedCostUsd;
      legacyRuns++;
      continue;
    }
    for (const usage of run.backend.costUsage) {
      // Controller adoption and retries can report the same retained attempt.
      if (executions.has(usage.executionId)) continue;
      executions.add(usage.executionId);
      estimatedCostUsd += modalUsageCost(usage);
    }
  }
  return {
    month,
    estimatedCostUsd,
    recordedRuns,
    legacyRuns,
    basis:
      'Sandbox compute estimate (conservative) before credits and billing adjustments; CPU $0.00003942/core-second, memory $0.00000667/GiB-second at max(request, usage). Worker runtime when recorded; legacy controller-time estimates otherwise. Includes each retained safety margin; legacy estimates are uncalibrated. Excludes startup/teardown, image builds and egress. Billed spend is unknown; Modal billing is authoritative.',
  };
}
