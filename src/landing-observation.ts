// SPDX-License-Identifier: Apache-2.0
import type { LandingStall } from './landing-stall.js';
import { pendingActionsInfra } from './github-actions-infra.js';
import type { CheckRun } from './work-types.js';
import type { LandingBatch, LandingEntry } from './landing-batch-types.js';
import { finishChild } from './finish-child.js';
import type { LandingDiagnosisReport } from './landing-diagnosis.js';
export type { Submission } from './landing-submission-state.js';
import { submissionOutcome, sourceSubmission, type Submission } from './landing-submission-state.js';
/** A runner/preparation failure is not a failed source combination. Signal/OOM
 * outcomes retain their failed-check status; they do not establish transient infra. */
export function diagnosticCause(run: CheckRun) {
  if (pendingActionsInfra(run)) return 'pending-infra' as const;
  if (run.status === 'failed') {
    if (run.error && run.backend?.actual === 'local') return 'infra' as const;
    if (run.exitCode === null && !run.signal) return 'unknown-outcome' as const;
    return 'check-failed' as const;
  }
  if (run.status === 'cancelled') return 'cancelled' as const;
  if (['interrupted', 'runner-unavailable', 'runner-budget-exhausted'].includes(run.status))
    return 'infra' as const;
  return undefined;
}
export function diagnosticStatus(run: CheckRun): CheckRun['status'] {
  return run.status === 'failed' && diagnosticCause(run) !== 'check-failed' ? 'interrupted' : run.status;
}

export function batchDiagnosis(batch: LandingBatch | undefined) {
  if (!batch?.diagnosis) return {};
  const failed = batch.diagnosis.nodes.filter(
    node => node.status === 'failed' && node.cause === 'check-failed',
  );
  const observedFailingSets = failed.map(node => ({
    nodeId: node.id,
    entryIds: node.entryIds,
    inputs: node.inputs,
    viewId: node.viewId,
    head: node.head,
    runId: node.runId,
  }));
  return {
    diagnosis: {
      batchId: batch.id,
      ...batch.diagnosis,
      ...(batch.confirmation ? { confirmation: batch.confirmation } : {}),
      applicability:
        batch.status === 'superseded'
          ? 'historical'
          : batch.status === 'completed'
            ? 'settled'
            : 'provisional',
      observedFailingSets,
      smallestObservedFailingSet:
        [...observedFailingSets].sort((a, b) => a.entryIds.length - b.entryIds.length)[0] ?? null,
    },
  };
}

export function landingAttemptId(entry: LandingEntry) {
  return entry.batchId ? finishChild(entry.id, `landing-attempt:${entry.batchId}`) : null;
}
/** Shared read-only queue vocabulary for receipts and the pure pending projection. */
export function queueObservation(
  entry: LandingEntry,
  run: CheckRun | undefined,
  diagnosis: ReturnType<typeof batchDiagnosis> = {},
) {
  return {
    status: entry.status,
    queueStatus: entry.status,
    ...diagnosis,
    ...(['queued', 'checking'].includes(entry.status) && entry.waitingFor
      ? { waitingFor: entry.waitingFor }
      : {}),
    checkStatus: run ? diagnosticStatus(run) : undefined,
    ...(entry.error ? { code: entry.error.code, message: entry.error.message } : {}),
    ...(run?.reusedFrom ? { checkReuse: run.reusedFrom, message: run.details } : {}),
    ...(run && pendingActionsInfra(run) && entry.status !== 'cancelled'
      ? { code: run.error!.code, message: run.error!.message }
      : {}),
    ...(entry.reason
      ? {
          ...(entry.status === 'interrupted' && !entry.error ? { code: 'EVIDENCE_CHANGED' } : {}),
          message: entry.reason,
        }
      : {}),
  };
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
  return {
    submissionId: finishChild(operationId, `submission:${lane.intentId}:${lane.id}`),
    operationId,
    entryOperationId: operationId,
    laneId: lane.id,
    intentId: lane.intentId,
    head: pin.head,
    attemptHead,
    attemptId,
    ...sourceSubmission(outcome, lane.head, attemptHead),
    ...(lane.head !== attemptHead ? { supersededBy: lane.head } : {}),
    ...(result.stall ? { stall: result.stall as LandingStall } : {}),
    ...(typeof result.message === 'string' ? { message: result.message } : {}),
    ...(result.waitingFor
      ? { waitingFor: result.waitingFor as import('./landing-batch-types.js').LandingWaiting }
      : {}),
    ...(result.queueAhead ? { queueAhead: result.queueAhead as NonNullable<Submission['queueAhead']> } : {}),
    ...(result.diagnosis ? { diagnosis: result.diagnosis as LandingDiagnosisReport } : {}),
  };
}
