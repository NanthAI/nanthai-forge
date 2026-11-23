// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { query } from './cliServer';
import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { report } from './errors';
import { sanitizeFailureMessage } from './projectFailureLog';
import { loadLandingAttempt } from './projectHostedLandingAttemptRead';
import { landingSelectionRead } from './projectHostedLandingSelectionRead';
import { desiredLanding } from './projectHostedLandingDesiredWake';
import { landingAttemptProgress, landingRow, landingStateFromRow } from './projectHostedLandingStore';
import { finishRow } from './projectHostedFinishWake';
import { landingOrderEvidence } from './projectHostedLandingOrder';
import { reviewState } from './projectHostedOwnerReview';
import { preparingSourceStep } from './projectHostedPreparingSource';
import { hostedFinishSchema } from '../src/hosted-finish';
import {
  hostedLandingAttemptSchema,
  hostedLandingStateSchema,
  type HostedLandingAttempt,
  type HostedLandingState,
} from '../src/hosted-landing';
import { sourceStepFailureField } from '../src/hosted-source-retry';
import { invariant } from '../src/errors';
import { phaseDuration } from '../src/land-phases';
import {
  inheritRecheckCause,
  replayHoldEdges,
  replayRead,
  type LandingReplay,
  type ReplayCause,
} from './projectHostedLandingReplay';
import { capsuleHistoryContext } from './projectLandingCapsuleContext';
import type { LandingCapsule } from '../src/landing-capsule';

const PAGE = 8;
type Timing = NonNullable<HostedLandingState['timing']>;
type Phase = HostedLandingState['phase'];
type Period = {
  phase: 'composing' | 'queued' | 'checking' | 'settling';
  startedAt: string;
  endedAt?: string;
  elapsedMs: number;
};

function phasePeriod(
  phase: Period['phase'],
  startedAt?: string,
  endedAt?: string,
  observedAt?: string,
): Period | null {
  const elapsedMs = phaseDuration(startedAt, endedAt ?? observedAt);
  return startedAt && elapsedMs !== 'unknown'
    ? { phase, startedAt, ...(endedAt ? { endedAt } : {}), elapsedMs }
    : null;
}

function installedTiming(
  timing: Timing | undefined,
  parent: Timing | undefined,
  input: {
    queuedAt?: string | undefined;
    phase: Phase | null;
    hasCheck: boolean;
    observedAt?: string | undefined;
  },
) {
  const { phase, observedAt, hasCheck } = input;
  if (!timing) return { phase, periods: [] };
  // A park, proof binding or check retry can copy the previous attempt's entire clock.
  const own = (key: Extract<keyof Timing, `${string}At`>) =>
    timing[key] === parent?.[key] ? undefined : timing[key];
  const composeStartedAt = own('composeStartedAt');
  const composedAt = own('composedAt');
  const checkReservedAt = hasCheck ? own('checkReservedAt') : undefined;
  // During shared recomposition a member remains queued, with a fresh open compose stamp.
  const shownPhase =
    observedAt && phase === 'queued' && composeStartedAt && !composedAt && !checkReservedAt
      ? 'composing'
      : phase;
  const queuedAt =
    composedAt && (!input.queuedAt || phaseDuration(input.queuedAt, composedAt) !== 'unknown')
      ? composedAt
      : input.queuedAt;
  const queueEnd = [own('selectedAt'), checkReservedAt]
    .filter((at): at is string => phaseDuration(queuedAt, at) !== 'unknown')
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return {
    phase: shownPhase,
    periods: [
      phasePeriod(
        'composing',
        composeStartedAt,
        composedAt,
        shownPhase === 'composing' ? observedAt : undefined,
      ),
      composedAt || !composeStartedAt
        ? phasePeriod(
            'queued',
            queuedAt,
            queueEnd,
            shownPhase === 'queued' && !checkReservedAt ? observedAt : undefined,
          )
        : null,
      phasePeriod(
        'checking',
        checkReservedAt,
        own('ciEndedAt'),
        shownPhase === 'checking' ? observedAt : undefined,
      ),
      phasePeriod(
        'settling',
        own('settlementStartedAt'),
        own('committedAt') ?? own('settledAt'),
        shownPhase === 'ready' ? observedAt : undefined,
      ),
    ].filter(entry => entry !== null),
  };
}

const cause = (error: HostedLandingState['error'] | undefined) =>
  error ? { code: error.code.slice(0, 100), message: sanitizeFailureMessage(error.message) } : undefined;

function installedAttempt(
  row: Doc<'projectHostedLandingAttempts'>,
  attempt: HostedLandingAttempt,
  progress: ReturnType<typeof landingAttemptProgress> | undefined,
  parent: Timing | undefined,
  current: boolean,
  runId: string | undefined,
  observedAt?: string,
  parentReplay?: LandingReplay,
) {
  const failure = cause(progress?.error);
  return {
    id: attempt.id,
    number: attempt.number,
    at: attempt.at,
    current,
    main: attempt.main,
    replay: replayRead(attempt, row.replay, progress?.phase, parentReplay),
    candidateId: attempt.candidate.id,
    ...(runId ? { runId } : {}),
    ...(attempt.checkCause ? { checkCause: attempt.checkCause } : {}),
    ...installedTiming(attempt.parentAttemptId && !parent ? undefined : progress?.timing, parent, {
      phase: progress?.phase ?? null,
      queuedAt: attempt.parentAttemptId ? parent?.settledAt : attempt.at,
      hasCheck: !!runId,
      observedAt,
    }),
    ...(failure ? { cause: failure } : {}),
  };
}

/** The authenticated capsule supplies the same attempt and progress rows after relocation. */
export function archivedAttemptHistory(capsule: LandingCapsule, context: Record<string, unknown>) {
  const {
    admissionRunId,
    beforeAttempt,
    attempts: live,
    nextBeforeAttempt,
    historyPartial,
    stampedHoldEdges,
    ...reply
  } = context;
  const state = capsule.anchor;
  const page = (capsule.tables.projectHostedLandingAttempts ?? [])
    .map(text => JSON.parse(text) as Doc<'projectHostedLandingAttempts'>)
    .filter(row => beforeAttempt === undefined || row.number < (beforeAttempt as number))
    .sort((a, b) => b.number - a.number)
    .slice(0, PAGE + 1);
  const progress = new Map(page.map(row => [row.attemptId, landingAttemptProgress(row, state)]));
  const replays = new Map(page.map(row => [row.attemptId, row.replay]));
  const attempts = page.map(row => {
    const attempt = hostedLandingAttemptSchema.parse(JSON.parse(row.value));
    const parent = attempt.parentAttemptId ? progress.get(attempt.parentAttemptId)?.timing : undefined;
    const runId =
      attempt.check?.runId ??
      (attempt.id === state.firstAttemptId ? (admissionRunId as string | undefined) : undefined);
    return installedAttempt(
      row,
      attempt,
      progress.get(attempt.id),
      parent,
      attempt.id === reply.currentAttemptId,
      runId,
      undefined,
      attempt.parentAttemptId ? replays.get(attempt.parentAttemptId) : undefined,
    );
  });
  const liveAttempts = live as Array<{ id: string; number: number; reserved?: true }>;
  // After relocation the stamp travels in the capsule, not in the live rows (ced8e98f): the live
  // read sends the stamped answer along for this case only.
  const stamp = page.find(row => row.replay?.holdEdges)?.replay?.holdEdges;
  if (stamp && stampedHoldEdges) reply.holdEdges = (stampedHoldEdges as Record<string, unknown>)[stamp];
  const merged = new Map(attempts.map(entry => [entry.number, entry as (typeof liveAttempts)[number]]));
  for (const entry of liveAttempts) if (!entry.reserved) merged.set(entry.number, entry);
  // A live child whose parent was archived reads its cause from the archived parent.
  for (const entry of merged.values())
    inheritRecheckCause(entry as never, merged.get(entry.number - 1) as never);
  const selected = [...merged.values()].sort((a, b) => b.number - a.number).slice(0, PAGE);
  const next = merged.size > PAGE || nextBeforeAttempt != null ? selected.at(-1)!.number : null;
  const gap = selected.some((entry, index) => index > 0 && selected[index - 1]!.number !== entry.number + 1);
  const missingFirst = next === null && beforeAttempt !== 0 && selected.at(-1)?.id !== state.firstAttemptId;
  return {
    ...reply,
    attempts: [...liveAttempts.filter(entry => entry.reserved), ...selected],
    nextBeforeAttempt: next,
    ...(gap || missingFirst || (!page.length && historyPartial) ? { historyPartial: true } : {}),
  };
}

async function reservedAttempt(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  state: HostedLandingState,
  attempt: { id: string; number: number; at: string; main: HostedLandingState['request']['expectedMain'] },
  composeOperationId: string,
  observedAt: string,
  reservedCause?: ReplayCause,
  parentReplay?: LandingReplay,
) {
  const step = await preparingSourceStep(ctx, projectId, state.actor, composeOperationId);
  const failure = step ? sourceStepFailureField(step) : undefined;
  const failed = state.phase === 'terminal-failed';
  const stopped = state.error?.code;
  const censor = stopped === 'LANDING_CANCELLED' || stopped === 'LANDING_SUPERSEDED' ? stopped : undefined;
  const composition = phasePeriod(
    'composing',
    attempt.at,
    failed ? state.timing?.settledAt : undefined,
    failed ? undefined : observedAt,
  );
  return {
    ...attempt,
    current: true,
    reserved: true,
    phase: failed ? 'terminal-failed' : 'composing',
    replay: replayRead(
      attempt,
      // A reservation is written by the current writers, so it carries the causes stamp.
      {
        causes: 'recorded',
        ...(censor ? { censor, ...(reservedCause ? { replacementCause: reservedCause } : {}) } : {}),
      },
      state.phase,
      parentReplay,
    ),
    composeOperationId,
    periods: composition ? [composition] : [],
    ...(failed ? { cause: cause(state.error) } : {}),
    ...(step ? { sourceStep: step.step } : {}),
    ...(failure ? { sourceFailure: { ...failure, elapsedMs: step?.lastFailure?.elapsedMs } } : {}),
  };
}

/** Attempt pins, frozen progress and one current source step. Runs only on explicit inspection. */
export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    submissionId: v.optional(v.string()),
    beforeAttempt: v.optional(v.number()),
    batchId: v.optional(v.string()),
    attemptId: v.optional(v.string()),
    afterLaneId: v.optional(v.string()),
    capsuleProtocol: v.optional(v.literal(1)),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { projectId, submissionId, beforeAttempt, batchId, attemptId, afterLaneId } = input;
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read landing attempt history.');
      const project = await accessibleProject(ctx, projectId, user.subject);
      if (batchId !== undefined) {
        invariant(
          submissionId === undefined &&
            beforeAttempt === undefined &&
            attemptId === undefined &&
            afterLaneId === undefined,
          'BAD_ARGUMENT',
          'Select only batchId to read a retained batch.',
        );
        return await landingSelectionRead(ctx, project, { batchId });
      }
      invariant(submissionId, 'BAD_ARGUMENT', 'Select submissionId to read a landing attempt.');
      if (attemptId !== undefined) {
        invariant(beforeAttempt === undefined, 'BAD_ARGUMENT', 'Select attemptId without beforeAttempt.');
        return await landingSelectionRead(ctx, project, {
          submissionId,
          attemptId,
          afterLaneId,
          capsuleProtocol: input.capsuleProtocol,
        });
      }
      invariant(afterLaneId === undefined, 'BAD_ARGUMENT', 'Use afterLaneId with an exact attemptId.');
      invariant(
        beforeAttempt === undefined || (Number.isSafeInteger(beforeAttempt) && beforeAttempt >= 0),
        'BAD_ARGUMENT',
        'Use the previous page’s nextBeforeAttempt for beforeAttempt.',
      );
      const observedAt = new Date(Date.now()).toISOString();
      const key = { projectId, submissionId };
      const row = await landingRow(ctx, key, false);
      if (!row) {
        const desired = await desiredLanding(ctx, key);
        invariant(desired, 'NOT_FOUND', 'Hosted landing request not found.');
        const state = hostedLandingStateSchema.parse(JSON.parse(desired.value));
        const at = state.timing?.composeStartedAt ?? state.at;
        const attempt = { id: state.attemptId, number: 0, at, main: state.request.expectedMain };
        return JSON.stringify({
          submissionId,
          observedAt,
          currentAttemptId: attempt.id,
          nextBeforeAttempt: null,
          attempts:
            beforeAttempt === 0
              ? []
              : [
                  await reservedAttempt(
                    ctx,
                    projectId,
                    state,
                    attempt,
                    desired.composeOperationId,
                    observedAt,
                    desired.reservedCause,
                  ),
                ],
        });
      }
      const state = landingStateFromRow(row);
      const open = state.phase !== 'landed' && state.phase !== 'terminal-failed';
      const [rows, finish] = await Promise.all([
        ctx.db
          .query('projectHostedLandingAttempts')
          .withIndex('by_project_and_submission_and_number', q => {
            const range = q.eq('projectId', projectId).eq('submissionId', submissionId);
            return beforeAttempt === undefined ? range : range.lt('number', beforeAttempt);
          })
          .order('desc')
          .take(PAGE + 1),
        state.phase !== 'landed' ? finishRow(ctx, key) : null,
      ]);
      const reservation = finish ? hostedFinishSchema.parse(JSON.parse(finish.value)).pending : null;
      // Advisory precomposition can coexist with a valid check and does not replace its attempt.
      const pending =
        reservation && !reservation.precompose && reservation.id !== state.attemptId ? reservation : null;
      const currentAttemptId = pending?.id ?? state.attemptId;
      // One lookahead row provides the oldest displayed attempt's prior clock across page boundaries.
      const progressById = new Map(
        rows.map(entry => [
          entry.attemptId,
          !entry.progress && pending && entry.attemptId === state.attemptId
            ? null
            : landingAttemptProgress(entry, state),
        ]),
      );
      const rowReplays = new Map(rows.map(entry => [entry.attemptId, entry.replay]));
      const attempts = await Promise.all(
        rows.slice(0, PAGE).map(async entry => {
          const attempt = await loadLandingAttempt(ctx, { projectId, attemptId: entry.attemptId }, entry);
          const progress = progressById.get(attempt.id);
          const parent = attempt.parentAttemptId
            ? progressById.get(attempt.parentAttemptId)?.timing
            : undefined;
          const current = currentAttemptId === attempt.id;
          const runId =
            attempt.check?.runId ?? (attempt.id === state.firstAttemptId ? row.admission?.runId : undefined);
          return installedAttempt(
            entry,
            attempt,
            progress,
            parent,
            current,
            runId,
            current && open && !progress?.settled ? observedAt : undefined,
            attempt.parentAttemptId ? rowReplays.get(attempt.parentAttemptId) : undefined,
          );
        }),
      );
      const current =
        pending && beforeAttempt === undefined
          ? [
              await reservedAttempt(
                ctx,
                projectId,
                state,
                { id: pending.id, number: pending.number, at: pending.at, main: pending.main },
                pending.operations.compose,
                observedAt,
                row.reservedCause,
                rowReplays.get(state.attemptId),
              ),
            ]
          : [];
      const nextBeforeAttempt = rows.length > PAGE ? rows[PAGE - 1]!.number : null;
      const oldest = rows.at(-1);
      const gap = rows.some((entry, index) => index > 0 && rows[index - 1]!.number !== entry.number + 1);
      const missingFirst =
        nextBeforeAttempt === null && beforeAttempt !== 0 && oldest?.attemptId !== state.firstAttemptId;
      const ownerReview = reviewState(row, state);
      const reply = {
        submissionId,
        observedAt,
        currentAttemptId,
        nextBeforeAttempt,
        ...(ownerReview === undefined ? {} : { reviewState: ownerReview }),
        // The first page holds the landed attempt and its stamp; a later page has no answer to give.
        ...(beforeAttempt === undefined
          ? {
              // A live entry's waits are written by the current recorder; an ended one carries the
              // stamp its landing or terminal write recorded. A cancel ends a reserved recompose without
              // an attempt write, so the cause it keeps on the request row stands for that stamp.
              holdEdges: replayHoldEdges(landingOrderEvidence(row, undefined), [
                (row.phase !== 'landed' && row.phase !== 'terminal-failed') || row.reservedCause
                  ? { holdEdges: 'recorded' }
                  : undefined,
                ...rows.map(entry => entry.replay),
              ]),
            }
          : {}),
        ...(state.batchId ? { batchId: state.batchId } : {}),
        ...(state.batchOriginId ? { batchOriginId: state.batchOriginId } : {}),
        ...(gap || missingFirst ? { historyPartial: true } : {}),
        attempts: [...current, ...attempts],
      };
      if (row.capsule && input.capsuleProtocol)
        return await capsuleHistoryContext(ctx, project, row.capsule, input.capsuleProtocol, submissionId, {
          ...reply,
          ...(row.admission ? { admissionRunId: row.admission.runId } : {}),
          ...(beforeAttempt === undefined ? {} : { beforeAttempt }),
          ...(beforeAttempt === undefined
            ? {
                stampedHoldEdges: Object.fromEntries(
                  (['none', 'recorded'] as const).map(stamp => [
                    stamp,
                    replayHoldEdges(landingOrderEvidence(row, undefined), [{ holdEdges: stamp }]),
                  ]),
                ),
              }
            : {}),
        });
      return JSON.stringify(row.capsule ? { ...reply, archived: true } : reply);
    } catch (error) {
      return report(error);
    }
  },
});
