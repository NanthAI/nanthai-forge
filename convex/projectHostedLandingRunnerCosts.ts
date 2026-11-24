// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { hasDeferredCancelledUsage } from './projectCancelledRunWrites';
import { compactDiscardedChecksOn } from './projectHostedLandingRunnerCostSwitch';
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';

export type RunnerAccounting = Doc<'projectHostedLandingRequests'>['runnerAccounting'];
export type SupersededCheck = NonNullable<Doc<'projectHostedLandingRequests'>['supersededCheck']>;
type Counts = HostedLandingState['counts'];

/** A completed check whose exact binding is retired becomes discarded once.
 * Callers use the check state they already hold; pending cancellations price separately. */
export function retiredCheckUsage(
  counts: Counts,
  report?: { seconds?: number },
): Pick<HostedLandingState, 'counts'> {
  if (!compactDiscardedChecksOn()) return {};
  const { runnerSeconds: recorded, runnerFull: _full, ...carried } = counts ?? {};
  void _full;
  const runnerSeconds = report ? report.seconds : recorded;
  if (runnerSeconds === undefined)
    return { counts: { ...carried, discardedRunnerUnknown: 'superseded-check-execution-unreported' } };
  return {
    counts: { ...carried, discardedRunnerSeconds: (carried.discardedRunnerSeconds ?? 0) + runnerSeconds },
  };
}

// The cancellation tail prices the run after the successor exists. Keep it out of the
// permanent-unknown carry while that same transaction is still creating the successor.
export function latestCancelledRun(ctx: MutationCtx, row: Doc<'projectHostedLandingRequests'> | undefined) {
  const runId = row?.runId ?? row?.admission?.runId;
  return row && runId && hasDeferredCancelledUsage(ctx, runId, row.submissionId)
    ? runId
    : row?.runnerAccounting?.lastCancelled;
}

/** One predecessor, already loaded by selection. Its latest check joins earlier waste exactly once.
 * The small checkpoint stays outside the public state until the successor selects its check. */
export function supersededCheckCosts(
  previous: HostedLandingState,
  runId: string | null | undefined,
  pending?: SupersededCheck,
  lastCancelled?: string,
): { counts: NonNullable<Counts>; supersededCheck: SupersededCheck | undefined } {
  const counts = previous.counts;
  // A split can still pin the failed shared run. The failure loop already put its share in
  // discarded (or marked it unknown); it is not an additional unreported latest check.
  const sharedDiscarded = Boolean(
    runId && previous.batchDiagnostic?.sharedRunId === runId && counts?.runnerSeconds === undefined,
  );
  const cancelledLatest = Boolean(lastCancelled && (!runId || runId === lastCancelled));
  const latestRunId = sharedDiscarded || cancelledLatest ? undefined : runId;
  const unknownBefore = Boolean(
    counts?.discardedRunnerUnknown ||
    ((previous.supersedes || sharedDiscarded) && counts?.discardedRunnerSeconds === undefined),
  );
  return {
    counts: {
      discardedRunnerSeconds: (counts?.discardedRunnerSeconds ?? 0) + (counts?.runnerSeconds ?? 0),
      ...(unknownBefore ||
      ((latestRunId ||
        (!pending &&
          !cancelledLatest &&
          !previous.batchId &&
          !previous.batchOriginId &&
          previous.timing?.checkReservedAt)) &&
        counts?.runnerSeconds === undefined)
        ? { discardedRunnerUnknown: 'superseded-check-execution-unreported' }
        : {}),
    },
    supersededCheck: latestRunId
      ? {
          runId: latestRunId,
          ...(counts?.runnerSeconds !== undefined ? { runnerSeconds: counts.runnerSeconds } : {}),
          ...(unknownBefore ? { unknownBefore: true } : {}),
        }
      : pending,
  };
}

/** Selecting the same exact run reuses its work; it was not lost. Resolve on the existing write that
 * binds a solo, admission or shared check. An unselected queued check keeps its checkpoint. */
export function bindSupersededCheck(
  counts: Counts,
  pending: SupersededCheck | undefined,
  runId: string | null | undefined,
): { counts: Counts; supersededCheck: SupersededCheck | undefined } {
  if (!pending || !runId) return { counts, supersededCheck: pending };
  if (pending.runId !== runId) return { counts, supersededCheck: undefined };
  const next = {
    ...counts,
    discardedRunnerSeconds: (counts?.discardedRunnerSeconds ?? 0) - (pending.runnerSeconds ?? 0),
  };
  if (!pending.unknownBefore) delete next.discardedRunnerUnknown;
  return { counts: next, supersededCheck: undefined };
}

/** Binding a later check ends the previous latest-cancel marker, while its
 * independent pending cost still follows the stable submission root. */
export function bindRunnerAccounting(
  accounting: RunnerAccounting,
  runId: string | null | undefined,
): RunnerAccounting {
  if (!accounting || !runId || runId === accounting.lastCancelled) return accounting;
  const { lastCancelled: _previous, ...retained } = accounting;
  void _previous;
  return retained;
}

/** Distinct run ids kept for the count. A landing that binds more distinct runs than this is far over the
 * budget (4 per 20 landings) already; a rebind of a run older than the last 8 would count once more. */
export const COUNTED_RUN_IDS = 8;

/** Count a run once when it is bound to this work (Item 1018d0f8, root cause 3a5737c4): the
 * discarded-check budget reads distinct runs, not attempts. A check carried to a resubmission, or bound
 * again after another one (a failed cohort splits back onto a member's admission run), is the same run.
 * Returns the same object when nothing changes, so the caller can skip the write. */
export function countRunnerRun(
  accounting: RunnerAccounting,
  runId: string | null | undefined,
): RunnerAccounting {
  const key = runId && countedRunKey(runId);
  if (!accounting || !key || accounting.runs === undefined || accounting.runIds?.includes(key))
    return accounting;
  return {
    ...accounting,
    runs: accounting.runs + 1,
    runIds: [...(accounting.runIds ?? []), key].slice(-COUNTED_RUN_IDS),
  };
}

/** A run id's last 8 characters: enough to tell apart the few runs of one landing, and 28 bytes per run
 * less on the request row (landing storage budget). */
export const countedRunKey = (runId: string) => runId.slice(-8);

/** The store's bind: main's cancel-marker rule (a different run than the bound one clears it), then the
 * run count, kept apart so runner-minute accounting does not change (review b0144034 P3). */
export function bindRunnerRun(
  accounting: RunnerAccounting,
  boundRunId: string | null | undefined,
  runId: string | null | undefined,
): RunnerAccounting {
  const bound =
    accounting && runId && runId !== boundRunId ? bindRunnerAccounting(accounting, runId) : accounting;
  return countRunnerRun(bound, runId);
}

/** Fresh accounting for new work. The run count starts only for a new lineage: a retry of a predecessor
 * without accounting cannot know that predecessor's runs, so its count stays unknown (review b0144034 P2). */
export const freshRunnerAccounting = (root: string, supersedes: unknown): NonNullable<RunnerAccounting> => ({
  root,
  pending: 0,
  ...(supersedes ? {} : { runs: 0 }),
});

/** Check runs this landing threw away: every run bound to its work but the accepted one. Null when
 * the count started after its first run (accounting older than the count). */
export const discardedRunCount = (accounting: RunnerAccounting, acceptedRunId: string | null | undefined) =>
  accounting?.runs === undefined ? null : Math.max(0, accounting.runs - (acceptedRunId ? 1 : 0));
