// SPDX-License-Identifier: Apache-2.0
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
