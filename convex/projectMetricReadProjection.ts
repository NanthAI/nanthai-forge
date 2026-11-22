// SPDX-License-Identifier: Apache-2.0
import { canonicalPayload } from '../src/hosted-source-operation';
import { metricRunRow } from '../src/self-metrics-run';
import { FAST_WINDOW, auditDonorSignal } from '../src/landing-mode';
import type { QueryCtx } from './server';
import type { Id } from './_generated/dataModel';
import { type HostedCheckRun, checkCauseSchema } from '../src/hosted-check';

export const metricRunKind = 'projectMetricCheckRuns';
/** Unsupported legacy values stay on the canonical reader; never manufacture metric evidence. */
export function metricReadProjection(row: Record<string, unknown>) {
  let run: HostedCheckRun;
  try {
    run = JSON.parse(row.value as string);
  } catch {
    return null;
  }
  if (!run?.id || !run.at || !run.request?.expectedHead || !run.cost) return null;
  const sourceCreatedAt = row.sourceCreatedAt ?? row._creationTime;
  if (typeof sourceCreatedAt !== 'number') return null;
  return {
    kind: metricRunKind,
    sourceId: row._id as string,
    projectId: row.projectId as HostedCheckRun['projectId'],
    runId: row.runId as string,
    sourceCreatedAt,
    value: canonicalPayload(
      metricRunRow(run, row.reportFlakes, checkCauseSchema.safeParse(row.cause).data, {
        auditDonor: typeof row.auditDonor === 'boolean' ? row.auditDonor : undefined,
        auditCoverage: typeof row.auditCoverage === 'string' ? row.auditCoverage : undefined,
      }),
    ),
  };
}

/** One bounded read at an automatic audit start, off the check-start path. */
export async function recentAuditDonors(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  const recent = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_project_and_source_time', q =>
      q.eq('kind', metricRunKind).eq('projectId', projectId),
    )
    .order('desc')
    .take(FAST_WINDOW);
  return auditDonorSignal(recent.map(row => JSON.parse(row.value) as ReturnType<typeof metricRunRow>));
}

export function metricAttemptRow(attempt: import('../src/hosted-landing').HostedLandingAttempt) {
  return [
    attempt.at,
    attempt.parentAttemptId ?? null,
    attempt.main?.head ?? null,
    attempt.check?.runId ?? null,
    attempt.recheckReason ?? null,
    attempt.scopedFallback ?? null,
    attempt.actor?.kind ?? null,
    attempt.memberCandidate?.inputs ?? null,
    // Metrics-only fork name (c3c69c57), after the slots stats reads: slot 4 stays the queue's
    // recheckReason, so public stats never counts a fork as a main race (review f86cb784).
    ...(attempt.forkReason ? [attempt.forkReason] : []),
  ];
}
/** An archived generation's compact row keeps its two reason fields separately. */
export function readMetricAttemptPins(row: import('./_generated/dataModel').Doc<'projectFinishReadRows'>) {
  const value = JSON.parse(row.value);
  const attempt = JSON.parse(value.value);
  const [
    at,
    parentAttemptId,
    mainHead,
    runId,
    recheckReason,
    scopedFallback,
    actorKind,
    memberInputs,
    forkReason,
  ] = attempt.metric;
  return {
    id: value.attemptId,
    submissionId: value.submissionId,
    selection: { projectId: value.projectId, number: value.number, candidateHead: attempt.candidate.head },
    at,
    parentAttemptId,
    mainHead,
    inputPin: memberInputs ?? attempt.candidate.inputs,
    runId,
    recheckReason: recheckReason ?? null,
    forkReason: forkReason ?? null,
    scopedFallback,
    actorKind,
  };
}

export function readMetricAttempt(row: import('./_generated/dataModel').Doc<'projectFinishReadRows'>) {
  const { forkReason, selection: _selection, ...metric } = readMetricAttemptPins(row);
  void _selection;
  return { ...metric, recheckReason: metric.recheckReason ?? forkReason };
}
