// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedCheckRun } from '../src/hosted-check';
import type { semanticReportsSchema } from '../src/intent-semantic-conflict';
import { applyCheckRetryBudget, capCheckReports } from '../src/check-report-cap';
import { mergeShardReports, settlePoolPending } from '../src/hosted-actions-pool';
import { canonicalPayload } from '../src/hosted-source-operation';

// Issue d0f8472a: a run's accumulated per-file reports stay out of its run row while shards
// arrive. Each shard's raw reports are one append-only results row; one progress row (index -1)
// keeps only what the next fold step and the progress summary read: failing, flaky or excerpted
// files in full and the names of the other files. At any terminal the full reports are replayed
// once from the shard rows with the same fold, in arrival order, so they match the per-shard fold.
type Reports = z.infer<typeof semanticReportsSchema>;
export type ShardStep = {
  reports: Reports;
  yielded: string[];
  complete: boolean;
};
export const progressIndex = -1;

/** One per-result step: merge, pool settlement, shared retry budget, cap. */
export function foldShardStep(state: { reports: Reports; pending: readonly string[] }, step: ShardStep) {
  const merged = mergeShardReports(state.reports, step.reports);
  const pool = settlePoolPending(merged, state.pending, step.yielded, step.complete);
  return {
    reports: capCheckReports(applyCheckRetryBudget(pool.reports)).reports,
    pending: pool.pending,
  };
}
/** A passing file without an excerpt changes no later merge, budget, cap or summary except by
 * its name (membership and the total), so progress keeps its name only. */
const plain = (report: Reports[string]) => !report.failed && !report.flaky && report.firstError === undefined;
export function compactReports(reports: Reports) {
  const notable: Reports = {},
    names: string[] = [];
  for (const [file, report] of Object.entries(reports))
    if (plain(report)) names.push(file);
    else notable[file] = report;
  return { notable, plain: names };
}
export function expandReports(state: { notable: Reports; plain: string[] }): Reports {
  return {
    ...Object.fromEntries(state.plain.map(file => [file, { failed: false }])),
    ...state.notable,
  };
}

/** Issue 75cb5074: a shard row stores each passing file that has only a duration as
 * `{file: durationMs}`, so the final replay reads names and numbers instead of one JSON
 * object per file. Everything else stays verbatim; rows written in the old shape still parse. */
type SavedShard = { reports: Reports; durations?: Record<string, number>; yielded: string[] };
export function packShardReports(reports: Reports) {
  const kept: Reports = {},
    durations: Record<string, number> = {};
  for (const [file, report] of Object.entries(reports))
    if (
      report.failed === false &&
      typeof report.durationMs === 'number' &&
      Object.keys(report).every(key => key === 'failed' || key === 'durationMs')
    )
      durations[file] = report.durationMs;
    else kept[file] = report;
  return { reports: kept, durations };
}
export function unpackShardReports(saved: SavedShard): Reports {
  const reports: Reports = {};
  for (const [file, durationMs] of Object.entries(saved.durations ?? {}))
    reports[file] = { durationMs, failed: false };
  return Object.assign(reports, saved.reports);
}

const rows = (ctx: MutationCtx, run: HostedCheckRun) =>
  ctx.db
    .query('projectHostedActionsResults')
    .withIndex('by_project_and_run_and_index', q =>
      q.eq('projectId', run.projectId as Id<'hostedProjects'>).eq('runId', run.id),
    )
    // One row per planned shard plus the progress row.
    .take(run.plan!.shardCount + 1);
/** Exact accumulated reports from the shard rows (then the current step, if any, held in
 * memory), after which the shard rows drop their raw copies. */
async function replayShardReports(ctx: MutationCtx, run: HostedCheckRun, last?: ShardStep) {
  const all = await rows(ctx, run);
  const shards = all
    .filter(row => row.index !== progressIndex && row.reports !== undefined)
    .sort((a, b) => a.sequence! - b.sequence!);
  let state = { reports: {} as Reports, pending: [] as string[] };
  for (const row of shards) {
    const saved = JSON.parse(row.reports!) as SavedShard;
    state = foldShardStep(state, {
      reports: unpackShardReports(saved),
      yielded: saved.yielded,
      complete: row.complete!,
    });
  }
  if (last) state = foldShardStep(state, last);
  for (const row of all)
    if (row.index === progressIndex) await ctx.db.delete(row._id);
    else if (row.reports !== undefined) await ctx.db.patch(row._id, { reports: undefined });
  return { ...state, shards: shards.length };
}

/** Records one new shard result and updates the run's progress fields. A run whose row still
 * holds accumulated reports was started by the previous release and keeps that fold. */
export async function recordShardReports(
  ctx: MutationCtx,
  run: HostedCheckRun,
  result: {
    index: number;
    digest: string;
    contractReports?: Reports;
    pool?: { yielded: string[] };
  },
) {
  const step: ShardStep = {
    reports: result.contractReports ?? {},
    yielded: result.pool?.yielded ?? [],
    complete: run.counts.completed === run.plan!.shardCount,
  };
  const key = {
    projectId: run.projectId as Id<'hostedProjects'>,
    runId: run.id,
  };
  if (run.contractReports) {
    const folded = foldShardStep({ reports: run.contractReports, pending: run.poolPending ?? [] }, step);
    await ctx.db.insert('projectHostedActionsResults', {
      ...key,
      index: result.index,
      digest: result.digest,
    });
    return settle(run, folded.reports, folded.pending, true);
  }
  if (step.complete) {
    // The replay's one range read covers the progress row too (Issue 75cb5074).
    const replayed = await replayShardReports(ctx, run, step);
    await ctx.db.insert('projectHostedActionsResults', {
      ...key,
      index: result.index,
      digest: result.digest,
    });
    return settle(run, replayed.reports, replayed.pending, true);
  }
  const progress = await ctx.db
    .query('projectHostedActionsResults')
    .withIndex('by_project_and_run_and_index', q =>
      q.eq('projectId', key.projectId).eq('runId', key.runId).eq('index', progressIndex),
    )
    .unique();
  const saved = progress
    ? (JSON.parse(progress.state!) as {
        notable: Reports;
        plain: string[];
        count: number;
      })
    : { notable: {}, plain: [], count: 0 };
  await ctx.db.insert('projectHostedActionsResults', {
    ...key,
    index: result.index,
    digest: result.digest,
    sequence: saved.count,
    complete: false,
    reports: canonicalPayload({ ...packShardReports(step.reports), yielded: step.yielded }),
  });
  const folded = foldShardStep({ reports: expandReports(saved), pending: run.poolPending ?? [] }, step);
  const state = canonicalPayload({
    ...compactReports(folded.reports),
    count: saved.count + 1,
  });
  if (progress) await ctx.db.patch(progress._id, { state });
  else
    await ctx.db.insert('projectHostedActionsResults', {
      ...key,
      index: progressIndex,
      digest: '',
      state,
    });
  return settle(run, folded.reports, folded.pending, false);
}
function settle(run: HostedCheckRun, reports: Reports, pending: string[], retain: boolean) {
  if (pending.length) run.poolPending = pending;
  else delete run.poolPending;
  if (retain) run.contractReports = reports;
  return reports;
}

/** Any other terminal (cancel, watchdog, webhook settlement) keeps the reports shards sent. */
export async function restoreShardReports(ctx: MutationCtx, run: HostedCheckRun) {
  if (
    run.contractReports ||
    !run.counts.completed ||
    run.configuration.provider !== 'github-actions' ||
    run.configuration.credential ||
    !run.plan
  )
    return;
  const replayed = await replayShardReports(ctx, run);
  if (replayed.shards) run.contractReports = replayed.reports;
}
