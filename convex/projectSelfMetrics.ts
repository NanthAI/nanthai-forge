// SPDX-License-Identifier: Apache-2.0
import { capsuleMetricsPage } from './projectLandingCapsuleMetrics';
import { capsuleAttempt } from './projectLandingCapsuleStore';
import { v } from 'convex/values';
import { query } from './cliServer';
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { canonicalPayload } from '../src/hosted-source-operation';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import type { HostedLandingAttempt, HostedLandingState } from '../src/hosted-landing';
import type { HostedRecord } from '../src/hosted-records';
import { type HostedCheckRun } from '../src/hosted-check';
import { invariant } from '../src/errors';
import { metricRunRow } from '../src/self-metrics-run';
import { metricRunsPage } from './projectMetricReadRuns';
import { report } from './errors';
import { metricReceiptCoverage } from '../src/self-metric-receipts';
import { landingCosts } from '../src/hosted-landings-view';
import { landingSpeedSample } from '../src/landing-speed-alerts';

const tables = {
  acceptances: 'projectHostedAcceptances',
  requests: 'projectHostedLandingRequests',
  runs: 'projectHostedCheckRuns',
  operations: 'projectHostedOperations',
  attempts: 'projectHostedLandingAttempts',
} as const;
/** Project metrics are readable by the owner and agent-guidance maintainers. */
export async function metricsReader(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read project metrics.');
  const project = await accessibleProject(ctx, projectId, user.subject);
  if (project.owner !== user.subject) {
    const member = await ctx.db
      .query('projectContributors')
      .withIndex('by_project_and_contributor', q =>
        q.eq('projectId', projectId).eq('contributor', user.subject),
      )
      .unique();
    invariant(
      member?.agentGuidanceMaintainer === true,
      'PROJECT_UNAVAILABLE',
      'Project metrics require owner or maintainer access.',
    );
  }
  return project;
}
/** Main-audit events read per acceptances page. A bounded take, not a second paginate():
 * Convex allows one paginated query per query function, and the page already runs one. */
const mainAuditEventLimit = 100;
/** Main-audit events for the proved-reuse back-stop metric (Issue 71767c9b). One
 * bounded read rides on the first acceptances page, so it adds no call. Newest
 * first, down to the first green or flake before the window: that event bounds
 * the range the earliest in-window failure audited. */
async function mainAuditEvents(ctx: QueryCtx, projectId: Id<'hostedProjects'>, from: number, to: number) {
  const rows = await ctx.db
    .query('projectHostedMainAuditEvents')
    .withIndex('by_project_and_sequence', q => q.eq('projectId', projectId))
    .order('desc')
    .take(mainAuditEventLimit);
  const events = [];
  let complete = rows.length < mainAuditEventLimit;
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (at >= to) continue;
    events.push({
      kind: row.kind,
      at: row.at,
      sequence: row.sequence,
      ...(row.culprit ? { culprit: row.culprit } : {}),
    });
    if (at < from && (row.kind === 'green' || row.kind === 'flake')) {
      complete = true;
      break;
    }
  }
  return { events, complete };
}
/** Compact, demand-driven pages. A finite context horizon is explicit in coverage.
 * Nothing in this query wakes execution or materializes metric records. */
export const page = query({
  args: {
    projectId: v.id('hostedProjects'),
    stream: v.union(
      v.literal('acceptances'),
      v.literal('requests'),
      v.literal('runs'),
      v.literal('operations'),
      v.literal('attempts'),
      v.literal('lanes'),
      v.literal('saves'),
      v.literal('receipts'),
    ),
    from: v.string(),
    to: v.string(),
    cursor: v.union(v.string(), v.null()),
    contextDays: v.optional(v.number()),
    compactRuns: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const project = await metricsReader(ctx, input.projectId);
      const from = Date.parse(input.from),
        to = Date.parse(input.to);
      invariant(
        Number.isFinite(from) && Number.isFinite(to) && from < to,
        'BAD_ARGUMENT',
        'Use a finite metrics window [from,to).',
      );
      // Zero/fractional days are explicit; absent keeps the original horizon for older clients.
      const contextDays = Math.min(
        30,
        Math.max(0, Number.isFinite(input.contextDays) ? input.contextDays! : 30),
      );
      const context = from - contextDays * 86400000;
      if (input.stream === 'runs' && input.compactRuns)
        return canonicalPayload({
          ...(await metricRunsPage(ctx, input.projectId, context, to, input.cursor)),
          contextFrom: new Date(context).toISOString(),
          runProjectionVersion: 1,
          cutover: project.sourceCutover?.at ?? null,
          authority: project.sourceAuthority ?? { mode: 'native-owner', epoch: 0 },
        });
      if (input.stream === 'attempts') {
        const page = await capsuleMetricsPage(ctx, input.projectId, context, to, input.cursor);
        if (page)
          return canonicalPayload({
            ...page,
            runProjectionVersion: 1,
            contextFrom: new Date(context).toISOString(),
            cutover: project.sourceCutover?.at ?? null,
            authority: project.sourceAuthority ?? { mode: 'native-owner', epoch: 0 },
          });
      }
      if (input.stream === 'receipts') {
        const rows = await ctx.db
          .query('projectSelfMetricReceipts')
          .withIndex('by_project_and_at', q =>
            q
              .eq('projectId', input.projectId)
              .gte('at', new Date(context).toISOString())
              .lt('at', new Date(to).toISOString()),
          )
          .order('desc')
          .paginate({
            cursor: input.cursor,
            numItems: 100,
            maximumRowsRead: 100,
            maximumBytesRead: 512 * 1024,
          });
        // Collection starts are one point read per receipt kind, on the first page only.
        const coverage: Record<string, string | null> = {};
        if (input.cursor === null)
          for (const [metric, kind] of Object.entries(metricReceiptCoverage))
            coverage[metric] =
              (
                await ctx.db
                  .query('projectSelfMetricReceipts')
                  .withIndex('by_project_and_kind_and_at', q =>
                    q.eq('projectId', input.projectId).eq('kind', kind),
                  )
                  .first()
              )?.at ?? null;
        return canonicalPayload({
          page: rows.page.map(row => ({
            kind: row.kind,
            actor: row.actor,
            at: row.at,
            ...JSON.parse(row.value),
          })),
          ...(input.cursor === null ? { coverage } : {}),
          contextFrom: new Date(context).toISOString(),
          isDone: rows.isDone,
          continueCursor: rows.continueCursor,
          cutover: project.sourceCutover?.at ?? null,
          authority: project.sourceAuthority ?? { mode: 'native-owner', epoch: 0 },
        });
      }
      const selected =
        input.stream === 'operations'
          ? ctx.db
              .query('projectHostedOperations')
              .withIndex('by_project_and_metric_action', q =>
                q
                  .eq('projectId', input.projectId)
                  .eq('metricMutation.action', 'cancel')
                  .gte('_creationTime', context)
                  .lt('_creationTime', to),
              )
          : input.stream === 'lanes' || input.stream === 'saves'
            ? ctx.db.query('projectHostedRecords').withIndex('by_project_and_kind', q =>
                q
                  .eq('projectId', input.projectId)
                  .eq('kind', input.stream === 'lanes' ? 'lane' : 'save')
                  .gte('_creationTime', context)
                  .lt('_creationTime', to),
              )
            : ctx.db
                .query(tables[input.stream])
                .withIndex('by_project', q =>
                  q.eq('projectId', input.projectId).gte('_creationTime', context).lt('_creationTime', to),
                );
      const rows = await selected.order('desc').paginate({
        cursor: input.cursor,
        numItems: 100,
        maximumRowsRead: 100,
        maximumBytesRead: 512 * 1024,
      });
      const values = await Promise.all(
        rows.page.map(async row => {
          if (input.stream === 'lanes' || input.stream === 'saves') {
            invariant('bodyId' in row, 'EVIDENCE_CHANGED', 'Metric record body is missing.');
            const body = await ctx.db.get(row.bodyId);
            invariant(
              body && body.projectId === input.projectId,
              'EVIDENCE_CHANGED',
              'Metric record body is missing.',
            );
            const record = JSON.parse(body.value) as HostedRecord;
            if (record.kind === 'lane')
              return {
                id: record.id,
                version: record.version,
                intentId: record.intentId,
                revert: !!record.revert,
              };
            invariant(record.kind === 'save', 'EVIDENCE_CHANGED', 'Metric record kind changed.');
            return { id: record.id, laneId: record.laneId, head: record.head, at: record.at };
          }
          invariant('value' in row, 'EVIDENCE_CHANGED', 'Metric record value is missing.');
          if (input.stream === 'acceptances') {
            const move = JSON.parse(row.value) as HostedAcceptance;
            const request = await ctx.db
              .query('projectHostedLandingRequests')
              .withIndex('by_project_and_submission', q =>
                q.eq('projectId', input.projectId).eq('submissionId', move.submissionId),
              )
              .unique();
            const attempt = await ctx.db
              .query('projectHostedLandingAttempts')
              .withIndex('by_project_and_attempt', q =>
                q.eq('projectId', input.projectId).eq('attemptId', move.attemptId),
              )
              .unique();
            const submitted = request ? (JSON.parse(request.value) as HostedLandingState) : null;
            const selected = attempt
              ? (JSON.parse(attempt.value) as HostedLandingAttempt)
              : await capsuleAttempt(ctx, { projectId: input.projectId, attemptId: move.attemptId });
            return {
              id: move.id,
              at: move.at,
              head: move.candidate.head,
              submissionId: move.submissionId,
              submittedAt: submitted?.timing?.submittedAt ?? submitted?.at ?? null,
              trusted: selected?.actor.kind === 'agent' && selected.policy.acceptance.mode === 'auto-on-pass',
              kind: request?.revertOf ? 'compensating' : 'landing',
              attemptId: move.attemptId,
              // A stacked batch Candidate has empty inputs; its members' Lanes ride on memberCandidate.
              inputPin: (move.memberCandidate ?? move.candidate).inputs ?? null,
              // Back-stop metric (Issue 71767c9b): derived from the receipt, no write.
              reused: Boolean(move.crossHeadProof),
              revision: move.snapshot?.revision ?? null,
              // Why an admitted landing did not land on its first check (7c2e69e1); null: it did or was not admitted.
              firstCheckRecheck:
                move.firstCheck && move.firstCheck.landedOn !== 'admission-run'
                  ? move.firstCheck.reason
                  : null,
              // Whether an admitted landing took its first check as acceptance evidence (M5); null: not admitted.
              landedOnAdmissionRun: move.firstCheck ? move.firstCheck.landedOn === 'admission-run' : null,
              // The submitting agent run's declared client: harness and model (81d12a32).
              agentClient: move.agentClient ?? null,
              costs: landingCosts(submitted, attempt?.number ?? selected?.number),
              ...(submitted?.timing?.ms?.[0] == null ? {} : { saveMs: submitted.timing.ms[0] }),
              ...(submitted?.timing?.ms?.[1] == null ? {} : { preflightMs: submitted.timing.ms[1] }),
              settleSeconds: submitted ? (landingSpeedSample(submitted)?.settle ?? null) : null,
            };
          }
          if (input.stream === 'runs')
            return metricRunRow(
              JSON.parse(row.value) as HostedCheckRun,
              'reportFlakes' in row ? row.reportFlakes : undefined,
            );
          if (input.stream === 'requests') {
            const request = JSON.parse(row.value) as HostedLandingState;
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
          if (input.stream === 'attempts') {
            const attempt = JSON.parse(row.value) as HostedLandingAttempt;
            return {
              id: 'attemptId' in row ? row.attemptId : attempt.id,
              submissionId: 'submissionId' in row ? row.submissionId : attempt.submissionId,
              at: attempt.at ?? new Date(row._creationTime).toISOString(),
              parentAttemptId: attempt.parentAttemptId ?? null,
              mainHead: attempt.main?.head ?? null,
              inputPin: (attempt.memberCandidate ?? attempt.candidate)?.inputs ?? null,
              runId: attempt.check?.runId ?? null,
              recheckReason: attempt.recheckReason ?? null,
              scopedFallback: attempt.scopedFallback ?? null,
              actorKind: attempt.actor?.kind ?? null,
            };
          }
          return { id: row._id, ...('metricMutation' in row ? { mutation: row.metricMutation } : {}) };
        }),
      );
      return canonicalPayload({
        page: values,
        runProjectionVersion: 1,
        ...(input.stream === 'acceptances' && input.cursor === null
          ? { audits: await mainAuditEvents(ctx, input.projectId, from, to) }
          : {}),
        contextFrom: new Date(context).toISOString(),
        isDone: rows.isDone,
        continueCursor: rows.continueCursor,
        cutover: project.sourceCutover?.at ?? null,
        authority: project.sourceAuthority ?? { mode: 'native-owner', epoch: 0 },
      });
    } catch (error) {
      return report(error);
    }
  },
});
