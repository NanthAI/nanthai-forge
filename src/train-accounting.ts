import { postAcceptMoves } from './post-accept-coverage.js';
// SPDX-License-Identifier: Apache-2.0
import { modalRunCost, unknownCost, type CheckCost } from './check-cost.js';
import type { CheckRun, ChannelMove, WorkView } from './work-types.js';
import type { LandingBatch, LandingEntry } from './landing-batch-types.js';

export type CostRun = Pick<CheckRun, 'id' | 'startedAt' | 'backend'> &
  Partial<Pick<CheckRun, 'queuedAt' | 'endedAt' | 'status' | 'viewId' | 'mainCheck' | 'reusedFrom'>>;
export const costCategories = [
  'landing',
  'diagnosis',
  'retry',
  'invalidated-speculation',
  'preview',
  'audit',
  'other',
] as const;
export type CostCategory = (typeof costCategories)[number];
export type PreviewMeasurement = {
  executionId: string;
  startedAt: string;
  durationMs: number;
  inputs: { laneId: string; head: string }[];
  cost: CheckCost;
};
export type AccountingBatch = Pick<LandingBatch, 'id' | 'status' | 'entryIds' | 'prefixes'> & {
  diagnosis?: { nodes: { runId: string; parentId?: string | undefined }[] } | undefined;
};
export type AccountingContext = {
  batches?: AccountingBatch[];
  entries?: LandingEntry[];
  moves?: (Pick<ChannelMove, 'id' | 'status' | 'at' | 'postAcceptRunId'> &
    Partial<Pick<ChannelMove, 'channel' | 'postAccept' | 'postAcceptAuditRunId'>>)[];
  previews?: PreviewMeasurement[];
};
export function runCost(run: CostRun): CheckCost {
  return (
    run.backend?.cost ??
    (run.backend?.costUsage || (run.backend?.actual === 'modal' && run.backend.estimatedCostUsd !== undefined)
      ? modalRunCost(run.backend)
      : unknownCost(run.backend?.actual ?? 'local'))
  );
}
const ms = (value?: string) => (value ? Date.parse(value) : NaN);
const duration = (from: number, to: number) =>
  Number.isFinite(from) && Number.isFinite(to) && to >= from ? to - from : null;
export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    observed: sorted.length,
    p50Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.5) - 1]! : null,
    p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1]! : null,
  };
}

/** Each physical item contributes once across submissions, controller adoption and categories.
 * Categories are exclusive: invalidation wins over retry, then the original run purpose.
 * Missing execution identities/timings remain explicit coverage gaps. */
export function trainAccounting(runs: CostRun[], context: AccountingContext = {}, now = new Date()) {
  const purpose = new Map<string, CostCategory>();
  for (const batch of context.batches ?? [])
    for (const prefix of batch.prefixes)
      purpose.set(
        prefix.runId,
        batch.status === 'superseded'
          ? 'invalidated-speculation'
          : batch.diagnosis?.nodes.some(node => node.runId === prefix.runId)
            ? batch.diagnosis.nodes.find(node => node.runId === prefix.runId)!.parentId
              ? 'diagnosis'
              : 'landing'
            : prefix === batch.prefixes.at(-1)
              ? 'landing'
              : 'diagnosis',
      );
  const categories = Object.fromEntries(
    costCategories.map(category => [
      category,
      {
        executions: 0,
        knownGrossCostUsd: 0,
        unknownCostExecutions: 0,
        billedMinutes: 0,
        unknownMinutesExecutions: 0,
        executingSeconds: 0,
        unknownExecutingExecutions: 0,
        allowanceUnits: 0,
        unknownAllowanceExecutions: 0,
        unknownRetryExecutions: 0,
      },
    ]),
  ) as Record<
    CostCategory,
    {
      executions: number;
      knownGrossCostUsd: number;
      unknownCostExecutions: number;
      billedMinutes: number;
      unknownMinutesExecutions: number;
      executingSeconds: number;
      unknownExecutingExecutions: number;
      allowanceUnits: number;
      unknownAllowanceExecutions: number;
      unknownRetryExecutions: number;
    }
  >;
  type Execution = { category: CostCategory; item: CheckCost['items'][number] };
  const physical = new Map<string, Execution>();
  const rank = (category: CostCategory) =>
    category === 'invalidated-speculation' ? 3 : category === 'retry' ? 2 : category === 'other' ? 0 : 1;
  let unidentifiedRuns = 0;
  const record = (cost: CheckCost, category: CostCategory, fallback: string) => {
    if (!cost.items.length) unidentifiedRuns++;
    for (const item of cost.items.length
      ? cost.items
      : [
          {
            id: fallback,
            seconds: cost.billedSeconds,
            billedMinutes: cost.billedMinutes,
            estimatedCostUsd: cost.estimatedCostUsd,
          },
        ]) {
      const selected = category === 'invalidated-speculation' ? category : item.retry ? 'retry' : category;
      const key = `${cost.runner}:${item.id}`,
        previous = physical.get(key);
      if (previous) {
        if (previous.item.retry === undefined && item.retry !== undefined) previous.item.retry = item.retry;
        // A later controller observation may complete quantities omitted earlier.
        for (const field of [
          'seconds',
          'billedMinutes',
          'estimatedCostUsd',
          'executingSeconds',
          'allowanceUnits',
        ] as const)
          if (previous.item[field] == null && item[field] != null) previous.item[field] = item[field]!;
        if (rank(selected) > rank(previous.category)) previous.category = selected;
      } else physical.set(key, { category: selected, item: { ...item } });
    }
  };
  for (const run of runs.filter(run => !run.reusedFrom))
    record(
      runCost(run),
      run.mainCheck ? 'audit' : (purpose.get(run.id) ?? 'other'),
      `unidentified:${run.id}`,
    );
  for (const preview of context.previews ?? []) record(preview.cost, 'preview', preview.executionId);
  for (const { category, item } of physical.values()) {
    const group = categories[category];
    group.executions++;
    group.knownGrossCostUsd += item.estimatedCostUsd ?? 0;
    group.unknownCostExecutions += Number(item.estimatedCostUsd === null);
    group.billedMinutes += item.billedMinutes ?? 0;
    group.unknownMinutesExecutions += Number(item.billedMinutes === null);
    group.executingSeconds += item.executingSeconds ?? 0;
    group.unknownExecutingExecutions += Number(item.executingSeconds == null);
    group.allowanceUnits += item.allowanceUnits ?? 0;
    group.unknownAllowanceExecutions += Number(item.allowanceUnits == null);
    group.unknownRetryExecutions += Number(item.retry == null);
  }
  const moves = postAcceptMoves(context.moves ?? []);
  const runById = new Map(runs.map(run => [run.id, run]));
  const submissions = (context.entries ?? []).map(entry => {
    const related = (context.batches ?? []).filter(batch => batch.entryIds.includes(entry.id));
    const attempts = related
      .flatMap(batch => batch.prefixes.filter(prefix => prefix.entryIds.includes(entry.id)))
      .flatMap(prefix => runById.get(prefix.runId) ?? []);
    const first = entry.firstSelectedAt
      ? ms(entry.firstSelectedAt)
      : Math.min(...attempts.map(run => ms(run.queuedAt ?? run.startedAt)).filter(Number.isFinite));
    const receipt = moves.find(move => move.id === entry.acceptanceId && move.status === 'accepted');
    const terminal = ['accepted', 'conflict', 'failed', 'cancelled', 'interrupted'].includes(entry.status);
    // A run ending is not an acceptance/cancellation timestamp. Legacy terminal timestamps stay unknown.
    const ended = receipt ? ms(receipt.at) : terminal ? ms(entry.terminalAt) : NaN;
    return {
      entryId: entry.id,
      viewId: entry.viewId,
      status: entry.status,
      arrivedAt: entry.arrivedAt,
      queueBasis: entry.firstSelectedAt ? 'submission-state' : 'legacy-check-reservation',
      queueWaitMs: duration(ms(entry.arrivedAt), first),
      endToEndMs: duration(ms(entry.arrivedAt), ended),
      pendingAgeMs: terminal ? null : duration(ms(entry.arrivedAt), now.getTime()),
      attempts: related.length,
      sharedRunIds: [
        ...new Set(
          related.flatMap(batch => batch.prefixes.map(prefix => prefix.runId)).filter(id => runById.has(id)),
        ),
      ],
      auditRunId: receipt?.postAcceptRunId ?? null,
    };
  });
  const groups = Object.values(categories);
  return {
    basis:
      'Available gross compute estimates, once per runner/execution identity. Exclusive categories: invalidated speculation, retry, then run purpose. Other includes unclassified checks; unidentified legacy runs cannot prove physical deduplication. Queue time is latency, not compute. Provider billing is authoritative.',
    categories,
    total: {
      executions: physical.size,
      knownGrossCostUsd: groups.reduce((n, row) => n + row.knownGrossCostUsd, 0),
      unknownCostExecutions: groups.reduce((n, row) => n + row.unknownCostExecutions, 0),
      unidentifiedRuns,
      netEstimatedCostUsd: null,
      remainingSharedAllowance: 'unknown' as const,
    },
    previews: {
      executions: new Set((context.previews ?? []).map(row => row.executionId)).size,
      feedback: distribution([
        ...new Map((context.previews ?? []).map(row => [row.executionId, row.durationMs])).values(),
      ]),
    },
    latency: {
      submissions: submissions.length,
      queue: distribution(submissions.flatMap(row => (row.queueWaitMs === null ? [] : [row.queueWaitMs]))),
      endToEnd: distribution(submissions.flatMap(row => (row.endToEndMs === null ? [] : [row.endToEndMs]))),
    },
    submissions,
  };
}

/** Per-submission history names whole shared executions rather than inventing a split price. */
export function intentAccounting(runs: CheckRun[], context: AccountingContext = {}, views: WorkView[] = []) {
  const accounting = trainAccounting(runs, context);
  return accounting
    ? {
        ...accounting,
        submissions: accounting.submissions.map(submission => {
          const ids = new Set([
            ...submission.sharedRunIds,
            ...(submission.auditRunId ? [submission.auditRunId] : []),
          ]);
          const pins = views.find(view => view.id === submission.viewId)?.inputs ?? [];
          const previews =
            context?.previews?.filter(preview =>
              preview.inputs.some(pin =>
                pins.some(input => input.laneId === pin.laneId && input.head === pin.head),
              ),
            ) ?? [];
          const { categories, total } = trainAccounting(
            runs.filter(run => ids.has(run.id)),
            { batches: context?.batches ?? [], previews },
          );
          return {
            ...submission,
            costs: {
              categories,
              total,
              shared: true as const,
              basis:
                'Whole shared batch/preview/audit executions, not an allocated per-Lane price. Do not sum submission totals.',
            },
          };
        }),
      }
    : undefined;
}
