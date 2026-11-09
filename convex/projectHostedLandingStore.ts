// SPDX-License-Identifier: Apache-2.0
import { unsealedBy } from '../src/landing-overtake';
export { landingAttemptRow, loadLandingAttempt } from './projectHostedLandingAttemptRead';
import { landingAttemptRow, loadLandingAttempt, pinsFor } from './projectHostedLandingAttemptRead';
import { holdsLandingOrder, landingPriorityState } from './projectHostedLandingOrder';
import { invalidatePipeline } from './projectHostedLandingPipelineInvalidation';
import { cancelUnneededHostedCheck } from './projectHostedCheckCancel';
import { makeFunctionReference } from 'convex/server';
import { semanticPayload } from '../src/semantic-payload';
import { hostedLandingProgressAt } from '../src/hosted-landing-stall';
import { landingAlarmPatch } from './projectHostedLandingStallWake';
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
  hostedLandingStateSchema,
  hostedLandingProgressSchema,
  landingObservation,
  type HostedLandingState,
  type HostedLandingAttempt,
} from '../src/hosted-landing';
import { hostedOperationRow } from './projectHostedOperations';
import { notifyFinish, wakeLandingOrderWaiters } from './projectHostedFinishWake';
import { notifyStackedLandingEnded } from './projectHostedStackNotice';
import { recordLandingSpeed } from './projectLandingSpeed';
import { invariant } from '../src/errors';
export type { LandingChannel } from './projectHostedLandingEvents';
export { landingQueue, ensureLandingQueue, recordLandingObservation } from './projectHostedLandingEvents';
import { recordLandingObservation } from './projectHostedLandingEvents';
export type LandingIdentity = {
  projectId: Id<'hostedProjects'>;
  submissionId: string;
};
export type LandingRow = Doc<'projectHostedLandingRequests'>;
export const landingRow = (ctx: QueryCtx | MutationCtx, input: LandingIdentity) =>
  ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_submission', q =>
      q.eq('projectId', input.projectId).eq('submissionId', input.submissionId),
    )
    .unique();
export async function loadLanding(ctx: QueryCtx | MutationCtx, input: LandingIdentity) {
  const row = await landingRow(ctx, input);
  invariant(row, 'NOT_FOUND', 'Hosted landing request not found.');
  return { row, state: landingStateFromRow(row) };
}
export function landingStateFromRow(row: LandingRow) {
  const state = hostedLandingStateSchema.parse(JSON.parse(row.value));
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
  await ctx.db.insert('projectHostedLandingAttempts', {
    projectId: attempt.projectId as Id<'hostedProjects'>,
    submissionId: attempt.submissionId,
    attemptId: attempt.id,
    number: attempt.number,
    value,
  });
  pinsFor(ctx).set(`${attempt.projectId}:${attempt.id}`, attempt);
}
export async function writeLanding(
  ctx: MutationCtx,
  row: LandingRow,
  input: HostedLandingState,
  runnable: boolean,
  releaseRun = true,
) {
  invariant(
    input.phase !== 'composing',
    'WORK_OPERATION_CHANGED',
    'Composition goals publish through desired-state admission.',
  );
  const state = landingPriorityState(row, hostedLandingStateSchema.parse(input)),
    previous = hostedLandingStateSchema.parse(JSON.parse(row.value));
  // A new attempt starts with empty check progress: counts and the progress
  // digest belong to the attempt that observed them (9f94c28a). Fresh values
  // written with this transition differ from the previous attempt's and stay.
  if (state.attemptId !== previous.attemptId) {
    if (state.checkProgress === previous.checkProgress) delete state.checkProgress;
    if (state.testFiles && canonicalPayload(state.testFiles) === canonicalPayload(previous.testFiles))
      delete state.testFiles;
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
  // Solo checking/ready tails can own speculative descendants too. Retire the
  // old generation in the mutation that changes its pins or stops its proof.
  const retiresSolo =
    !previous.batchId &&
    (previous.phase === 'checking' || previous.phase === 'ready') &&
    state.phase !== 'landed' &&
    (state.phase === 'terminal-failed' ||
      (row.pipelineRetiredAttemptId !== previous.attemptId &&
        (state.phase === 'queued' || previous.attemptId !== state.attemptId)));
  if (retiresSolo)
    await invalidatePipeline(
      ctx,
      { projectId: row.projectId, batchId: state.id },
      { members: [{ submissionId: state.id }] },
      { loadLanding, loadLandingAttempt, insertLandingAttempt, writeLanding },
      state.phase === 'terminal-failed',
      // A new attempt that still proves the same head under the same receipt
      // (a platform retry) keeps dependents pinned to that pair (ea86f3fb).
      (state.phase === 'checking' || state.phase === 'ready') && attempt.candidate.head
        ? { head: attempt.candidate.head, receiptId: attempt.operations.accept }
        : undefined,
    );
  if (previous.attemptId !== state.attemptId) await retainLandingProgress(ctx, previous, true, attempt.main);
  if (
    state.observation.stall &&
    (state.observation.state !== 'pending' ||
      hostedLandingProgressAt(state) !== state.observation.stall.lastProgressAt)
  )
    delete state.observation.stall;
  // Folded into this row's single write below (c329d191 kept waiter alarms).
  const alarm = await landingAlarmPatch(ctx, state);
  if (alarm && alarm.id !== row._id) await ctx.db.patch(alarm.id, { alarm: alarm.alarm });
  await retainLandingProgress(ctx, state);
  const advice = row.wouldConflict ? JSON.parse(row.wouldConflict) : undefined;
  const speculative = Boolean(advice?.predecessor);
  const retireAdvice =
    speculative &&
    (state.phase !== 'queued' ||
      state.attemptId !== previous.attemptId ||
      state.batchId !== previous.batchId);
  const wouldConflict = retireAdvice ? undefined : row.wouldConflict;
  await recordLandingObservation(ctx, state, undefined, speculative && !retireAdvice ? advice : undefined);
  // An admission run holds the request until it settles; it never joins a cohort meanwhile.
  const admitting = row.admission?.status === 'checking' && state.phase === 'checking';
  const runId = attempt.check?.runId ?? (admitting ? row.admission!.runId : null);
  // A submission still in its own admission (pre-queue) check is not in the queue yet,
  // nor is one held for peers still deciding their Lane proof (10b0a94b).
  const orderLive =
    !admitting &&
    !cohortHeld(row, state, runnable) &&
    holdsLandingOrder({ phase: state.phase as LandingRow['phase'], hold: row.hold }, state);
  const deciding = decidingSince(row, state, attempt, orderLive);
  // Graph-sealed order (c6b81429): a main-race attempt whose pass cannot be carried across a moved
  // main (a scoped re-check, or a proof no dependent change refused) stops independent entries
  // overtaking this one for free. Set once, from the attempt already loaded, in this one write.
  const unsealed =
    row.unsealed === undefined && (attempt.recheckReason !== undefined || attempt.recheck)
      ? unsealedBy({ reason: attempt.recheckReason, scoped: Boolean(attempt.recheck) })
      : null;
  await ctx.db.patch(row._id, {
    ...(alarm && alarm.id === row._id ? { alarm: alarm.alarm } : {}),
    ...(unsealed ? { unsealed } : {}),
    attemptId: state.attemptId,
    pipelineRetiredAttemptId:
      previous.attemptId === state.attemptId ? row.pipelineRetiredAttemptId : undefined,
    runId,
    checkWakeVersion: row.runId === runId ? row.checkWakeVersion : undefined,
    admitting: admitting ? true : undefined,
    deciding,
    batchSelection:
      !state.batchSolo && (attempt.deferredCheck || row.batchSelection)
        ? canonicalPayload(attempt)
        : undefined,
    batchable: Boolean(
      !state.batchId &&
      !state.batchSolo &&
      !admitting &&
      row.admission?.status !== 'failed' &&
      // Pre-queue: an admitted change tries its own Lane run once before any cohort.
      !(row.admission?.full && row.admission.status === 'passed' && !row.admission.reuse) &&
      (attempt.deferredCheck || row.batchSelection) &&
      (state.phase === 'queued' || state.phase === 'checking'),
    ),
    phase: state.phase as LandingRow['phase'],
    runnable,
    wouldConflict,
    orderLive: orderLive ? true : undefined,
    // Queued advisory conflicts also depend on an existing settlement event.
    // A same-attempt diagnostic write must not silently discard that owner.
    orderWait: state.phase === 'ready' || (speculative && !retireAdvice) ? row.orderWait : undefined,
    orderWaited: orderLive ? row.orderWaited : undefined,
    value: semanticPayload(state),
  });
  if (row.admitting && !admitting) await releaseAdmissionWaiters(ctx, row.projectId);
  if (row.deciding !== undefined && deciding === undefined) await releaseCohortHolds(ctx, row.projectId);
  if (row.orderWaited && (!orderLive || retiresSolo)) await wakeLandingOrderWaiters(ctx, row, orderLive);
  if (
    releaseRun &&
    row.runId &&
    (row.runId !== (attempt.check?.runId ?? (admitting ? row.admission!.runId : null)) ||
      state.phase === 'terminal-failed' ||
      state.phase === 'landed')
  )
    await cancelUnneededHostedCheck(ctx, {
      projectId: row.projectId,
      runId: row.runId,
    });
  if (state.phase === 'landed' && previous.phase !== 'landed' && state.acceptance) {
    await recordLandingSpeed(ctx, row.projectId, state);
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
  if (canonicalPayload(operation) !== row.value)
    await ctx.db.patch(row._id, { value: canonicalPayload(operation) });
}

/** Mutable evidence is separate from immutable attempt/source/operation pins. A
 * replaced attempt is frozen before the request starts its next source phase. */
export async function retainLandingProgress(
  ctx: MutationCtx,
  state: HostedLandingState,
  replaced: boolean | { code: string; message: string } = false,
  nextMain?: HostedLandingAttempt['main'],
) {
  const row = await landingAttemptRow(ctx, {
    projectId: state.projectId as Id<'hostedProjects'>,
    attemptId: state.attemptId,
  });
  invariant(row, 'SOURCE_UNAVAILABLE', 'The original attempt is unavailable.');
  const mainChanged =
    nextMain &&
    canonicalPayload(hostedLandingAttemptSchema.parse(JSON.parse(row.value)).main) !==
      canonicalPayload(nextMain);
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
