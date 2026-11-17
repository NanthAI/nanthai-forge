// SPDX-License-Identifier: Apache-2.0
// The Failed check screen's one read (Items b030c3c5 and 2c420916): a Lane's newest landing, its check run summary
// and the failure cause from src/check-failure-cause.ts. A subscription; it re-runs only when one of the rows it read
// is written, so an idle or settled page costs nothing.
import { v } from 'convex/values';
import { z } from 'zod';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { composeRow } from './projectHostedComposeStore';
import { loadLanding } from './projectHostedLandingStore';
import { landingAttemptRow, loadLandingAttempt } from './projectHostedLandingAttemptRead';
import { loadHostedCheck } from './projectHostedCheckStore';
import { checkFailureStep } from './projectHostedCheckFailure';
import { auditRow } from './projectHostedMainAuditState';
import { readHostedRecord } from './projectHostedRecords';
import { report } from './errors';
import { summarizeCheckRun } from '../src/hosted-check-summary';
import { failureCause } from '../src/check-failure-cause';
import { landingStateOf } from '../src/landing-state';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';

const composeCandidate = z.looseObject({ candidateId: z.uuid() });
const intentTitle = z.looseObject({ outcome: z.string() });
/** At most this many changed paths feed attribution; a larger Lane is marked incomplete. */
const LANE_PATHS = 2_000;

/**
 * Budget per view (stated for b030c3c5): 1 query execution. Reads, all by index: project access (2), the Lane's
 * overlap row (1), its intent (2), the newest compose selection and its row (2), the newest landing request,
 * its state and attempt (3), the check run (1), main's audit row (1), and only for a failed run that names no
 * test file the run's job summaries (at most 64). No writes, no scheduler, no log fetch, no polling.
 */
export const forLane = query({
  args: { projectId: v.id('hostedProjects'), laneId: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, laneId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read a landing check.');
      await accessibleProject(ctx, projectId, user.subject);
      const overlap = await ctx.db
        .query('projectHostedOverlapLanes')
        .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
        .unique();
      const intent = overlap
        ? await readHostedRecord(ctx, {
            projectId,
            actor: user.subject,
            kind: 'intent',
            key: overlap.intentId,
          })
        : null;
      const title = intent ? (intentTitle.safeParse(JSON.parse(intent.value)).data?.outcome ?? null) : null;
      const changes = overlap ? (JSON.parse(overlap.changes) as { path: string }[]) : null;
      const lane = changes
        ? {
            paths: changes.slice(0, LANE_PATHS).map(change => change.path),
            complete: overlap!.complete && changes.length <= LANE_PATHS,
          }
        : null;
      const [selection] = await ctx.db
        .query('projectHostedComposeSelections')
        .withIndex('by_project_and_kind_and_key', q =>
          q.eq('projectId', projectId).eq('kind', 'inputs').eq('key', laneId),
        )
        .order('desc')
        .take(1);
      const compose = selection ? await composeRow(ctx, selection) : null;
      const candidateId = compose ? composeCandidate.parse(JSON.parse(compose.value)).candidateId : null;
      const [request] = candidateId
        ? await ctx.db
            .query('projectHostedLandingRequests')
            .withIndex('by_project_and_candidate_and_sequence', q =>
              q.eq('projectId', projectId).eq('candidateId', candidateId),
            )
            .order('desc')
            .take(1)
        : [];
      const audit = await auditRow(ctx, projectId);
      const main = audit
        ? {
            result:
              audit.lastGreen && audit.lastGreen.sequence >= (audit.audit?.sequence ?? -1)
                ? 'passed'
                : (audit.audit?.status ?? null),
            redSince: audit.red?.since ?? null,
          }
        : null;
      if (!request)
        return canonicalPayload({
          laneId,
          title,
          candidateId,
          landing: null,
          run: null,
          cause: null,
          main,
          lane,
        });
      const { state, row } = await loadLanding(ctx, { projectId, submissionId: request.submissionId });
      const attemptKey = { projectId, attemptId: state.attemptId };
      const live = await landingAttemptRow(ctx, attemptKey);
      const attempt = row.capsule && !live ? null : await loadLandingAttempt(ctx, attemptKey, live);
      const loaded = attempt?.check
        ? await loadHostedCheck(ctx, { projectId, runId: attempt.check.runId })
        : null;
      const summary = loaded ? summarizeCheckRun(loaded.run) : null;
      const step =
        loaded && loaded.run.status === 'failed' ? await checkFailureStep(ctx, projectId, loaded.run) : null;
      const landing = landingStateOf(state, laneId);
      const cause = failureCause({
        landing: { state: landing.state, code: state.error?.code },
        run: summary
          ? {
              status: summary.status,
              failed: summary.failed,
              failedCount: summary.files.failed ?? undefined,
              flaky: summary.flaky,
              step,
            }
          : null,
        lane: lane?.complete ? lane : null,
        main,
      });
      return canonicalPayload({
        laneId,
        title,
        candidateId,
        landing: {
          submissionId: state.id,
          operationId: request.operationId,
          phase: state.phase,
          state: landing.state,
          label: landing.label,
          nextStep: landing.nextStep,
          at: state.at,
          retryReason: state.retryReason ?? null,
          error: state.error ? { code: state.error.code, message: state.error.message.slice(0, 600) } : null,
          receiptId: state.acceptance?.receiptId ?? null,
        },
        run: summary,
        cause,
        main,
        lane: lane ? { count: changes!.length, complete: lane.complete } : null,
      });
    } catch (error) {
      return report(error);
    }
  },
});
