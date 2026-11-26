// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { pendingRunnerState } from './cancelledRunUsage';
import { readProviderDelay } from './projectHostedLandingCheckProgress';
import { failureCauseReply } from './projectFailureCauseRead';
import { finishReadReader, finishReadSourceDb, selectExactFinishProject } from './projectFinishReadReader';
import { readWouldConflict, syncRequiredQueue } from './projectHostedLandingWouldConflict';
import { readQueueStatus, queueAwareLandingState } from './projectHostedQueueStatus';
import { landingOrderWaitForReader, landingStateForReader } from './projectHostedLandingOrder';
import { landingReservationForReader } from './projectHostedLandingReservation';
import { hostedQueueAheadSelection } from './projectHostedQueueAhead';
import { desiredLanding } from './projectHostedLandingDesiredWake';
import { preparingSourceStep } from './projectHostedPreparingSource';
import { sourceStepFailureField } from '../src/hosted-source-retry';
import { storedLandingStateSchema } from '../src/hosted-landing';
import { withLandingCapsule } from './projectLandingCapsuleStore';
import { capsuleHistoryContext } from './projectLandingCapsuleContext';
import { readLandingTransition } from '../src/hosted-landing';
import { landingAlias } from './projectHostedLandingIdentity';
import { finishPendingForReader } from '../src/hosted-finish';
import { ConvexError, v } from 'convex/values';
import { finishQuery as query, type QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { finishRow } from './projectHostedFinishWake';
import { landingRow, landingStateFromRow } from './projectHostedLandingStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import { sourceAuthority } from '../src/hosted-source-authority';
import { ForgeError, invariant } from '../src/errors';
import { report } from './errors';
import { boardWake } from './projectBoardDelivery';
import { held, heldReview, loadHeldPolicy, noteHeldPolicy, reviewState } from './projectHostedOwnerReview';
import { feedArrivalAnchor } from './projectFeedArrival';
import { stoppedMirror } from './projectGithubMirrorRows';

/** Finite selected-request pages. Every page/subscription rechecks current access;
 * neither reading nor reconnecting wakes a controller. Versions are durable offsets,
 * not authorization. An older record without retained versions is resnapshotted. */
export const page = query({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    nextVersion: v.number(),
    priorityInfo: v.optional(v.literal(1)),
    checklessInfo: v.optional(v.literal(1)),
    capsuleProtocol: v.optional(v.literal(1)),
    arrivalFence: v.optional(v.literal(1)),
    /** Wait delivery (feature board-wait): the live wait subscription only, never a page drain.
     * Adds `board` when a note reached this Lane's own inbox after the client's cursor. */
    board: v.optional(v.object({ laneId: v.string(), after: v.number() })),
  },
  returns: v.string(),
  handler: async (rawCtx, input) => {
    const payload = await observePage(rawCtx, input);
    if (!input.board && !input.arrivalFence) return payload;
    // Board delivery is advisory: it can never fail or change the landing observation.
    const reader = finishReadReader(rawCtx);
    const user = input.board ? await reader.auth.getUserIdentity() : null;
    const board =
      user && input.board
        ? await boardWake(reader, {
            projectId: input.projectId,
            viewer: user.subject,
            laneId: input.board.laneId,
            after: input.board.after,
          }).catch(() => undefined)
        : undefined;
    return board || input.arrivalFence
      ? canonicalPayload({
          ...JSON.parse(payload),
          ...(board ? { board } : {}),
          ...(input.arrivalFence ? { feedAfter: feedArrivalAnchor(rawCtx) } : {}),
        })
      : payload;
  },
});

async function selectOperation(
  ctx: QueryCtx,
  input: { projectId: Id<'hostedProjects'>; operationId: string },
  actor: string,
) {
  const rows = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_operation', q =>
      q.eq('projectId', input.projectId).eq('operationId', input.operationId),
    )
    .take(2);
  const alias = rows.length ? null : await landingAlias(ctx, { ...input, actor });
  if (alias) {
    const canonical = await landingRow(ctx, alias, false);
    if (canonical) rows.push(canonical);
  }
  const row = rows[0];
  return {
    rows,
    alias,
    reviewHeld: (row?.phase === 'ready' || row?.reviewState !== undefined) && held(JSON.parse(row.value)),
  };
}

async function observePage(
  rawCtx: QueryCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    operationId: string;
    nextVersion: number;
    priorityInfo?: 1;
    checklessInfo?: 1;
    capsuleProtocol?: 1;
  },
) {
  const ctx = finishReadReader(rawCtx);
  let stage = 'authorization',
    phase: string | null = null,
    version: number | null = null;
  let eventCount = 0;
  try {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to observe hosted submissions.');
    // Select the operation first so a held reply can authorize with the row that has its policy.
    // Current access is checked before the selected row or its absence can affect the reply.
    const selection = await selectOperation(ctx, input, user.subject).then(
      value => ({ value }),
      error => ({ error }),
    );
    if ('value' in selection && selection.value.reviewHeld) selectExactFinishProject(ctx, input.projectId);
    const project = await accessibleProject(ctx, input.projectId, user.subject);
    invariant(
      Number.isSafeInteger(input.nextVersion) && input.nextVersion >= 0,
      'BAD_ARGUMENT',
      'Select a submission version.',
    );
    stage = 'operation';
    if ('error' in selection) throw selection.error;
    const { rows, alias } = selection.value;
    const desired = rows.length
      ? null
      : alias
        ? await desiredLanding(ctx, alias)
        : await ctx.db
            .query('projectHostedLandingDesired')
            .withIndex('by_project_and_actor_and_operation', q =>
              q
                .eq('projectId', input.projectId)
                .eq('actor', user.subject)
                .eq('operationId', input.operationId),
            )
            .unique();
    if (!rows.length && desired) {
      stage = 'desired';
      const state = storedLandingStateSchema.parse(JSON.parse(desired.value));
      // A stalled preparation names its failed or fenced source step and cause (incident e62d834b).
      // Read only once stalled, so a healthy wait's subscription never follows the step row. The
      // compose id comes from the parsed request: the projected desired row carries no compose column.
      const compose = state.observation.stall ? state.request.finish?.composeOperationId : undefined;
      const step = compose ? await preparingSourceStep(ctx, input.projectId, desired.actor, compose) : null;
      const sourceFailure = step ? sourceStepFailureField(step) : undefined;
      return canonicalPayload({
        ...(sourceFailure ? { sourceFailure } : {}),
        projectId: input.projectId,
        operationId: input.operationId,
        canonicalOperationId: state.operationId,
        authority: sourceAuthority(project),
        submission: landingStateForReader(state, input),
        queuePosition: null,
        queue: null,
        queueAheadSelection: await hostedQueueAheadSelection(ctx, state),
        pendingAttempt: null,
        events: [
          {
            submission: landingStateForReader(state, input),
            pendingAttempt: null,
          },
        ],
        nextVersion: state.version + 1,
        isDone: true,
        resnapshot: true,
      });
    }
    invariant(rows.length === 1 || alias, 'NOT_FOUND', 'Select one hosted landing operation.');
    stage = 'landing';
    const selectedRow = await withLandingCapsule(ctx, rows[0] ?? null);
    invariant(selectedRow, 'NOT_FOUND', 'Hosted landing request not found.');
    const state = pendingRunnerState(landingStateFromRow(selectedRow), selectedRow.runnerAccounting?.pending);
    const cold = selectedRow.capsule && input.nextVersion <= selectedRow.capsule.version;
    phase = state.phase;
    version = state.version;
    stage = 'queue';
    const queue = await readQueueStatus(finishReadReader(rawCtx, 'owner'), state);
    const wouldConflict = state.phase === 'queued' ? readWouldConflict(selectedRow) : undefined;
    const orderWait = landingOrderWaitForReader(selectedRow, state);
    const reservation = landingReservationForReader(selectedRow);
    stage = 'finish';
    const finish = await finishRow(ctx, {
      projectId: input.projectId,
      submissionId: state.id,
    });
    const pendingAttempt = finish ? finishPendingForReader(JSON.parse(finish.value).pending) : null;
    const events = [];
    let nextVersion = cold ? selectedRow.capsule!.version + 1 : input.nextVersion,
      resnapshot = false;
    // Exact indexed reads keep both documents and ranges bounded, including gaps
    // in pre-journal history. Never scan unrelated operations or Work/source data.
    stage = 'history';
    for (let n = 0; n < 20 && nextVersion <= Math.min(state.version, input.nextVersion + 19); n++) {
      const row = await ctx.db
        .query('projectHostedLandingObservations')
        .withIndex('by_project_and_submission_and_version', q =>
          q.eq('projectId', input.projectId).eq('submissionId', state.id).eq('version', nextVersion),
        )
        .unique();
      if (!row) {
        events.push({
          submission: landingStateForReader(queueAwareLandingState(state, queue), input),
          pendingAttempt,
          ...(wouldConflict ? { wouldConflict } : {}),
        });
        nextVersion = state.version + 1;
        resnapshot = true;
        break;
      }
      const event = readLandingTransition(row.value, state);
      const submission = storedLandingStateSchema.parse(event.submission);
      if (submission.version === state.version) {
        if (state.counts) submission.counts = state.counts;
        else delete submission.counts;
      }
      events.push({
        ...event,
        pendingAttempt: finishPendingForReader(event.pendingAttempt),
        submission: landingStateForReader(submission, input),
      });
      nextVersion++;
      eventCount = events.length;
    }
    stage = 'response';
    // Only the current snapshot gains review details. History does not repeat a live handle or link.
    const [pin, review] = await Promise.all([
      loadHeldPolicy(ctx, project, state),
      heldReview(ctx, project, state),
    ]);
    if (pin)
      for (const event of events)
        if (event.submission.version === state.version)
          event.submission = noteHeldPolicy(event.submission, pin);
    const delay = await readProviderDelay(ctx, selectedRow, state);
    // The cause and next step the Failed check screen shows (b030c3c5); failure states only, 0 reads otherwise.
    const cause = await failureCauseReply(ctx, input.projectId, selectedRow, state);
    // A landing that will not reach GitHub says so (friction 28e84c06); landed replies only. The
    // policy is not in the finish projection, so the stop check reads the source port.
    const stopped =
      state.phase === 'landed'
        ? await stoppedMirror({ ...rawCtx, db: finishReadSourceDb(rawCtx) }, input.projectId)
        : null;
    const mirror = stopped ? { mirrorStopped: stopped } : {};
    const paths =
      state.phase === 'landed' && selectedRow.landedPathCount !== undefined
        ? { changedPaths: selectedRow.landedPathCount }
        : {};
    for (const event of events)
      if (event.submission.version === state.version) Object.assign(event, delay, cause, mirror, paths);
    const decision = selectedRow.reviewState ?? reviewState(selectedRow, state);
    const payload = {
      ...review,
      ...(decision ? { reviewState: decision } : {}),
      ...delay,
      ...cause,
      ...mirror,
      ...paths,
      projectId: input.projectId,
      operationId: input.operationId,
      canonicalOperationId: state.operationId,
      authority: sourceAuthority(project),
      submission: noteHeldPolicy(landingStateForReader(queueAwareLandingState(state, queue), input), pin),
      queuePosition: queue?.position ?? null,
      queue: syncRequiredQueue(queue, wouldConflict),
      ...(wouldConflict ? { wouldConflict } : {}),
      ...(orderWait ? { orderWait } : {}),
      ...(reservation ? { reservation } : {}),
      queueAheadSelection: await hostedQueueAheadSelection(ctx, state, undefined, queue?.entriesAhead),
      pendingAttempt,
      events,
      nextVersion,
      isDone: nextVersion > state.version,
      resnapshot,
    };
    return cold
      ? capsuleHistoryContext(ctx, project, selectedRow.capsule!, input.capsuleProtocol, state.id, payload)
      : canonicalPayload(payload);
  } catch (error) {
    // Error-only, constant-size context. Do not log source, row values, caller
    // strings or exception payloads. Platform failures before execution need
    // the platform request trace; this identifies failures inside this query.
    if (!(error instanceof ForgeError) && !(error instanceof ConvexError))
      console.error('FORGE_FINISH_OBSERVE_FAILED', {
        projectId: input.projectId,
        operationId: /^[a-f0-9-]{36}$/i.test(input.operationId) ? input.operationId : null,
        nextVersion: Number.isSafeInteger(input.nextVersion) ? input.nextVersion : null,
        stage,
        phase,
        version,
        eventCount,
      });
    return report(error);
  }
}
