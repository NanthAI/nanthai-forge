// SPDX-License-Identifier: Apache-2.0
import { landingDiagnosis } from './landing-diagnosis.js';
import { projectSubmission, queueObservation } from './landing-observation.js';
export { projectSubmission, queueObservation, landingAttemptId } from './landing-observation.js';
import { allRecords } from './agent-lifecycle.js';
import type { LandingEntry } from './landing-batch-types.js';
import type { ChannelMove } from './work-types.js';
import type { WorkStore } from './work-store.js';

import { submissionOutcome, type Submission } from './landing-submission-state.js';
export * from './landing-submission-state.js';
export function queuedOutcome(store: WorkStore, entry: LandingEntry) {
  const run = entry.runId ? store.select('runs', entry.runId) : undefined;
  return reviewedOutcome(
    store,
    queueObservation(entry, run, landingDiagnosis(store, entry)),
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
export function submissionLine(value: Submission) {
  const state = value.state === 'superseded' ? `superseded (outcome ${value.outcome})` : value.state;
  return `${state}${value.pendingReason ? ` (${value.pendingReason})` : value.cause ? ` (${value.cause})` : ''} · submission ${value.submissionId.slice(0, 8)}${value.attemptId ? ` · attempt ${value.attemptId.slice(0, 8)}` : ''}`;
}
