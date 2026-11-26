// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One landing's failure cause (Items b030c3c5, 2c420916), read the same way for the Failed check screen
// (projectFailureCause.forLane) and for agent replies (status by Lane or submission, land and wait), so a
// person and an agent see the same cause and the same next step. Failure-only: a landing that is queued,
// checking, landed or in conflict returns before any extra read.
import { z } from 'zod';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './server';
import { composeRow } from './projectHostedComposeStore';
import { deferredOrigin, landingAttemptRow, loadLandingAttempt } from './projectHostedLandingAttemptRead';
import { loadHostedCheck } from './projectHostedCheckStore';
import { checkFailureStep } from './projectHostedCheckFailure';
import { auditRow, parkExactOnMainRed, parkOnMainRed } from './projectHostedMainAuditState';
import { summarizeCheckRun } from '../src/hosted-check-summary';
import { failureCause, failureCauseField } from '../src/check-failure-cause';
import { landingStateOf } from '../src/landing-state';
import type { HostedLandingState } from '../src/hosted-landing';
import { overlapLaneChanges } from './projectHostedOverlapChanges';

const composeCandidate = z.looseObject({ candidateId: z.uuid() });
/** At most this many changed paths feed attribution; a larger Lane is marked incomplete. */
const LANE_PATHS = 2_000;
type Project = Id<'hostedProjects'>;

/** A Lane's changed paths from its overlap row, bounded to LANE_PATHS. A slim row reads its bucket rows. */
export async function lanePaths(ctx: QueryCtx, overlap: Doc<'projectHostedOverlapLanes'> | null) {
  const changes = overlap ? (JSON.parse(await overlapLaneChanges(ctx, overlap)) as { path: string }[]) : null;
  const lane = changes
    ? {
        paths: changes.slice(0, LANE_PATHS).map(change => change.path),
        complete: overlap!.complete && changes.length <= LANE_PATHS,
      }
    : null;
  return { count: changes?.length ?? null, lane };
}

/** The Lane's overlap row (one indexed read). */
export const laneOverlap = (ctx: QueryCtx, projectId: Project, laneId: string) =>
  ctx.db
    .query('projectHostedOverlapLanes')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();

/** main's last audit as the cause contract reads it: one indexed read. */
export async function mainEvidence(ctx: QueryCtx, projectId: Project) {
  const audit = await auditRow(ctx, projectId);
  return audit
    ? {
        result:
          audit.lastGreen && audit.lastGreen.sequence >= (audit.audit?.sequence ?? -1)
            ? 'passed'
            : (audit.audit?.status ?? null),
        redSince: audit.red?.since ?? null,
      }
    : null;
}

/** The Lane's newest landing request: its compose selection, compose row and request (three indexed reads). */
export async function laneLandingRequest(ctx: QueryCtx, projectId: Project, laneId: string) {
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
  return { candidateId, request: request ?? null };
}

/** The check run summary and failing step of one landing attempt: attempt (1-2), run (1), and only for a
 * failed run that names no test file its job summaries (at most 64). */
export async function landingRun(
  ctx: QueryCtx,
  projectId: Project,
  row: Doc<'projectHostedLandingRequests'>,
  state: HostedLandingState,
) {
  const attemptKey = { projectId, attemptId: state.attemptId };
  const live = await landingAttemptRow(ctx, attemptKey);
  const attempt = row.capsule && !live ? null : await loadLandingAttempt(ctx, attemptKey, live);
  const loaded = attempt?.check
    ? await loadHostedCheck(ctx, { projectId, runId: attempt.check.runId })
    : null;
  const summary = loaded ? summarizeCheckRun(loaded.run) : null;
  const step =
    loaded && loaded.run.status === 'failed' ? await checkFailureStep(ctx, projectId, loaded.run) : null;
  // Only a failed run gets re-land advice: a passing or running check reads nothing more.
  const parks = loaded?.run.status === 'failed' && (await reDefers(ctx, projectId, state, attempt));
  return { summary, step, reDefers: parks };
}

/** Whether a fresh land of this change would be deferred again, so a check failing only on main's
 * red parks it (Item 687d1eda): its request could be deferred and its attempt chain was. Failed
 * runs only; free request fields first; then the attempt chain past platform retries (at most
 * three reads), only while both park switches are on. Unknown means no: the advice falls back to landing again once main passes. */
async function reDefers(
  ctx: QueryCtx,
  projectId: Project,
  state: HostedLandingState,
  attempt: Awaited<ReturnType<typeof loadLandingAttempt>> | null,
) {
  const { request } = state;
  if (!parkOnMainRed() || !parkExactOnMainRed() || !attempt) return false;
  if (!request.finish || request.finish.after || request.revertOf || request.check?.kind !== 'request')
    return false;
  if (attempt.deferredCheck) return true;
  return (await deferredOrigin(ctx, projectId, attempt)) !== null;
}

type Evidence = {
  state: HostedLandingState;
  laneId?: string | undefined;
  summary: ReturnType<typeof summarizeCheckRun> | null;
  step: Awaited<ReturnType<typeof checkFailureStep>>;
  lane: { paths: string[]; complete: boolean } | null;
  main: Awaited<ReturnType<typeof mainEvidence>>;
  /** landingRun's reDefers: a fresh land would park on main's red. */
  reDefers?: boolean;
};
/** The contract's cause from evidence already read. No reads. */
export function causeFrom({ state, laneId, summary, step, lane, main, reDefers = false }: Evidence) {
  return failureCause({
    landing: { state: landingStateOf(state, laneId).state, code: state.error?.code },
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
    parksOnMainRed: reDefers,
  });
}

/** True when this landing state has a cause to explain; decided from the state alone, before any read. */
const explainable = (state: HostedLandingState, laneId?: string) =>
  failureCause({ landing: { state: landingStateOf(state, laneId).state } }) !== null;

/** The Lane a single-Lane landing was composed from: one indexed read of its compose selection. */
async function submittedLane(ctx: QueryCtx, projectId: Project, state: HostedLandingState) {
  const compose = state.request.finish?.composeOperationId;
  if (!compose) return null;
  const rows = await ctx.db
    .query('projectHostedComposeSelections')
    .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
      q.eq('projectId', projectId).eq('actor', state.actor).eq('operationId', compose).eq('kind', 'inputs'),
    )
    .take(2);
  return rows.length === 1 ? rows[0]!.key : null;
}

/**
 * The bound run and, for a failed landing, the agent-reply `failureCause`. The run ID comes from
 * the selected landing row. Healthy path: 0 additional reads. A landing with a cause adds its Lane's compose selection and overlap row (2,
 * skipped when the Lane is known), the attempt and run (2-3, plus at most 64 job summaries for a failed run
 * with no test file) and main's audit row (1). No writes, no log fetch.
 */
export async function failureCauseReply(
  ctx: QueryCtx,
  projectId: Project,
  row: Doc<'projectHostedLandingRequests'>,
  state: HostedLandingState,
  knownLane?: { laneId: string; lane: { paths: string[]; complete: boolean } | null },
) {
  const boundRunId = row.runId ?? state.acceptance?.proofRunId;
  if (!explainable(state, knownLane?.laneId)) return boundRunId ? { checkRunId: boundRunId } : {};
  const laneId = knownLane?.laneId ?? (await submittedLane(ctx, projectId, state));
  const lane = knownLane
    ? knownLane.lane
    : laneId
      ? (await lanePaths(ctx, await laneOverlap(ctx, projectId, laneId))).lane
      : null;
  const { summary, step, reDefers } = await landingRun(ctx, projectId, row, state);
  const main = await mainEvidence(ctx, projectId);
  const field = failureCauseField(
    causeFrom({ state, laneId: laneId ?? undefined, summary, step, lane, main, reDefers }),
  );
  const checkRunId = summary?.runId ?? boundRunId;
  return {
    ...(checkRunId ? { checkRunId } : {}),
    ...(field ? { failureCause: field } : {}),
  };
}
