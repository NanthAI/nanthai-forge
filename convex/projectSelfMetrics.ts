// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { canonicalPayload } from '../src/hosted-source-operation';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import type { HostedLandingAttempt, HostedLandingState } from '../src/hosted-landing';
import type { HostedRecord } from '../src/hosted-records';
import type { HostedCheckRun } from '../src/hosted-check';
import { invariant } from '../src/errors';
import { hostedRunReuseKey } from '../src/self-metrics-reuse-key';
import { scopedRecheckBase } from '../src/scoped-recheck-policy';
import { report } from './errors';
import { metricReceiptCoverage } from '../src/self-metric-receipts';

const tables = {
  acceptances: 'projectHostedAcceptances',
  requests: 'projectHostedLandingRequests',
  runs: 'projectHostedCheckRuns',
  operations: 'projectHostedOperations',
  attempts: 'projectHostedLandingAttempts',
} as const;
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
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read project metrics.');
      const project = await accessibleProject(ctx, input.projectId, user.subject);
      if (project.owner !== user.subject) {
        const member = await ctx.db
          .query('projectContributors')
          .withIndex('by_project_and_contributor', q =>
            q.eq('projectId', input.projectId).eq('contributor', user.subject),
          )
          .unique();
        invariant(
          member?.agentGuidanceMaintainer === true,
          'PROJECT_UNAVAILABLE',
          'Project metrics require owner or maintainer access.',
        );
      }
      const from = Date.parse(input.from),
        to = Date.parse(input.to);
      invariant(
        Number.isFinite(from) && Number.isFinite(to) && from < to,
        'BAD_ARGUMENT',
        'Use a finite metrics window [from,to).',
      );
      const context = from - (input.contextDays === 1 ? 1 : 30) * 86400000;
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
        // Collection starts are three point reads, on the first page only.
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
            const selected = attempt ? (JSON.parse(attempt.value) as HostedLandingAttempt) : null;
            return {
              id: move.id,
              at: move.at,
              head: move.candidate.head,
              submissionId: move.submissionId,
              submittedAt: submitted?.timing?.submittedAt ?? submitted?.at ?? null,
              trusted: selected?.actor.kind === 'agent' && selected.policy.acceptance.mode === 'auto-on-pass',
              kind: request?.revertOf ? 'compensating' : 'landing',
              attemptId: move.attemptId,
              inputPin: move.candidate.inputs ?? null,
            };
          }
          if (input.stream === 'runs') {
            const run = JSON.parse(row.value) as HostedCheckRun;
            return {
              id: run.id,
              at: run.at,
              endedAt: run.endedAt,
              status: run.status,
              head: run.request.expectedHead,
              started: !!run.executionId,
              // Cost.seconds is observed execution time, never the billed dollar amount.
              runnerMinutes:
                run.cost.status === 'observed' && run.cost.seconds !== null ? run.cost.seconds / 60 : null,
              inputPin: run.candidate?.inputs ?? null,
              reuseKey: hostedRunReuseKey(run.plan),
              // Explicit selection is evidence; a check name alone is not.
              fullSuite:
                (run.gate ?? run.request.gate)
                  ? ['full', 'audit'].includes((run.gate ?? run.request.gate)!.mode) ||
                    (run.gate ?? run.request.gate)!.effective === 'full'
                  : null,
              ...(scopedRecheckBase(run.gate) ? { scopedRecheck: true } : {}),
            };
          }
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
              progressAt: Object.values(request.timing ?? {}),
              errorCode: request.error?.code ?? null,
              compensating: 'revertOf' in row && !!row.revertOf,
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
              inputPin: attempt.candidate?.inputs ?? null,
              runId: attempt.check?.runId ?? null,
            };
          }
          return { id: row._id, ...('metricMutation' in row ? { mutation: row.metricMutation } : {}) };
        }),
      );
      return canonicalPayload({
        page: values,
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
