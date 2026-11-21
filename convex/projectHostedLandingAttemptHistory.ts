// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { report } from './errors';
import { sanitizeFailureMessage } from './projectFailureLog';
import { loadLandingAttempt } from './projectHostedLandingAttemptRead';
import { landingSelectionRead } from './projectHostedLandingSelectionRead';
import { desiredLanding } from './projectHostedLandingDesiredWake';
import { landingAttemptProgress, landingRow, landingStateFromRow } from './projectHostedLandingStore';
import { finishRow } from './projectHostedFinishWake';
import { preparingSourceStep } from './projectHostedPreparingSource';
import { hostedFinishSchema } from '../src/hosted-finish';
import { hostedLandingStateSchema, type HostedLandingState } from '../src/hosted-landing';
import { sourceStepFailureField } from '../src/hosted-source-retry';
import { invariant } from '../src/errors';
import { phaseDuration } from '../src/land-phases';

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

async function reservedAttempt(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  state: HostedLandingState,
  attempt: { id: string; number: number; at: string; main: HostedLandingState['request']['expectedMain'] },
  composeOperationId: string,
  observedAt: string,
) {
  const step = await preparingSourceStep(ctx, projectId, state.actor, composeOperationId);
  const failure = step ? sourceStepFailureField(step) : undefined;
  const failed = state.phase === 'terminal-failed';
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
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { projectId, submissionId, beforeAttempt, batchId, attemptId, afterLaneId } = input;
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read landing attempt history.');
      await accessibleProject(ctx, projectId, user.subject);
      if (batchId !== undefined) {
        invariant(
          submissionId === undefined &&
            beforeAttempt === undefined &&
            attemptId === undefined &&
            afterLaneId === undefined,
          'BAD_ARGUMENT',
          'Select only batchId to read a retained batch.',
        );
        return JSON.stringify(await landingSelectionRead(ctx, projectId, { batchId }));
      }
      invariant(submissionId, 'BAD_ARGUMENT', 'Select submissionId to read a landing attempt.');
      if (attemptId !== undefined) {
        invariant(beforeAttempt === undefined, 'BAD_ARGUMENT', 'Select attemptId without beforeAttempt.');
        return JSON.stringify(
          await landingSelectionRead(ctx, projectId, { submissionId, attemptId, afterLaneId }),
        );
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
          return {
            id: attempt.id,
            number: attempt.number,
            at: attempt.at,
            current,
            main: attempt.main,
            candidateId: attempt.candidate.id,
            ...(runId ? { runId } : {}),
            ...(attempt.checkCause ? { checkCause: attempt.checkCause } : {}),
            ...installedTiming(attempt.parentAttemptId && !parent ? undefined : progress?.timing, parent, {
              phase: progress?.phase ?? null,
              queuedAt: attempt.parentAttemptId ? parent?.settledAt : attempt.at,
              hasCheck: !!runId,
              observedAt: current && open && !progress?.settled ? observedAt : undefined,
            }),
            cause: cause(progress?.error),
          };
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
              ),
            ]
          : [];
      const nextBeforeAttempt = rows.length > PAGE ? rows[PAGE - 1]!.number : null;
      const oldest = rows.at(-1);
      const gap = rows.some((entry, index) => index > 0 && rows[index - 1]!.number !== entry.number + 1);
      const missingFirst =
        nextBeforeAttempt === null && beforeAttempt !== 0 && oldest?.attemptId !== state.firstAttemptId;
      return JSON.stringify({
        submissionId,
        observedAt,
        currentAttemptId,
        nextBeforeAttempt,
        ...(state.batchId ? { batchId: state.batchId } : {}),
        ...(state.batchOriginId ? { batchOriginId: state.batchOriginId } : {}),
        ...(gap || missingFirst ? { historyPartial: true } : {}),
        attempts: [...current, ...attempts],
      });
    } catch (error) {
      return report(error);
    }
  },
});
