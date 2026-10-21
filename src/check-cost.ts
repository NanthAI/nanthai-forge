// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { modalUsageCost } from './modal-cost.js';
import type { CheckRun } from './work-types.js';

const quantity = z.number().nonnegative().finite().nullable();
const itemSchema = z.object({
  id: z.string(),
  seconds: quantity,
  billedMinutes: quantity,
  estimatedCostUsd: quantity,
});
export const checkCostSchema = z.object({
  runner: z.enum(['local', 'github-actions', 'modal']),
  label: z.string().optional(),
  legacy: z.boolean().optional(),
  billedSeconds: quantity,
  billedMinutes: quantity,
  estimatedCostUsd: quantity,
  basis: z.string(),
  items: z.array(itemSchema),
});
export type CheckCost = z.infer<typeof checkCostSchema>;
type Item = z.infer<typeof itemSchema>;
const modalCostBasis =
  'Modal Sandbox estimate (conservative): CPU $0.00003942/core-second + memory $0.00000667/GiB-second at max(request, usage); worker-runtime when recorded, legacy controller-time otherwise. Excludes startup/teardown, builds, egress, credits and billing adjustments. Includes each retained safety margin; legacy estimates are uncalibrated. Modal billing is authoritative.';

export function unknownCost(runner: CheckCost['runner']): CheckCost {
  return {
    runner,
    billedSeconds: null,
    billedMinutes: null,
    estimatedCostUsd: null,
    items: [],
    basis: 'Usage unavailable; billed spend and estimated USD are unknown. No zero-cost inference.',
  };
}
function sum(items: Item[], key: 'seconds' | 'billedMinutes' | 'estimatedCostUsd') {
  return items.some(item => item[key] === null) ? null : items.reduce((n, item) => n + item[key]!, 0);
}
function itemsCost(runner: CheckCost['runner'], items: Item[], basis: string, label?: string): CheckCost {
  return {
    runner,
    ...(label ? { label } : {}),
    items,
    basis,
    billedSeconds: sum(items, 'seconds'),
    billedMinutes: sum(items, 'billedMinutes'),
    estimatedCostUsd: sum(items, 'estimatedCostUsd'),
  };
}
export function localCost(runId: string): CheckCost {
  return itemsCost(
    'local',
    [{ id: runId, seconds: 0, billedMinutes: 0, estimatedCostUsd: 0 }],
    'Own machine: no provider-billed seconds/minutes or Forge runner charge ($0). Hardware, electricity and operator costs are not estimated.',
  );
}
export function modalRunCost(backend: NonNullable<CheckRun['backend']>): CheckCost {
  if (backend.costUsage) {
    const usage = [...new Map(backend.costUsage.map(item => [item.executionId, item])).values()];
    return {
      ...itemsCost(
        'modal',
        usage.map(item => ({
          id: item.executionId,
          seconds: item.seconds,
          billedMinutes: item.seconds / 60,
          estimatedCostUsd: modalUsageCost(item),
        })),
        `${modalCostBasis} Measurement bases: ${[...new Set(usage.map(item => item.basis))].join(', ') || 'no executions'}.`,
      ),
      legacy: usage.some(item => item.basis === 'controller-time'),
    };
  }
  return {
    ...unknownCost('modal'),
    legacy: true,
    estimatedCostUsd: backend.estimatedCostUsd ?? null,
    basis: `${modalCostBasis} Legacy aggregate estimate; execution quantities unavailable and may overstate spend.`,
  };
}

/** Defaults are estimates, never a provider invoice. Unknown labels need an explicit rate. */
export function actionsRate(label: string): number | null {
  const blacksmith = /^blacksmith-(\d+)vcpu-ubuntu-\d+$/.exec(label);
  if (blacksmith && Number(blacksmith[1]) > 0) return (Number(blacksmith[1]) / 2) * 0.004;
  if (/^ubuntu-(?:latest|\d+\.\d+)$/.test(label)) return 0.006;
  if (/^windows-(?:latest|\d{4})$/.test(label)) return 0.01;
  if (/^macos-(?:latest|\d+(?:\.\d+)?)$/.test(label)) return 0.062;
  return null;
}
export type JobUsage = {
  id: number;
  started_at?: string | null;
  completed_at?: string | null;
  status: string;
};
export function actionsCost(label: string, rate: number | null, jobs: JobUsage[]): CheckCost {
  const items = [...new Map(jobs.map(job => [job.id, job])).values()].map(job => {
    const start = Date.parse(job.started_at ?? ''),
      end = Date.parse(job.completed_at ?? '');
    const minutes =
      job.status === 'completed' && Number.isFinite(start) && Number.isFinite(end) && end >= start
        ? Math.ceil((end - start) / 60_000)
        : null;
    return {
      id: String(job.id),
      seconds: minutes === null ? null : minutes * 60,
      billedMinutes: minutes,
      estimatedCostUsd: minutes === null || rate === null ? null : minutes * rate,
    };
  });
  const basis = `Estimate from each job's started_at/completed_at, rounded up separately to whole minutes, including retries; excludes queue time. ${
    rate === null
      ? 'No rate configured for this label; USD unknown.'
      : `Runner label ${label}: $${rate}/job-minute (policy override or built-in rate).`
  } ${
    label.startsWith('blacksmith-')
      ? 'Blacksmith: vCPU/2 × $0.004 per 2-vCPU minute by default; 3,000 free 2-vCPU minutes/month not deducted (shared allowance unknown). GitHub API billable minutes can be zero for these jobs.'
      : 'Before free allowances, credits and billing adjustments; public-repository eligibility is unknown.'
  } Provider billing is authoritative.`;
  return items.length
    ? itemsCost('github-actions', items, basis, label)
    : { ...unknownCost('github-actions'), label, basis: `${basis} Job usage unavailable.` };
}

/** All retained months, by actual runner and label. Deduplicate adopted remote executions. */
export function runnerMonthCosts(runs: Iterable<Pick<CheckRun, 'id' | 'startedAt' | 'backend'>>) {
  const groups = new Map<
    string,
    {
      month: string;
      runner: CheckCost['runner'];
      label?: string;
      recordedRuns: number;
      unknownRuns: number;
      legacyRuns: number;
      billedSeconds: number;
      billedMinutes: number;
      estimatedCostUsd: number;
      basis: string[];
    }
  >();
  const seen = new Set<string>();
  for (const run of runs) {
    const backend = run.backend;
    const cost =
      backend?.cost ??
      (backend?.costUsage || (backend?.actual === 'modal' && backend.estimatedCostUsd !== undefined)
        ? modalRunCost(backend)
        : unknownCost(backend?.actual ?? 'local'));
    const month = run.startedAt.slice(0, 7),
      key = `${month}:${cost.runner}:${cost.label ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        month,
        runner: cost.runner,
        ...(cost.label ? { label: cost.label } : {}),
        recordedRuns: 0,
        unknownRuns: 0,
        legacyRuns: 0,
        billedSeconds: 0,
        billedMinutes: 0,
        estimatedCostUsd: 0,
        basis: [],
      };
      groups.set(key, group);
    }
    group.recordedRuns++;
    if (!backend?.cost || cost.legacy) group.legacyRuns++;
    if (cost.billedSeconds === null || cost.estimatedCostUsd === null) group.unknownRuns++;
    if (!group.basis.includes(cost.basis)) group.basis.push(cost.basis);
    for (const item of cost.items.length
      ? cost.items
      : [
          {
            id: run.id,
            seconds: cost.billedSeconds,
            billedMinutes: cost.billedMinutes,
            estimatedCostUsd: cost.estimatedCostUsd,
          },
        ]) {
      const identity = `${cost.runner}:${item.id}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      group.billedSeconds += item.seconds ?? 0;
      group.billedMinutes += item.billedMinutes ?? 0;
      group.estimatedCostUsd += item.estimatedCostUsd ?? 0;
    }
  }
  return {
    basis:
      'Sums of available gross estimates by run start month, not billed spend. Unknown quantities are excluded and counted in unknownRuns; legacyRuns retain older estimation bases. Free allowances are not deducted.',
    months: [...groups.values()].sort(
      (a, b) =>
        b.month.localeCompare(a.month) ||
        a.runner.localeCompare(b.runner) ||
        (a.label ?? '').localeCompare(b.label ?? ''),
    ),
  };
}
