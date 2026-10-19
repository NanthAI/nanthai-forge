// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { CheckRun } from './work-types.js';

export const checkBackendSchema = z.object({
  retryable: z.boolean().optional(),
  verdict: z.enum(['clean', 'flake', 'quarantined']).optional(),
  testVerdicts: z
    .array(z.object({ test: z.string(), verdict: z.enum(['passed', 'failed', 'flake', 'fixed']) }))
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
    recordedRuns = 0;
  for (const run of runs)
    if (run.startedAt.startsWith(month) && run.backend?.estimatedCostUsd !== undefined) {
      estimatedCostUsd += run.backend.estimatedCostUsd;
      recordedRuns++;
    }
  return {
    month,
    estimatedCostUsd,
    recordedRuns,
    basis: 'Compute allocation estimate; excludes image builds and egress. Modal billing is authoritative.',
  };
}
