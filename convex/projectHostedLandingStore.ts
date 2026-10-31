import { landingPriorityState } from './projectHostedLandingOrder';
import { cancelUnneededHostedCheck } from './projectHostedCheckCancel';
import { makeFunctionReference } from 'convex/server';
import { semanticPayload } from '../src/semantic-payload';
import { hostedLandingProgressAt } from '../src/hosted-landing-stall';
import { scheduleLandingAlarm } from './projectHostedLandingStallWake';
import { releaseAdmissionWaiters } from './projectHostedLandingAdmissionWake';
// SPDX-License-Identifier: Apache-2.0
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
import { notifyFinish } from './projectHostedFinishWake';
import { invariant } from '../src/errors';
export type { LandingChannel } from './projectHostedLandingEvents';
export { landingQueue, ensureLandingQueue, recordLandingObservation } from './projectHostedLandingEvents';
import { recordLandingObservation } from './projectHostedLandingEvents';
export type LandingIdentity = { projectId: Id<'hostedProjects'>; submissionId: string };
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
  return { row, state: landingPriorityState(row, state) };
}
export const landingAttemptRow = (
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; attemptId: string },
) =>
  ctx.db
    .query('projectHostedLandingAttempts')
    .withIndex('by_project_and_attempt', q =>
      q.eq('projectId', input.projectId).eq('attemptId', input.attemptId),
    )
    .unique();
export async function loadLandingAttempt(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; attemptId: string },
) {
  const row = await landingAttemptRow(ctx, input);
  invariant(row, 'SOURCE_UNAVAILABLE', 'The original landing attempt is unavailable.');
  const attempt = hostedLandingAttemptSchema.parse(JSON.parse(row.value));
  invariant(
    attempt.projectId === row.projectId &&
      attempt.id === row.attemptId &&
      attempt.submissionId === row.submissionId &&
      attempt.number === row.number,
    'SOURCE_UNAVAILABLE',
    'Landing attempt identity differs from its record.',
  );
  return attempt;
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
}
export async function writeLanding(
  ctx: MutationCtx,
  row: LandingRow,
  input: HostedLandingState,
  runnable: boolean,
) {
  invariant(
    input.phase !== 'composing',
    'WORK_OPERATION_CHANGED',
    'Composition goals publish through desired-state admission.',
  );
  const state = landingPriorityState(row, hostedLandingStateSchema.parse(input)),
    previous = hostedLandingStateSchema.parse(JSON.parse(row.value));
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
  if (previous.attemptId !== state.attemptId) await retainLandingProgress(ctx, previous, true, attempt.main);
  if (
    state.observation.stall &&
    (state.observation.state !== 'pending' ||
      hostedLandingProgressAt(state) !== state.observation.stall.lastProgressAt)
  )
    delete state.observation.stall;
  await scheduleLandingAlarm(ctx, state);
  await retainLandingProgress(ctx, state);
  await recordLandingObservation(ctx, state);
  // An admission run holds the request until it settles; it never joins a cohort meanwhile.
  const admitting = row.admission?.status === 'checking' && state.phase === 'checking';
  await ctx.db.patch(row._id, {
    attemptId: state.attemptId,
    runId: attempt.check?.runId ?? (admitting ? row.admission!.runId : null),
    admitting: admitting ? true : undefined,
    batchSelection:
      !state.batchSolo && (attempt.deferredCheck || row.batchSelection)
        ? canonicalPayload(attempt)
        : undefined,
    batchable: Boolean(
      !state.batchId &&
      !state.batchSolo &&
      !admitting &&
      row.admission?.status !== 'failed' &&
      (attempt.deferredCheck || row.batchSelection) &&
      (state.phase === 'queued' || state.phase === 'checking'),
    ),
    phase: state.phase as LandingRow['phase'],
    runnable,
    value: semanticPayload(state),
  });
  if (row.admitting && !admitting) await releaseAdmissionWaiters(ctx, row.projectId);
  if (
    row.runId &&
    (row.runId !== (attempt.check?.runId ?? (admitting ? row.admission!.runId : null)) ||
      state.phase === 'terminal-failed' ||
      state.phase === 'landed')
  )
    await cancelUnneededHostedCheck(ctx, { projectId: row.projectId, runId: row.runId });
  if (state.phase === 'landed' && previous.phase !== 'landed' && state.acceptance) {
    const project = await ctx.db.get(row.projectId);
    if (project?.needsFix)
      await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedCulprit:accepted'), {
        projectId: row.projectId,
        receiptId: state.acceptance.receiptId,
      });
  }
  await notifyFinish(ctx, state);
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
        : { code: 'ATTEMPT_REPLACED', message: 'A named child or check binding replaced this attempt.' }
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
          progress: semanticPayload({ ...retained, batchDiagnostic: state.batchDiagnostic }),
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
