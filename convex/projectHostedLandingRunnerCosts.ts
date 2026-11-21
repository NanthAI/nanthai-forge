// SPDX-License-Identifier: Apache-2.0
import { hasDeferredCancelledUsage } from './projectCancelledRunWrites';
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';

export type RunnerAccounting = Doc<'projectHostedLandingRequests'>['runnerAccounting'];
export type SupersededCheck = NonNullable<Doc<'projectHostedLandingRequests'>['supersededCheck']>;
type Counts = HostedLandingState['counts'];

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
