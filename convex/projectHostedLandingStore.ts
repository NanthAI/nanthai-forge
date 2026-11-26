// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { pendingRunnerState } from './cancelledRunUsage';
import { recoverEarlyResolutions } from './projectHostedEarlyResolutionRecovery';
import { wakeLandingCapsule, landingCapsuleGraceMs } from './projectLandingCapsuleWake';
import { withLandingCapsule } from './projectLandingCapsuleStore';
import {
  countMainRace,
  MAIN_RACE_CAP,
  MAIN_RACE_CAP_REASON,
  reachesMainRaceCap,
  unsealedBy,
} from '../src/landing-overtake';
export { landingAttemptRow, loadLandingAttempt } from './projectHostedLandingAttemptRead';
import { checkReplay, type LandingReplay, type ReplayCause } from './projectHostedLandingReplay';
import { recordLandingFeed } from './projectFeedTerminal';
import { landingAttemptRow, loadLandingAttempt, pinsFor } from './projectHostedLandingAttemptRead';
import { closeOrderWait, holdsLandingOrder, landingPriorityState } from './projectHostedLandingOrder';
import { invalidatePipeline } from './projectHostedLandingPipelineInvalidation';
import { cancelUnneededHostedCheck } from './projectHostedCheckCancel';
import { makeFunctionReference } from 'convex/server';
import { semanticPayload } from '../src/semantic-payload';
import { hostedLandingProgressAt, retainedStallOwner } from '../src/hosted-landing-stall';
import { landingAlarmPatch } from './projectHostedLandingStallWake';
import { cancelPendingTask } from './schedulerCancel';
import { releaseAdmissionWaiters } from './projectHostedLandingAdmissionWake';
import { cohortHeld, decidingSince, releaseCohortHolds } from './projectHostedLandingCohortHold';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import {
  canonicalPayload,
  completeHostedOperation,
  hostedOperationSchema,
} from '../src/hosted-source-operation';
import {
  hostedLandingAttemptSchema,
  storedLandingStateSchema,
  hostedLandingProgressSchema,
  landingObservation,
  type HostedLandingState,
  type HostedLandingAttempt,
} from '../src/hosted-landing';
import { hostedOperationRow } from './projectHostedOperations';
import {
  bindsNewRun,
  notifyFinish,
  wakeLandingOrderWaiters,
  wakeNewRunFollower,
} from './projectHostedFinishWake';
import { notifyStackedLandingEnded } from './projectHostedStackNotice';
import { recordLandingSpeed } from './projectLandingSpeed';
import { recordGuardFailureOffMainRed } from './projectGuardMainRed';
import { PASS_HELD, keepsPassStamp, passToLandMinutes } from '../src/landing-speed-alerts';
import { failureDetail, recordFailure } from './projectFailureLog';
import { bindRunnerRun, bindSupersededCheck, discardedRunCount } from './projectHostedLandingRunnerCosts';
import { invariant } from '../src/errors';
import { settleEndedBatch } from './projectHostedLandingBatchSettle';
import { reviewState } from './projectHostedOwnerReview';
export type { LandingChannel } from './projectHostedLandingEvents';
export { landingQueue, ensureLandingQueue, recordLandingObservation } from './projectHostedLandingEvents';
import { landingQueue, recordLandingObservation } from './projectHostedLandingEvents';
import { metricAliasRows, withMetricAliases } from './projectMetricAliasWriter';
import { metricAttemptSource } from './projectMetricSourceRow';
export type LandingIdentity = {
  projectId: Id<'hostedProjects'>;
  submissionId: string;
};
export type LandingRow = Doc<'projectHostedLandingRequests'>;
export const landingRow = async (ctx: QueryCtx | MutationCtx, input: LandingIdentity, capsule = true) => {
  const row = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_submission', q =>
      q.eq('projectId', input.projectId).eq('submissionId', input.submissionId),
    )
    .unique();
  return capsule ? withLandingCapsule(ctx, row) : row;
};
export async function loadLanding(ctx: QueryCtx | MutationCtx, input: LandingIdentity) {
  const row = await landingRow(ctx, input);
  invariant(row, 'NOT_FOUND', 'Hosted landing request not found.');
  return { row, state: landingStateFromRow(row) };
}
/** Adds or removes a recompose-capped entry on its queue's list (queue invariant S5). One queue read,
 * made only at the cap, when a capped entry ends and when its owner sets it back to normal. */
export async function listRaceCapped(ctx: MutationCtx, row: LandingRow, add: boolean) {
  const queue = await landingQueue(ctx, row);
  if (!queue) return;
  const listed = queue.raceCapped ?? [];
  const next = add
    ? [...new Set([...listed, row.submissionId])]
    : listed.filter(id => id !== row.submissionId);
  if (next.length !== listed.length)
    await ctx.db.patch(queue._id, { raceCapped: next.length ? next : undefined });
}
export function landingStateFromRow(row: LandingRow) {
  const state = storedLandingStateSchema.parse(JSON.parse(row.value));
  invariant(
    state.id === row.submissionId &&
      state.projectId === row.projectId &&
      state.attemptId === row.attemptId &&
      state.phase === row.phase &&
      state.actor === row.actor &&
      state.operationId === row.operationId &&
      state.sequence === row.sequence &&
      state.request.channel === row.channel,
    'SOURCE_UNAVAILABLE',
    'Landing request identity differs from its record.',
  );
  return landingPriorityState(row, state);
}
// Why each forked parent is being replaced, for the retire write later in the same invocation.
const forkCauses = new WeakMap<MutationCtx, Map<string, ReplayCause>>();
/** One ordinal allocator for every immutable child, including a finish whose source IO
 * reserved its identity before another writer forked. The current landing head, not a retained
 * reservation's old parent/number, owns the next ordinal. Existing invocation-local pin reads
 * are reused; the disjoint path performs no additional DB work. Every child names why it
 * replaces its parent (ced8e98f): the retire write records that cause, so no retiring path can
 * leave it unrecorded (the fork guard keeps this the only allocator). */
export async function forkLandingAttempt(
  ctx: MutationCtx,
  state: HostedLandingState,
  cause: ReplayCause,
  reserved?: { id: string },
) {
  const parent = await loadLandingAttempt(ctx, {
    projectId: state.projectId as Id<'hostedProjects'>,
    attemptId: state.attemptId,
  });
  let causes = forkCauses.get(ctx);
  if (!causes) forkCauses.set(ctx, (causes = new Map()));
  causes.set(`${state.projectId}:${parent.id}`, cause);
  return { id: reserved?.id ?? crypto.randomUUID(), parentAttemptId: parent.id, number: parent.number + 1 };
}

export async function insertLandingAttempt(ctx: MutationCtx, input: HostedLandingAttempt) {
  const attempt = hostedLandingAttemptSchema.parse(input),
    value = semanticPayload(attempt, true);
  const old = await landingAttemptRow(ctx, {
    projectId: attempt.projectId as Id<'hostedProjects'>,
    attemptId: attempt.id,
  });
  if (old) {
    invariant(old.value === value, 'WORK_OPERATION_CHANGED', 'The original landing attempt is immutable.');
    return;
  }
  if (attempt.parentAttemptId === null) {
    invariant(attempt.number === 0, 'WORK_OPERATION_CHANGED', 'A first landing attempt has ordinal zero.');
  } else {
    const parent = await loadLandingAttempt(ctx, {
      projectId: attempt.projectId as Id<'hostedProjects'>,
      attemptId: attempt.parentAttemptId,
    });
    invariant(
      parent.submissionId === attempt.submissionId &&
        parent.operationId === attempt.operationId &&
        parent.number + 1 === attempt.number &&
        canonicalPayload(parent.actor) === canonicalPayload(attempt.actor),
      'WORK_OPERATION_CHANGED',
      'A child attempt must retain its original submission and actor.',
    );
  }
  const sameNumber = await ctx.db
    .query('projectHostedLandingAttempts')
    .withIndex('by_project_and_submission_and_number', q =>
      q
        .eq('projectId', attempt.projectId as Id<'hostedProjects'>)
        .eq('submissionId', attempt.submissionId)
        .eq('number', attempt.number),
    )
    .unique();
  invariant(!sameNumber, 'WORK_STALE', 'The next landing attempt was already selected.');
  const row = {
    projectId: attempt.projectId as Id<'hostedProjects'>,
    submissionId: attempt.submissionId,
    attemptId: attempt.id,
    number: attempt.number,
    value,
  };
  // Convex advances _creationTime from the same transaction clock. The
  // reader widens the hint range and checks the real creation timestamp.
  const sourceCreatedAt = Date.now();
  await ctx.db.insert(
    'projectHostedLandingAttempts',
    withMetricAliases(
      row,
      metricAliasRows(row.projectId, row.attemptId, {
        stream: 'attempts',
        sourceCreatedAt,
        row: metricAttemptSource({ ...row, _creationTime: sourceCreatedAt }),
      }),
    ),
  );
  pinsFor(ctx).set(`${attempt.projectId}:${attempt.id}`, attempt);
}
export async function writeLanding(
  ctx: MutationCtx,
  row: LandingRow,
  input: HostedLandingState,
  runnable: boolean,
  releaseRun = true,
  consumedAlarm?: Id<'_scheduled_functions'>,
  options?: {
    /** Fix D (Item 687d1eda): only parkLanding passes 'main-red'. Never inferred from the row. */
    hold?: 'main-red' | 'ci-down';
    feedLanes?: readonly { laneId: string; actor?: string }[];
    landedPathCount?: number | null;
    settlement?: { passedAt: string; startedAt: number };
    publishedMainReceiptId?: string;
    replay?: LandingReplay | undefined;
    replacementReplay?: LandingReplay;
    /** A retry after an infrastructure end takes the failed run's counting slot. */
    providerRetryOf?: string;
    /** A cancel's cause, kept on the request row it already writes (a reserved recompose). */
    reservedCause?: ReplayCause;
    /** The new attempt's check progress was observed in this write (a bound proof judged at once). */
    freshProgress?: true;
  },
) {
  const hold = options?.hold;
  invariant(
    input.phase !== 'composing',
    'WORK_OPERATION_CHANGED',
    'Composition goals publish through desired-state admission.',
  );
  const state = landingPriorityState(row, storedLandingStateSchema.parse(input)),
    previous = storedLandingStateSchema.parse(JSON.parse(row.value));
  // Attempt clocks can restart. Client hold time belongs to the original submission.
  const heldMs = previous.timing?.heldMs;
  if (heldMs !== undefined) (state.timing ??= { submittedAt: state.at }).heldMs = heldMs;
  // A new attempt starts with empty check progress: counts and the progress
  // digest belong to the attempt that observed them (9f94c28a). Fresh values
  // written with this transition differ from the previous attempt's and stay.
  if (state.attemptId !== previous.attemptId && !options?.freshProgress) {
    if (state.checkProgress === previous.checkProgress) delete state.checkProgress;
    if (
      state.testFiles &&
      previous.testFiles &&
      canonicalPayload(state.testFiles) === canonicalPayload(previous.testFiles)
    )
      delete state.testFiles;
    if (state.ranInFull === previous.ranInFull) delete state.ranInFull;
  }
  if (state.phase === 'landed' || state.phase === 'terminal-failed') {
    const at = new Date().toISOString();
    state.timing = {
      submittedAt: state.at,
      ...state.timing,
      ...(state.phase === 'landed' ? { committedAt: state.timing?.committedAt ?? at } : {}),
      settledAt: state.timing?.settledAt ?? at,
    };
  }
  invariant(
    state.id === previous.id &&
      state.projectId === previous.projectId &&
      state.actor === previous.actor &&
      state.operationId === previous.operationId &&
      state.at === previous.at &&
      state.sequence === previous.sequence &&
      state.firstAttemptId === previous.firstAttemptId &&
      state.version === previous.version + 1 &&
      canonicalPayload(state.request) === canonicalPayload(previous.request),
    'WORK_OPERATION_CHANGED',
    'Landing progress must retain its original request and identity.',
  );
  const attempt = await loadLandingAttempt(ctx, {
    projectId: row.projectId,
    attemptId: state.attemptId,
  });
  invariant(
    attempt.submissionId === state.id &&
      attempt.operationId === state.operationId &&
      attempt.actor.id === state.actor,
    'WORK_OPERATION_CHANGED',
    'The selected attempt must belong to this original request.',
  );
  // A checking admission run is bound through the row. It is pre-queue (admitting, no queue order)
  // until main moves under it and the keep rule keeps it (`kept`, fa2c1383): from then on it holds
  // order as the retire it replaced would have, and still settles as the admission.
  const admissionRun = row.admission?.status === 'checking' && state.phase === 'checking';
  const admitting = admissionRun && !row.admission!.kept;
  // Fix D (Item 687d1eda): a queued entry parked under the main-red hold waits for one event
  // (releaseMainHolds). It never runs, holds no stall alarm, cohort window place or reservation.
  // Only the explicit `hold` parks: every other write keeps main's behaviour for a held row
  // (publication holds stay `ready` with their own writer, holdMainRed). Any end clears a hold,
  // so a withdrawn or superseded entry can never be released onto main.
  invariant(!hold || state.phase === 'queued', 'WORK_OPERATION_CHANGED', 'Only a queued entry parks.');
  // The CI-down hold (incident e62d834b line 5) parks the same way; its probe wake releases it.
  const parked = hold !== undefined;
  const ended = state.phase === 'landed' || state.phase === 'terminal-failed';
  if (parked) runnable = false;
  // A change held before its Lane check (no-carry hold, Item 1018d0f8) stays held through any queued
  // write: no place in the order and no queue drive. Only its holder's exit or an urgent
  // change releases it (releaseNoCarryWaiter); a park or any other phase ends the hold.
  const held = Boolean(row.noCarryWait) && state.phase === 'queued' && !parked;
  if (held) runnable = false;
  const runId = attempt.check?.runId ?? (admissionRun ? row.admission!.runId : null);
  // The check's kind, stamped once with its start (the write that binds it): ecd6e610, fa2c1383.
  const checkKind =
    runId && runId !== row.runId
      ? state.batchId && !state.batchSolo
        ? ('batch' as const)
        : attempt.recheck
          ? ('scoped' as const)
          : ('full' as const)
      : row.checkKind;
  const carried = bindSupersededCheck(state.counts, row.supersededCheck, runId);
  const runnerAccounting = bindRunnerRun(row.runnerAccounting, row.runId, runId, options?.providerRetryOf);
  if (carried.counts) state.counts = carried.counts;
  // Solo checking/ready tails can own speculative descendants too. Retire the
  // old generation in the mutation that changes its pins or stops its proof.
  const entersReview =
    state.observation.pendingReason === 'waiting-for-review' &&
    previous.observation.pendingReason !== 'waiting-for-review';
  const retiresSolo =
    !previous.batchId &&
    (previous.phase === 'checking' || previous.phase === 'ready') &&
    state.phase !== 'landed' &&
    (entersReview ||
      state.phase === 'terminal-failed' ||
      (row.pipelineRetiredAttemptId !== previous.attemptId &&
        (state.phase === 'queued' || previous.attemptId !== state.attemptId)));
  if (retiresSolo)
    await invalidatePipeline(
      ctx,
      { projectId: row.projectId, batchId: state.id },
      { members: [{ submissionId: state.id }] },
      { loadLanding, loadLandingAttempt, forkLandingAttempt, insertLandingAttempt, writeLanding },
      entersReview || state.phase === 'terminal-failed',
      // A new attempt that still proves the same head under the same receipt
      // (a platform retry) keeps dependents pinned to that pair (ea86f3fb).
      !entersReview &&
        (state.phase === 'checking' ||
          state.phase === 'ready' ||
          (previous.phase === 'checking' &&
            state.phase === 'queued' &&
            row.admission?.full &&
            row.admission.status === 'passed' &&
            !row.admission.reuse)) &&
        attempt.candidate.head
        ? { head: attempt.candidate.head, receiptId: attempt.operations.accept }
        : undefined,
      entersReview,
    );
  const releasesExactReview =
    row.exactReview &&
    (ended || entersReview || parked || state.timing?.composeStartedAt !== previous.timing?.composeStartedAt);
  if (releasesExactReview) {
    const queue = await landingQueue(ctx, row);
    if (queue?.exactReview === state.id) await ctx.db.patch(queue._id, { exactReview: undefined });
  }
  const changedAttempt = previous.attemptId !== state.attemptId;
  // Recompose cap (queue invariant S5, incident 5e3c3a3c): this entry's main-race re-checks, one per
  // Candidate, counted from the attempt already loaded. At the cap the entry is raised to urgent once
  // and says why (the queue status and receipt read it from this same write), and the queue lists it
  // until it ends, so Ready claims look for it only while there is one (raceCapAhead).
  const mainRaces = changedAttempt ? countMainRace(row.mainRaces, attempt) : row.mainRaces;
  const reachedCap = !ended && reachesMainRaceCap(row.mainRaces, mainRaces);
  const raceCapped = reachedCap && (row.priority ?? 'normal') !== 'urgent';
  if (reachedCap || (ended && (row.mainRaces ?? 0) >= MAIN_RACE_CAP))
    await listRaceCapped(ctx, row, reachedCap);
  if (raceCapped)
    Object.assign(state, {
      priority: 'urgent' as const,
      priorityReason: MAIN_RACE_CAP_REASON,
      priorityVersion: (row.priorityVersion ?? 0) + 1,
    });
  if (changedAttempt)
    await retainLandingProgress(ctx, previous, true, attempt.main, {
      ...options?.replacementReplay,
      replacedByAttemptId: state.attemptId,
    });
  // Retain a repaired cohort owner's diagnosis in later observations and the terminal receipt.
  // Its progress token distinguishes historical recovery from a current stall.
  if (!state.observation.stall && retainedStallOwner(previous.observation.stall))
    state.observation.stall = previous.observation.stall;
  if (
    retainedStallOwner(state.observation.stall) &&
    (state.observation.state !== 'pending' ||
      hostedLandingProgressAt(state) !== state.observation.stall.lastProgressAt)
  )
    state.observation.stall = {
      ...state.observation.stall,
      message: `Forge recovered this landing after its cohort finish wake was ${state.observation.stall.owner.finishWake}; the retained owner describes that earlier recovery.`,
    };
  if (
    state.observation.stall &&
    !retainedStallOwner(state.observation.stall) &&
    (state.observation.state !== 'pending' ||
      hostedLandingProgressAt(state) !== state.observation.stall.lastProgressAt)
  )
    delete state.observation.stall;
  // Folded into this row's single write below (c329d191 kept waiter alarms).
  if (parked && row.alarm && row.alarm.taskId !== consumedAlarm)
    await cancelPendingTask(ctx, row.alarm.taskId);
  const alarm = parked
    ? row.alarm
      ? { id: row._id, alarm: null }
      : null
    : await landingAlarmPatch(ctx, state, consumedAlarm, row);
  if (alarm && alarm.id !== row._id) await ctx.db.patch(alarm.id, { alarm: alarm.alarm });
  // The existing release lookup can supply the exact check when a withdrawal
  // ends a live run before its first landing progress update. Freeze once.
  const freezeAfterRelease = ended && !changedAttempt && releaseRun && row.runId !== null;
  // A failed or cancelled entry keeps its hold edges typed, as a landed one does (ced8e98f).
  const endReplay: LandingReplay | undefined =
    state.phase === 'terminal-failed' && previous.phase !== 'terminal-failed' && !options?.replay?.holdEdges
      ? {
          ...options?.replay,
          holdEdges: row.orderWaits?.length || row.orderHandoffs?.length ? 'recorded' : 'none',
        }
      : options?.replay;
  if (!freezeAfterRelease) await retainLandingProgress(ctx, state, false, undefined, endReplay);
  const advice = row.wouldConflict ? JSON.parse(row.wouldConflict) : undefined;
  const speculative = Boolean(advice?.predecessor);
  const retireAdvice =
    speculative &&
    (state.phase !== 'queued' ||
      state.attemptId !== previous.attemptId ||
      state.batchId !== previous.batchId);
  const wouldConflict = retireAdvice ? undefined : row.wouldConflict;
  await recoverEarlyResolutions(ctx, row, previous, state, attempt);
  await recordLandingObservation(ctx, state, undefined, speculative && !retireAdvice ? advice : undefined);
  // An admission run holds the request until it settles; it never joins a cohort meanwhile.
  // A submission still in its own admission (pre-queue) check is not in the queue yet,
  // nor is one held for peers still deciding their Lane proof (10b0a94b).
  const orderLive =
    !held &&
    !admitting &&
    !cohortHeld(row, state, runnable) &&
    holdsLandingOrder(
      { phase: state.phase as LandingRow['phase'], hold: parked ? 'main-red' : row.hold },
      state,
    );
  const deciding = decidingSince(row, state, attempt, orderLive);
  // An admission keeps the entries parked on it only while it still holds its place: once it
  // stalls, fails or waits for review it gives that place up, as any entry does, and its exit
  // wake runs in this write rather than when the admission run ends (review e7137e30 4c).
  const admissionHolds =
    admitting &&
    holdsLandingOrder(
      { phase: state.phase as LandingRow['phase'], hold: parked ? 'main-red' : row.hold },
      state,
    );
  // A landing reservation (10d253c6) lasts until this landing lands or fails; while it lasts its
  // waiters stay parked on it even during the pre-queue check, and its exit wakes them once.
  const reserving =
    !parked &&
    row.reservedUntil !== undefined &&
    state.phase !== 'landed' &&
    state.phase !== 'terminal-failed' &&
    Boolean(state.request.finish) &&
    !state.observation.stall &&
    state.observation.pendingReason !== 'waiting-for-review';
  // Graph-sealed order (c6b81429): a main-race attempt whose pass cannot be carried across a moved
  // main (a scoped re-check, or a proof no dependent change refused) stops independent entries
  // overtaking this one for free. Set once, from the attempt already loaded, in this one write.
  const unsealed =
    row.unsealed === undefined && (attempt.recheckReason !== undefined || attempt.recheck)
      ? unsealedBy({ reason: attempt.recheckReason, scoped: Boolean(attempt.recheck) })
      : null;
  // Pass-to-land alarm (42200ce4): the first time this submission is ready, kept across recompositions.
  // The clock check ends are stamped with. Rides this one write; no read. At landing the row keeps
  // it only when the landed state alone would misstate the wait (a held, re-checked landing).
  // A person's review or a dependency holding a passed landing marks it PASS_HELD for good: that wait is
  // not queue health (663e89b0). A dependency wait before any pass leaves the stamp to its first ready.
  const holdsPass =
    (state.observation.pendingReason === 'waiting-for-review' ||
      state.observation.pendingReason === 'waiting-for-dependency') &&
    (row.passedAt !== undefined || state.phase === 'ready');
  const firstPass = holdsPass
    ? PASS_HELD
    : (row.passedAt ?? (state.phase === 'ready' ? Date.now() : undefined));
  const passedAt = state.phase === 'landed' && !keepsPassStamp(state, firstPass) ? undefined : firstPass;
  const settlement = options?.settlement;
  const passToSettlementSeconds = settlement
    ? (settlement.startedAt - Date.parse(settlement.passedAt)) / 1000
    : NaN;
  const passToLand =
    state.phase === 'landed' && firstPass !== passedAt ? passToLandMinutes(state.timing, firstPass) : null;
  const proofMainReceiptId = runId && !ended ? attempt.main.receiptId : undefined;
  // Queued advisory conflicts keep the existing settlement event on bookkeeping writes.
  const orderWait =
    held ||
    state.phase === 'ready' ||
    (state.phase === 'queued' && attempt.earlyResolutions?.length) ||
    (speculative && !retireAdvice)
      ? row.orderWait
      : undefined;
  const ownerDecision = reviewState(row, state);
  await ctx.db.patch(row._id, {
    ...(options?.landedPathCount === undefined ? {} : { landedPathCount: options.landedPathCount }),
    ...(options?.reservedCause ? { reservedCause: options.reservedCause } : {}),
    ...(ownerDecision !== row.reviewState ? { reviewState: ownerDecision } : {}),
    ...(alarm && alarm.id === row._id ? { alarm: alarm.alarm } : {}),
    ...(unsealed ? { unsealed } : {}),
    ...(mainRaces !== row.mainRaces ? { mainRaces } : {}),
    ...(raceCapped
      ? {
          priority: state.priority,
          priorityReason: state.priorityReason,
          priorityVersion: state.priorityVersion,
        }
      : {}),
    ...(passedAt !== row.passedAt ? { passedAt } : {}),
    ...(row.passToSettlementSeconds === undefined && passToSettlementSeconds >= 0
      ? { passToSettlementSeconds }
      : {}),
    ...(passToLand === null ? {} : { passToLandMinutes: passToLand }),
    ...(proofMainReceiptId === row.proofMainReceiptId ? {} : { proofMainReceiptId }),
    attemptId: state.attemptId,
    // A retire named for the new attempt itself (a bound proof retried in its binding write) stays.
    pipelineRetiredAttemptId:
      previous.attemptId === state.attemptId || row.pipelineRetiredAttemptId === state.attemptId
        ? row.pipelineRetiredAttemptId
        : undefined,
    runId,
    ...(runnerAccounting !== row.runnerAccounting ? { runnerAccounting } : {}),
    supersededCheck: carried.supersededCheck,
    checkWakeVersion: row.runId === runId ? row.checkWakeVersion : undefined,
    ...(checkKind !== row.checkKind ? { checkKind } : {}),
    admitting: admitting ? true : undefined,
    deciding,
    batchSelection:
      !row.earlyReview && !state.batchSolo && (attempt.deferredCheck || row.batchSelection)
        ? canonicalPayload(attempt)
        : undefined,
    batchable: row.earlyReview
      ? undefined
      : Boolean(
          !parked &&
          !state.batchId &&
          !state.batchSolo &&
          !admissionRun &&
          row.admission?.status !== 'failed' &&
          // Pre-queue: an admitted change tries its own Lane run once before any cohort.
          !(row.admission?.full && row.admission.status === 'passed' && !row.admission.reuse) &&
          (attempt.deferredCheck || row.batchSelection) &&
          (state.phase === 'queued' || state.phase === 'checking'),
        ),
    phase: state.phase as LandingRow['phase'],
    runnable,
    ...(parked ? { hold } : ended && row.hold ? { hold: undefined } : {}),
    wouldConflict,
    orderLive: orderLive ? true : undefined,
    ...(releasesExactReview ? { exactReview: undefined } : {}),
    reservedUntil: reserving ? row.reservedUntil : undefined,
    orderWait,
    noCarryWait: held ? true : undefined,
    // A handoff mark lasts only while the entry is a Ready waiter (43b51a5e case 2).
    orderWaitHanded: state.phase === 'ready' ? row.orderWaitHanded : undefined,
    ...(state.phase === 'ready' || held
      ? {}
      : closeOrderWait(
          orderWait ? { ...row, orderHandoffs: undefined } : row,
          Date.now(),
          state.error?.code === 'LANDING_CANCELLED',
          ended ? 'waiter-exit' : undefined,
        )),
    orderWaited: orderLive || reserving || admissionHolds ? row.orderWaited : undefined,
    value: semanticPayload(state),
  });
  if (row.admitting && !admitting) await releaseAdmissionWaiters(ctx, row.projectId);
  if (row.deciding !== undefined && deciding === undefined) await releaseCohortHolds(ctx, row.projectId);
  if (
    row.orderWaited &&
    (releasesExactReview || (!orderLive && !reserving && !admissionHolds) || retiresSolo)
  )
    await wakeLandingOrderWaiters(
      ctx,
      row,
      orderLive && !releasesExactReview,
      false,
      state.phase === 'landed',
      options?.publishedMainReceiptId ?? state.acceptance?.receiptId,
    );
  if (!row.exactReview && bindsNewRun(row, previous, state, runId, orderLive))
    await wakeNewRunFollower(ctx, row);
  const releasedRun =
    releaseRun &&
    row.runId &&
    (row.runId !== runId || state.phase === 'terminal-failed' || state.phase === 'landed')
      ? await cancelUnneededHostedCheck(ctx, { projectId: row.projectId, runId: row.runId })
      : null;
  if (freezeAfterRelease)
    await retainLandingProgress(ctx, state, false, undefined, {
      ...endReplay,
      ...(releasedRun && !options?.replay?.check ? checkReplay(releasedRun) : {}),
    });
  if (state.phase === 'landed' && previous.phase !== 'landed' && state.acceptance) {
    await recordLandingSpeed(
      ctx,
      row.projectId,
      pendingRunnerState(state, row.runnerAccounting?.pending),
      attempt.number + 1,
      firstPass,
      checkKind,
      discardedRunCount(runnerAccounting, runId),
    );
    const project = await ctx.db.get(row.projectId);
    if (project?.needsFix)
      await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedCulprit:accepted'), {
        projectId: row.projectId,
        receiptId: state.acceptance.receiptId,
      });
    // A compensating landing tells the reverted Lanes and Intent (Issue 8dbccdfb); no other landing pays.
    if (state.request.revertOf)
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'mutation'>('projectHostedRevertNotice:accepted'),
        {
          projectId: row.projectId,
          receiptId: state.acceptance.receiptId,
          revertOf: state.request.revertOf,
          actor: state.actor,
          ...(row.agentRun ? { agent: row.agentRun } : {}),
        },
      );
    // A person's acceptance of an agent's submission tells that Lane on the board (fe5bea80); auto-accepts
    // and a person landing their own submission pay nothing.
    if (state.acceptance.acceptedBy?.kind === 'person' && state.request.agent === true)
      await ctx.scheduler.runAfter(
        0,
        makeFunctionReference<'mutation'>('projectHostedAcceptedByNote:accepted'),
        {
          projectId: row.projectId,
          receiptId: state.acceptance.receiptId,
          by: JSON.stringify(state.acceptance.acceptedBy),
        },
      );
  }
  if (ended && !['landed', 'terminal-failed'].includes(previous.phase)) {
    await recordLandingFeed(ctx, state, runId ?? row.runId, options?.feedLanes);
    await wakeLandingCapsule(ctx, {
      projectId: row.projectId,
      submissionId: state.id,
      dueAt: Date.parse(state.timing!.settledAt!) + landingCapsuleGraceMs,
    });
  }
  await notifyFinish(ctx, state);
  // Lanes stacked on a Lane this landing carried are told once (Issue dc62b120): failed and cancelled alike.
  if (state.phase === 'terminal-failed' && previous.phase !== 'terminal-failed')
    await notifyStackedLandingEnded(ctx, {
      projectId: row.projectId,
      actor: state.actor,
      composeOperationId:
        state.request.finish?.composeOperationId ?? state.request.finish?.reviewedSource?.operationId,
      operationId: state.operationId,
      ...(state.error?.code ? { code: state.error.code } : {}),
    });
  // A batch settles once no member is live (ab5c0017). Last, after this write's own effects:
  // settling may release this member through writeBatch.
  if (ended && previous.phase !== 'landed' && previous.phase !== 'terminal-failed')
    await settleEndedBatch(ctx, state);
  return state;
}
/** Internal queue bookkeeping can retain a rejected outcome after actor revocation.
 * This never reads/returns source or grants the revoked actor publication authority. */
export async function settleLandingOperation(ctx: MutationCtx, state: HostedLandingState) {
  const row = await hostedOperationRow(
    ctx,
    state.projectId as Id<'hostedProjects'>,
    state.actor,
    state.operationId,
  );
  invariant(row, 'SOURCE_UNAVAILABLE', 'The original landing operation is unavailable.');
  const receipt = {
    attemptId: state.attemptId,
    at: new Date().toISOString(),
    outcome:
      state.phase === 'terminal-failed'
        ? { status: 'failed' as const, error: state.error! }
        : {
            status: 'completed' as const,
            result: {
              submissionId: state.id,
              attemptId: state.attemptId,
              phase: state.phase,
              ...(state.semanticConflicts ? { semanticConflicts: state.semanticConflicts } : {}),
              ...(state.batchDiagnostic ? { batchDiagnostic: state.batchDiagnostic } : {}),
              observation: state.observation,
              ...(state.acceptance ? { acceptance: state.acceptance } : {}),
            },
          },
  };
  const operation = completeHostedOperation(hostedOperationSchema.parse(JSON.parse(row.value)), receipt);
  if (canonicalPayload(operation) === row.value) return;
  await ctx.db.patch(row._id, { value: canonicalPayload(operation) });
  if (receipt.outcome.status === 'failed') await failedLanding(ctx, state);
}
/** One failure-log row for a landing that ended failed with an error (Item 2c420916). */
export async function failedLanding(ctx: MutationCtx, state: HostedLandingState) {
  if (!state.error) return;
  // writeLanding already loads these immutable pins. Desired failures before admission have only the first id.
  const retryCount =
    pinsFor(ctx).get(`${state.projectId}:${state.attemptId}`)?.number ??
    (state.attemptId === state.firstAttemptId ? 0 : undefined);
  const recorded = await recordFailure(ctx, {
    projectId: state.projectId as Id<'hostedProjects'>,
    operationId: state.operationId,
    kind: 'landing',
    error: state.error,
    startedAt: state.timing?.submittedAt ?? state.at,
    detail: failureDetail({ testFiles: state.testFiles, error: state.error }),
    retryCount,
  });
  // Once per failed check (the failure row dedupes): it teaches the preflight guard set (13ea93bf).
  if (recorded && state.error.code === 'CHECK_FAILED') await recordGuardFailureOffMainRed(ctx, state);
}

/** Mutable evidence is separate from immutable attempt/source/operation pins. A
 * replaced attempt is frozen before the request starts its next source phase. */
export async function retainLandingProgress(
  ctx: MutationCtx,
  state: HostedLandingState,
  replaced: boolean | { code: string; message: string } = false,
  nextMain?: HostedLandingAttempt['main'],
  replay?: LandingReplay,
) {
  const row = await landingAttemptRow(ctx, {
    projectId: state.projectId as Id<'hostedProjects'>,
    attemptId: state.attemptId,
  });
  invariant(row, 'SOURCE_UNAVAILABLE', 'The original attempt is unavailable.');
  const observedBase = nextMain ?? replay?.actualBase;
  const observedCheck = replay?.check;
  const main =
    observedBase || observedCheck?.predictedBase
      ? (
          pinsFor(ctx).get(`${row.projectId}:${row.attemptId}`) ??
          hostedLandingAttemptSchema.parse(JSON.parse(row.value))
        ).main
      : undefined;
  const ownBase = (base: HostedLandingAttempt['main']) =>
    base.head === main?.head && base.receiptId === main.receiptId;
  const mainChanged = nextMain && !ownBase(nextMain);
  const check = observedCheck ? { ...observedCheck } : undefined;
  if (check?.predictedBase && ownBase(check.predictedBase)) delete check.predictedBase;
  const replacement =
    replaced === true
      ? mainChanged
        ? {
            code: 'CHANNEL_CHANGED',
            message: 'Main changed; a named child recomposes the original selection.',
          }
        : {
            code: 'ATTEMPT_REPLACED',
            message: 'A named child or check binding replaced this attempt.',
          }
      : replaced || null;
  const censor =
    replacement?.code ??
    (state.error?.code === 'LANDING_CANCELLED' || state.observation.state === 'superseded'
      ? state.error?.code
      : state.phase === 'terminal-failed'
        ? (replay?.check ?? row.replay?.check)?.stop
        : undefined);
  const evidence: LandingReplay = {
    ...row.replay,
    ...replay,
    ...(check ? { check } : {}),
    ...(row.replay?.check && replay?.check && row.replay.check.runId !== replay.check.runId
      ? { earlierChecks: [...(row.replay.earlierChecks ?? []), row.replay.check] }
      : {}),
    ...(state.attemptId === state.firstAttemptId &&
    state.retryReason === 'flake' &&
    state.supersedes &&
    !row.replay?.recheckCause &&
    !replay?.recheckCause
      ? { recheckCause: { kind: 'flake-retry', link: state.supersedes } }
      : {}),
    // Every attempt write names its causes (a censor, a replacement, a recheck) or has none, so an
    // absent one reads `none`; rows without the stamp predate it and read `unrecorded`.
    causes: 'recorded',
    ...(nextMain ? { actualBase: nextMain } : {}),
    ...(censor ? { censor } : {}),
    // Every replacement or censor records its cause in this same write: the writer's, else its
    // fork's. A cancelled check ended the entry; anything else unnamed stays countable as `unknown`.
    ...(censor && !replay?.replacementCause && !row.replay?.replacementCause
      ? {
          replacementCause:
            (replacement && forkCauses.get(ctx)?.get(`${state.projectId}:${state.attemptId}`)) ||
            (!replacement && censor === 'CHECK_CANCELLED'
              ? { kind: 'cancelled' as const, link: 'check-cancelled' }
              : { kind: 'unknown' as const, link: `retain:${censor}` }),
        }
      : {}),
  };
  if (observedBase && ownBase(observedBase)) delete evidence.actualBase;
  if (row.progress) {
    const retained = hostedLandingProgressSchema.parse(JSON.parse(row.progress));
    if (retained.settled) {
      // Keep settled source/outcome evidence frozen; pair diagnosis can arrive
      // when another member finishes its existing fallback later.
      if (
        state.batchDiagnostic &&
        canonicalPayload(retained.batchDiagnostic ?? null) !== canonicalPayload(state.batchDiagnostic)
      )
        await ctx.db.patch(row._id, {
          progress: semanticPayload({
            ...retained,
            batchDiagnostic: state.batchDiagnostic,
          }),
        });
      return;
    }
  }
  await ctx.db.patch(row._id, {
    ...(row.sourceCreatedAt === undefined ? { sourceCreatedAt: row._creationTime, value: row.value } : {}),
    ...(Object.keys(evidence).length || state.phase === 'landed' || state.phase === 'terminal-failed'
      ? { replay: evidence }
      : {}),
    progress: semanticPayload({
      ...(state.semanticConflicts ? { semanticConflicts: state.semanticConflicts } : {}),
      ...(state.batchDiagnostic ? { batchDiagnostic: state.batchDiagnostic } : {}),
      observation: replacement ? landingObservation('failed', replacement.code) : state.observation,
      phase: replaced ? 'terminal-failed' : state.phase,
      error: replacement ?? state.error,
      acceptance: state.acceptance ?? null,
      settled: Boolean(replacement) || state.phase === 'landed' || state.phase === 'terminal-failed',
      version: state.version,
      ...(state.timing || replaced
        ? {
            timing: {
              submittedAt: state.at,
              ...state.timing,
              ...(replaced ? { settledAt: new Date().toISOString() } : {}),
            },
          }
        : {}),
    }),
  });
}
export function landingAttemptProgress(row: Doc<'projectHostedLandingAttempts'>, state: HostedLandingState) {
  if (row.progress) return hostedLandingProgressSchema.parse(JSON.parse(row.progress));
  // Old rows have no reconstructible evidence. Never borrow a newer attempt's result.
  return row.attemptId === state.attemptId
    ? {
        ...(state.semanticConflicts ? { semanticConflicts: state.semanticConflicts } : {}),
        ...(state.batchDiagnostic ? { batchDiagnostic: state.batchDiagnostic } : {}),
        observation: state.observation,
        phase: state.phase,
        error: state.error,
        acceptance: state.acceptance ?? null,
        settled: state.phase === 'landed' || state.phase === 'terminal-failed',
        version: state.version,
        ...(state.timing ? { timing: state.timing } : {}),
      }
    : null;
}
