// SPDX-License-Identifier: Apache-2.0
import { allRecords } from './agent-lifecycle.js';
import { finishChild } from './agent-finish-journal.js';
import type { LandingEntry } from './landing-batch-types.js';
import type { ChannelMove } from './work-types.js';
import type { WorkStore } from './work-store.js';

export type SubmissionState = 'pending' | 'terminal-failed' | 'landed' | 'superseded';
export type PendingReason = 'queued' | 'checking' | 'waiting-for-review' | 'waiting-for-dependency';
export type SubmissionCause = 'conflict' | 'check-failed' | 'infra' | 'stale-head' | 'rejected';
export type Submission = {
  submissionId: string;
  operationId: string;
  entryOperationId: string;
  laneId: string;
  intentId: string;
  head: string;
  attemptHead: string;
  attemptId: string | null;
  state: SubmissionState;
  outcome: Exclude<SubmissionState, 'superseded'>;
  pendingReason: PendingReason | null;
  cause: SubmissionCause | null;
  terminal: boolean;
  complete: boolean;
};
const busy = ['queued', 'preparing', 'running', 'checking', 'waiting', 'waiting to land', 'source-changed'];
/** Additive vocabulary over existing receipts; it neither drives nor authorizes landing. */
export function submissionOutcome(result: Record<string, unknown> = {}): {
  state: Exclude<SubmissionState, 'superseded'>;
  pendingReason: PendingReason | null;
  cause: SubmissionCause | null;
} {
  const status = String(result.status ?? 'queued');
  if (['accepted', 'already-accepted', 'landed'].includes(status))
    return { state: 'landed', pendingReason: null, cause: null };
  if (['review-needed', 'awaiting-review', 'waiting-for-review'].includes(status))
    return { state: 'pending', pendingReason: 'waiting-for-review', cause: null };
  if (status === 'waiting-for-dependency' || result.dependencies)
    return { state: 'pending', pendingReason: 'waiting-for-dependency', cause: null };
  if (busy.includes(status))
    return {
      state: 'pending',
      pendingReason: ['checking', 'preparing', 'running'].includes(
        String(result.queueStatus ?? result.checkStatus ?? status),
      )
        ? 'checking'
        : 'queued',
      cause: null,
    };
  const code = String(result.code ?? '');
  const checkStatus = String(result.checkStatus ?? status);
  const cause: SubmissionCause =
    status === 'conflict'
      ? 'conflict'
      : [
            'LANE_STALE',
            'COMPOSITION_STALE',
            'CHANNEL_CHANGED',
            'CHANNEL_DIVERGED',
            'CONTRACT_RESYNC_REQUIRED',
          ].includes(code) ||
          status === 'retry-exhausted' ||
          status === 'sync-required'
        ? 'stale-head'
        : ['interrupted', 'runner-unavailable', 'runner-budget-exhausted', 'timed-out'].includes(
              checkStatus,
            ) || code === 'EVIDENCE_CHANGED'
          ? 'infra'
          : status === 'failed' && !code
            ? 'check-failed'
            : 'rejected';
  return { state: 'terminal-failed', pendingReason: null, cause };
}
export function landingAttemptId(entry: LandingEntry) {
  return entry.batchId ? finishChild(entry.id, `landing-attempt:${entry.batchId}`) : null;
}
export function queuedOutcome(store: WorkStore, entry: LandingEntry) {
  const run = entry.runId ? store.select('runs', entry.runId) : undefined;
  return reviewedOutcome(
    store,
    {
      status: entry.status,
      queueStatus: entry.status,
      checkStatus: run?.status,
      ...(entry.reason ? { code: 'EVIDENCE_CHANGED', message: entry.reason } : {}),
    },
    run?.viewId ?? entry.viewId,
    entry.channel,
  );
}
/** An actual review acceptance settles a pending request; never infer acceptance from source bytes. */
export function reviewedOutcome(
  store: WorkStore,
  result: Record<string, unknown>,
  viewId: string | undefined,
  channel: string,
) {
  if (
    viewId &&
    submissionOutcome(result).pendingReason === 'waiting-for-review' &&
    allRecords<ChannelMove>(store, 'channelMoves').some(
      move => move.viewId === viewId && move.channel === channel && move.status === 'accepted',
    )
  )
    return { ...result, status: 'accepted' };
  return result;
}
/** Identity is immutable per request + (Lane, Intent); attempts change only for a new landing try. */
export function landingSubmission(
  store: WorkStore,
  operationId: string,
  pin: { laneId: string; head: string },
  result: Record<string, unknown>,
  attemptId: string | null,
  attemptHead = pin.head,
): Submission {
  const lane = store.select('lanes', pin.laneId)!;
  return projectSubmission(operationId, pin, lane, result, attemptId, attemptHead);
}
export function projectSubmission(
  operationId: string,
  pin: { laneId: string; head: string },
  lane: { id: string; intentId: string; head: string },
  result: Record<string, unknown>,
  attemptId: string | null,
  attemptHead = pin.head,
): Submission {
  const outcome = submissionOutcome(result);
  const state = lane.head === attemptHead ? outcome.state : 'superseded';
  return {
    submissionId: finishChild(operationId, `submission:${lane.intentId}:${lane.id}`),
    operationId,
    entryOperationId: operationId,
    laneId: lane.id,
    intentId: lane.intentId,
    head: pin.head,
    attemptHead,
    attemptId,
    ...outcome,
    outcome: outcome.state,
    state,
    terminal: state !== 'pending',
    complete: state === 'landed',
  };
}
export function submissionLine(value: Submission) {
  const state = value.state === 'superseded' ? `superseded (outcome ${value.outcome})` : value.state;
  return `${state}${value.pendingReason ? ` (${value.pendingReason})` : value.cause ? ` (${value.cause})` : ''} · submission ${value.submissionId.slice(0, 8)}${value.attemptId ? ` · attempt ${value.attemptId.slice(0, 8)}` : ''}`;
}
