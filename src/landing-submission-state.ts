import type { LandingDiagnosisReport } from './landing-diagnosis.js';
// SPDX-License-Identifier: Apache-2.0
export type SubmissionState = 'pending' | 'terminal-failed' | 'landed' | 'superseded';
export type PendingReason =
  'queued' | 'checking' | 'waiting-for-review' | 'waiting-for-dependency' | 'pending-infra';
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
  diagnosis?: LandingDiagnosisReport;
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
  if (
    status === 'pending-infra' ||
    (status !== 'cancelled' && result.code === 'GITHUB_ACTIONS_PENDING_INFRA')
  )
    return { state: 'pending', pendingReason: 'pending-infra', cause: null };
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

/** Source-relative presentation shared by native and hosted submissions. Later
 * saved bytes supersede this selected input without erasing its actual outcome. */
export function sourceSubmission(
  outcome: ReturnType<typeof submissionOutcome>,
  currentHead: string,
  attemptHead: string,
) {
  const state: SubmissionState = currentHead === attemptHead ? outcome.state : 'superseded';
  return {
    ...outcome,
    outcome: outcome.state,
    state,
    terminal: state !== 'pending',
    complete: state === 'landed',
  };
}
