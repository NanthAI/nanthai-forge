// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { canonicalPayload } from '../src/hosted-source-operation';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import type { HostedLandingAttempt, HostedLandingState } from '../src/hosted-landing';
import type { HostedCheckRun } from '../src/hosted-check';
import { invariant } from '../src/errors';
import { report } from './errors';

const tables = {
  acceptances: 'projectHostedAcceptances',
  requests: 'projectHostedLandingRequests',
  runs: 'projectHostedCheckRuns',
  operations: 'projectHostedOperations',
} as const;
/** Creation-time indexes include a one-day context window. Old pending requests,
 * pre-window results and unavailable immutable input objects remain named gaps.
 * Nothing in this query wakes execution or materializes metric records. */
export const page = query({
  args: {
    projectId: v.id('hostedProjects'),
    stream: v.union(
      v.literal('acceptances'),
      v.literal('requests'),
      v.literal('runs'),
      v.literal('operations'),
    ),
    from: v.string(),
    to: v.string(),
    cursor: v.union(v.string(), v.null()),
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
      const selected =
        input.stream === 'operations'
          ? ctx.db.query('projectHostedOperations').withIndex('by_project_and_metric_action', q =>
              q
                .eq('projectId', input.projectId)
                .eq('metricMutation.action', 'cancel')
                .gte('_creationTime', from - 86400000)
                .lt('_creationTime', to),
            )
          : ctx.db.query(tables[input.stream]).withIndex('by_project', q =>
              q
                .eq('projectId', input.projectId)
                .gte('_creationTime', from - 86400000)
                .lt('_creationTime', to),
            );
      const rows = await selected.order('desc').paginate({
        cursor: input.cursor,
        numItems: 100,
        maximumRowsRead: 100,
        maximumBytesRead: 512 * 1024,
      });
      const values = await Promise.all(
        rows.page.map(async row => {
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
              ...(submitted?.supersedes ? { path: 'after-retry' } : {}),
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
              // A check name alone does not establish full-suite coverage.
              fullSuite: null,
            };
          }
          if (input.stream === 'requests') {
            const request = JSON.parse(row.value) as HostedLandingState;
            return {
              id: request.id,
              at: request.at,
              status: request.phase,
              runIds: 'runId' in row && row.runId ? [row.runId] : [],
              progressAt: Object.values(request.timing ?? {}),
              errorCode: request.error?.code ?? null,
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
          return { id: row._id, ...('metricMutation' in row ? { mutation: row.metricMutation } : {}) };
        }),
      );
      return canonicalPayload({
        page: values,
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
