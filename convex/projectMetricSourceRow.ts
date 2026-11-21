// SPDX-License-Identifier: Apache-2.0
import {
  expandUnreportedCounts,
  type HostedLandingAttempt,
  type HostedLandingState,
} from '../src/hosted-landing';
import type { Doc } from './_generated/dataModel';

export function metricRequestRow(
  row: Pick<Doc<'projectHostedLandingRequests'>, 'value'> &
    Partial<
      Pick<
        Doc<'projectHostedLandingRequests'>,
        | 'actor'
        | 'operationId'
        | 'attemptId'
        | 'runId'
        | 'revertOf'
        | 'admission'
        | 'agentClient'
        | 'requestBodyId'
      >
    >,
) {
  const raw = JSON.parse(row.value) as HostedLandingState;
  const request = row.requestBodyId ? expandUnreportedCounts(raw) : raw;
  return {
    id: request.id,
    at: request.at,
    status: request.phase,
    actor: request.actor ?? ('actor' in row ? row.actor : 'unknown'),
    operationId: request.operationId ?? ('operationId' in row ? row.operationId : request.id),
    attemptId: request.attemptId ?? ('attemptId' in row ? row.attemptId : request.id),
    endedAt: request.timing?.settledAt ?? request.timing?.committedAt ?? null,
    runIds: 'runId' in row && row.runId ? [row.runId] : [],
    progressAt: Object.values(request.timing ?? {}).filter(value => typeof value === 'string'),
    errorCode: request.error?.code ?? null,
    compensating: 'revertOf' in row && !!row.revertOf,
    // Second-check evidence for every entry, failed ones included (81d12a32): why its own
    // check did not carry it, a shared cohort check that failed, and the agent client.
    firstCheckRecheck: ('admission' in row ? row.admission?.recheck : undefined) ?? null,
    // The admission run, when one ran: the submission's first check, decided by that run's row (9ce2ee79).
    admissionRun:
      'admission' in row && row.admission
        ? {
            runId: row.admission.runId,
            status: row.admission.status,
            ...(row.admission.status === 'failed' && request.counts?.runnerSeconds !== undefined
              ? { runnerSeconds: request.counts.runnerSeconds }
              : {}),
          }
        : null,
    sharedBatch: request.batchDiagnostic?.sharedRunId
      ? {
          runId: request.batchDiagnostic.sharedRunId,
          individualPassed: request.batchDiagnostic.individualPassed,
          likelyCulprit: request.batchDiagnostic.likelyCulprit,
        }
      : null,
    agentClient: ('agentClient' in row ? row.agentClient : undefined) ?? null,
    noOwnerCause: request.observation?.stall?.missingOwner
      ? `${request.observation.stall.missingOwner} at ${request.observation.stall.step}`
      : null,
    retryCause: request.observation?.stall
      ? 'stall'
      : request.observation?.cause === 'conflict'
        ? 'conflict'
        : request.observation?.cause === 'check-failed'
          ? 'check-failure-or-flake'
          : 'other',
    ...(request.supersedes
      ? {
          retry: {
            operationId: request.operationId,
            actor: request.actor,
            supersedes: request.supersedes,
            reason: request.retryReason ?? 'other',
          },
        }
      : {}),
  };
}

export function metricAttemptSource(
  row: Pick<Doc<'projectHostedLandingAttempts'>, 'value' | '_creationTime'> &
    Partial<Pick<Doc<'projectHostedLandingAttempts'>, 'attemptId' | 'submissionId'>>,
) {
  const attempt = JSON.parse(row.value) as HostedLandingAttempt;
  return {
    id: row.attemptId ?? attempt.id,
    submissionId: row.submissionId ?? attempt.submissionId,
    at: attempt.at ?? new Date(row._creationTime).toISOString(),
    parentAttemptId: attempt.parentAttemptId ?? null,
    mainHead: attempt.main?.head ?? null,
    inputPin: (attempt.memberCandidate ?? attempt.candidate)?.inputs ?? null,
    runId: attempt.check?.runId ?? null,
    recheckReason: attempt.recheckReason ?? attempt.forkReason ?? null,
    scopedFallback: attempt.scopedFallback ?? null,
    actorKind: attempt.actor?.kind ?? null,
  };
}
