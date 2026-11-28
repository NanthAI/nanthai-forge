// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { checkTerminal, checkUnsuccessful } from './check-run-state.js';
import { landingStateField, landingStateOf, type LandingRecord } from './landing-state.js';
import type { HostedLandingState } from './hosted-landing.js';
import type { LandingStall } from './landing-stall.js';
import { orderWaitOf } from './hosted-wait-line.js';
import { shellQuote } from './shell-quote.js';
import { operationWait, stalledLandingContinuation } from './agent-operation-wait.js';
import { landingHold, type LandingReview } from './hosted-landing-hold.js';
import { syncRequiredAdvice, syncRequiredContinuation } from './hosted-would-conflict.js';
import { finishCommandLaneIds } from './hosted-agent-journal.js';

type Reply = Record<string, unknown>;

type WaitProgress = LandingRecord & {
  at?: string;
  timing?: HostedLandingState['timing'];
  lastProgressAt?: string;
  observation?: (NonNullable<LandingRecord['observation']> & { stall?: LandingStall | undefined }) | null;
};

/** Use the existing observation and the latest feed snapshot for this submission. Older servers omit feed timing. */
export async function landingWaitProgress(
  recorded: WaitProgress | undefined,
  live: WaitProgress | undefined,
  presentation: LandingRecord | undefined = recorded,
  laneId?: string,
) {
  if (recorded?.observation?.state !== 'pending' || !presentation) return undefined;
  const { state, hold } = landingStateOf(presentation, laneId);
  const stage =
    hold || state === 'waiting-for-runner' || state === 'waiting-for-order'
      ? state
      : presentation.phase === 'composing'
        ? 'composing'
        : presentation.phase === 'checking'
          ? 'checking'
          : state === 'landing'
            ? 'accepting'
            : 'queued';
  const lastProgressAt =
    live?.lastProgressAt ??
    (presentation.phase === recorded.phase
      ? (await import('./landing-stall.js')).latestLandingProgress([
          recorded.at,
          ...Object.values(recorded.timing ?? {}).filter(
            (value): value is string => typeof value === 'string',
          ),
        ])
      : undefined);
  // A new feed snapshot carries both the timestamp and the current stall (whose absence clears it).
  const reportedStall = live?.lastProgressAt
    ? live.observation?.stall
    : presentation.phase === recorded.phase
      ? recorded.observation.stall
      : undefined;
  // Cohort repair evidence can retain an old stall after progress resumes.
  const stall = reportedStall?.lastProgressAt === lastProgressAt ? reportedStall : undefined;
  return { stage, lastProgressAt, stall, hold };
}

/** A reply that explains a failed check (`failureCause`, src/check-failure-cause.ts) gives one next
 * step: the cause's own, so a landing that failed only on main's red never also says "fix your code"
 * (friction f27065f7). Without a cause the landing state's step stands. No reads. */
export function causeNextStep<T extends { nextStep: string }>(landingState: T, failureCause: unknown): T {
  const next = (failureCause as { next?: unknown } | null | undefined)?.next;
  return typeof next === 'string' && next.trim() ? { ...landingState, nextStep: next } : landingState;
}

/** Present newer progress for the selected submission without changing the drained landing record. */
export function pendingLandingPresentation(
  recorded: (LandingRecord & { id: string; operationId: string }) | undefined,
  progress: LandingRecord | undefined,
  laneId?: string,
) {
  if (recorded?.observation?.state !== 'pending' || !progress) return undefined;
  const code = recorded.error?.code;
  const holdCode = code === 'MAIN_RED' || code === 'CI_DOWN' ? code : undefined;
  // A metadata-only update leaves the recorded hold or stall details in effect.
  if (
    progress.phase === recorded.phase &&
    progress.observation?.pendingReason === recorded.observation?.pendingReason &&
    progress.error?.code === holdCode &&
    progress.orderWait?.submissionId === recorded.orderWait?.submissionId
  )
    return undefined;
  const submission: LandingRecord = {
    id: recorded.id,
    operationId: recorded.operationId,
    ...(recorded.request ? { request: recorded.request } : {}),
    ...progress,
  };
  const blocker = progress.orderWait?.submissionId;
  const knownOrder = blocker && recorded.orderWait?.submissionId === blocker && recorded.orderWait.message;
  if (blocker)
    submission.orderWait = {
      submissionId: blocker,
      message:
        knownOrder ||
        `${submission.request?.check === null ? 'No check ran' : 'The check passed'}. Waiting for submission ${blocker} to clear.`,
    };
  const landingState = landingStateField(submission, laneId);
  if (landingState.state === 'waiting-for-order' && !knownOrder)
    landingState.label = 'Waiting for another landing';
  return { submission, landingState };
}

/** A retryable compose child needs the retained public finish recovery. */
export function retryableFinishSource(result: Reply) {
  const submission = result.submission as { phase?: string } | undefined;
  const progress = result.progress as { status?: string } | undefined;
  return submission?.phase === 'composing' && progress?.status === 'retryable';
}

/** Source preparation (save, compose or sync) that outlived the caller's budget: the receipt's own
 * `status` says `submitted`, or, for a receipt that names no recovery command of its own, its job's
 * progress does (Issue 17cce1b3: finish's save and compose receipts carry it only in `progress`).
 * Retryable and failed sources, and a named source continuation, keep their own recovery. */
export function preparingFinishSource(result: Reply) {
  if (!['save', 'compose', 'sync'].includes(String(result.phase))) return false;
  const progress = result.progress as { status?: unknown } | undefined;
  return (result.status ?? (result.command ? undefined : progress?.status)) === 'submitted';
}

/** Retry selects a new attempt even on identical source and reconciles an unfinished retry. */
export function finishResubmitContinuation(root: string, selection: Reply) {
  const again = {
    ...Object.fromEntries(
      Object.entries(selection).filter(
        ([key]) => !['operationId', 'action', 'retry', 'reason'].includes(key),
      ),
    ),
    retry: true,
    reason: 'other',
  };
  const command = `nforge agent ${shellQuote(root)} land --save ${shellQuote(JSON.stringify(again))}`;
  return { next: { action: 'finish', ...again }, command, retryCommand: command };
}

export function finishRetryContinuation(root: string, selection: Reply) {
  const continuation = finishResubmitContinuation(root, selection);
  const { action, ...retry } = continuation.next;
  void action;
  return { ...continuation, retry };
}

export function finishRecoveryLaneId(selection: Reply, checkoutLaneId?: string) {
  const lanes = finishCommandLaneIds(selection, checkoutLaneId);
  return lanes.length === 1 ? lanes[0] : typeof selection.laneId === 'string' ? selection.laneId : undefined;
}

export function emptyLandingRecovery(root: string, laneId?: string) {
  const parameters = { ...(laneId ? { laneId } : {}), summary: true };
  const command = `nforge agent ${shellQuote(root)} diff ${shellQuote(JSON.stringify(parameters))}`;
  return {
    command,
    next: { action: 'diff', parameters },
    instruction: `Inspect the Lane diff${laneId ? '' : ' from its checkout'} with ${command}. Stop if the intended changes are on main.`,
  };
}

export const stoppedLanding = (code: unknown) => code === 'LANDING_CANCELLED' || code === 'REVIEW_DECLINED';

export const stoppedLandingResubmit =
  'To resubmit from this landing’s Lane checkout, use the original land --save parameters. Keep the inputs and dependencies, remove operationId, and set "retry":true and "reason":"other".';

export function cancelledLandingRecovery(
  root: string,
  laneId?: string,
  resubmit?: ReturnType<typeof finishResubmitContinuation>,
  observedOverlap?: unknown,
) {
  const overlap = syncRequiredAdvice(observedOverlap);
  const needsSync = Boolean(overlap && 'landedSubmissionId' in overlap);
  laneId ??= needsSync ? overlap?.laneId : undefined;
  const parameters = laneId ? { laneId } : {};
  const sync = {
    next: { action: 'sync', ...parameters },
    command: `nforge agent ${laneId ? shellQuote(root) : '.'} save --sync ${shellQuote(JSON.stringify(parameters))}`,
  };
  const instruction =
    `${needsSync ? 'Main changed files this Lane touches. Sync' : 'If main changed files this Lane touches, sync'} the Lane first with ${sync.command}${laneId ? '' : ' from this landing’s Lane checkout'}. ` +
    (resubmit
      ? `${needsSync ? 'Once the sync is complete' : 'When main’s changes are disjoint or the sync is complete'}, submit again as a new operation: ${resubmit.command}`
      : stoppedLandingResubmit);
  return {
    instruction,
    ...(needsSync ? sync : {}),
    recovery: {
      instruction,
      ...(needsSync ? sync : {}),
      choices: {
        sync: { when: 'Main changed files this Lane touches.', ...sync },
        ...(resubmit
          ? {
              resubmit: {
                when: 'Main’s changes are disjoint or the sync is complete.',
                next: resubmit.next,
                command: resubmit.command,
              },
            }
          : {}),
      },
    },
  };
}

function observedFinishState(submission: { phase?: string; observation?: { state?: string } } | undefined) {
  const state = submission?.observation?.state;
  if (state === 'superseded') return state;
  if (submission?.phase === 'terminal-failed' || submission?.phase === 'landed') return submission.phase;
  return state ?? submission?.phase;
}

/** Pending admitted work waits for its canonical parent outcome.
 * Preparation before admission and retryable source children retain their recovery. */
export function hostedObservationContinuation(root: string, result: Reply, operationId?: string): Reply {
  const submission = result.submission as
    | {
        operationId?: string;
        error?: { code?: string };
        observation?: { state?: string; stall?: LandingStall };
        phase?: string;
      }
    | undefined;
  const state = observedFinishState(submission);
  if (
    state === 'landed' ||
    state === 'terminal-failed' ||
    state === 'superseded' ||
    retryableFinishSource(result)
  )
    return result;
  const run = result.run as { id?: string; status?: string } | undefined;
  if (result.phase === 'check' && run?.id && !checkTerminal(run.status ?? ''))
    return { ...result, ...operationWait(root, { runId: run.id }) };
  // Main already took files this queued entry changes (f7539ebb): the recovery is the same Lane's
  // land --save, never another wait on this operation.
  const sync = syncRequiredAdvice(result.wouldConflict, submission);
  if (sync) {
    // The land's own parameters keep its Lane and commit message (readers never see the message).
    const replay = result.replayParameters as { laneId?: unknown; message?: unknown } | undefined;
    return {
      ...result,
      ...syncRequiredContinuation(root, sync, {
        laneId: typeof replay?.laneId === 'string' ? replay.laneId : undefined,
        message: typeof replay?.message === 'string' ? replay.message : undefined,
      }),
    };
  }
  const replayOperation = (result.replayParameters as Reply | undefined)?.operationId;
  const original =
    operationId ?? (typeof replayOperation === 'string' ? replayOperation : submission?.operationId);
  if (!submission || !original) return result;
  const continuation = operationWait(root, { operationIds: [original], until: 'acceptance' });
  const stalled = submission.observation?.stall;
  const next = stalled ? stalledLandingContinuation(root, original, continuation.waitCommand) : undefined;
  // A held landing names who releases it beside the wait (5c59940b); derived, no read.
  const selected = submission as Parameters<typeof landingHold>[0];
  const approval = Object.hasOwn(result, 'pendingAttempt') ? (result as LandingReview) : undefined;
  const hold = landingHold({
    ...selected,
    approver: approval?.approver ?? selected?.approver,
    url: approval?.url ?? selected?.url,
  });
  const reply = {
    ...result,
    ...(hold ? { hold } : {}),
    ...continuation,
    ...next,
    ...(stalled || result.stall ? { stall: stalled } : {}),
    ...(result.nextCommand ? { nextCommand: (next ?? continuation).command } : {}),
  };
  return stalled ? withFinishLandingState({}, reply) : reply;
}

/** Normalize only already-observed outcomes. No source, journal, transport or clock access. A
 * normalized reply with a submission gains `landingState` {state, label, nextStep} (src/landing-state.ts). */
export function normalizeHostedFinishResult(
  root: string,
  selection: Reply,
  result: Reply,
  checkoutLaneId?: string,
): Reply {
  const normalized = normalizeObservedFinish(root, selection, result, checkoutLaneId);
  // A reply left untouched (a source step still being retried) keeps its identity: callers use it
  // to tell source recovery from wait advice, and add the field themselves.
  return normalized === result ? result : withFinishLandingState(selection, normalized);
}
/** Add `landingState` from `result.submission` when present. */
export function withFinishLandingState(selection: Reply, result: Reply): Reply {
  const submission = result.submission as LandingRecord | undefined;
  if (!submission || typeof submission !== 'object') return result;
  const replay = result.replayParameters as { laneId?: unknown } | undefined;
  const laneId =
    typeof replay?.laneId === 'string'
      ? replay.laneId
      : typeof selection.laneId === 'string'
        ? selection.laneId
        : undefined;
  return {
    ...result,
    landingState: causeNextStep(
      landingStateField(
        {
          ...submission,
          orderWait: orderWaitOf(result.orderWait),
          ...(typeof result.providerDelay === 'string' ? { providerDelay: result.providerDelay } : {}),
        },
        laneId,
      ),
      (result.stall ||
        stoppedLanding(submission.error?.code) ||
        submission.error?.code === 'NOTHING_TO_LAND') &&
        typeof result.instruction === 'string'
        ? { next: result.instruction }
        : result.failureCause,
    ),
  };
}
/** Identity-preserving: returns `result` itself when nothing was observed to normalize. */
export function normalizeObservedFinish(
  root: string,
  selection: Reply,
  result: Reply,
  checkoutLaneId?: string,
): Reply {
  const submission = result.submission as
    | { phase?: string; observation?: { state?: string }; error?: { code?: string } }
    | undefined;
  const progress = result.progress as { status?: string; outcome?: { status?: string } } | undefined;
  const run = result.run as { status?: string } | undefined;
  const state = observedFinishState(submission);
  const failed = submission
    ? state === 'terminal-failed'
    : run
      ? checkUnsuccessful(run.status ?? '')
      : progress?.status === 'failed' || progress?.outcome?.status === 'failed';
  const settled =
    result.phase === 'conflict' ||
    state === 'landed' ||
    state === 'superseded' ||
    failed ||
    (!submission && run?.status === 'passed');
  if (!settled)
    return hostedObservationContinuation(
      root,
      result,
      typeof selection.operationId === 'string' ? selection.operationId : undefined,
    );
  // These fields described the pre-wait source/queue snapshot. Keep the immutable
  // submission, run and replayParameters as evidence, without advertising replay as recovery.
  const clean = Object.fromEntries(
    Object.entries(result).filter(
      ([key]) =>
        ![
          'status',
          'progress',
          'replay',
          'next',
          'command',
          'waitCommand',
          'nextCommand',
          'waitStatus',
          'inProgress',
          'wake',
          'hold',
          'stall',
          'instruction',
          'retry',
          'retryCommand',
        ].includes(key),
    ),
  );
  if (!submission && progress && (progress.status === 'failed' || progress.outcome?.status === 'failed'))
    clean.progress = progress;
  if (submission) {
    // A replay can carry earlier pending metadata alongside its terminal phase.
    if (submission.observation?.state === 'pending' && (state === 'terminal-failed' || state === 'landed'))
      clean.submission = {
        ...submission,
        observation: {
          state,
          pendingReason: null,
          cause: stoppedLanding(submission.error?.code) ? 'rejected' : null,
        },
      };
    delete clean.source;
    delete clean.error;
    delete clean.failedPhase;
  }
  // Conflict recovery owns its retained sync/resolve operation and exact command.
  if (
    submission?.error?.code === 'COMPOSITION_CONFLICT' ||
    (result.recovery as { conflict?: unknown } | undefined)?.conflict ||
    result.conflict
  )
    return clean;
  if (submission) {
    delete clean.recovery;
  }
  if (!failed) return clean;
  const error =
    submission?.error ??
    result.error ??
    (progress as { error?: unknown; outcome?: { error?: unknown } } | undefined)?.error ??
    (progress as { outcome?: { error?: unknown } } | undefined)?.outcome?.error;
  const code = (error as { code?: string } | undefined)?.code;
  if (code === 'NOTHING_TO_LAND') {
    const recovery = emptyLandingRecovery(root, finishRecoveryLaneId(selection, checkoutLaneId));
    return { ...clean, status: 'failed', terminal: true, recovery, instruction: recovery.instruction };
  }
  if (code === 'SOURCE_STATE_TOO_LARGE') return { ...clean, status: 'failed', terminal: true };
  if (code === 'LANDING_CANCELLED')
    return {
      ...clean,
      status: 'failed',
      terminal: true,
      ...cancelledLandingRecovery(
        root,
        finishRecoveryLaneId(selection, checkoutLaneId),
        finishResubmitContinuation(root, selection),
        result.wouldConflict,
      ),
    };
  if (stoppedLanding(code)) {
    const retry = finishResubmitContinuation(root, selection);
    return { ...clean, status: 'failed', terminal: true, ...retry };
  }
  const retry = finishRetryContinuation(root, selection);
  // Failed only on main's red, and a land now would not wait (review of friction f27065f7): the command
  // is the wait for main; the re-land is retryCommand, for once main is green.
  const cause = result.failureCause as { recovery?: unknown; next?: unknown } | undefined;
  // The non-parking advice names the wait (src/check-failure-cause.ts recoveryText); matched by text so
  // this light module does not load the cause contract.
  if (
    cause?.recovery === 'wait-for-main' &&
    typeof cause.next === 'string' &&
    cause.next.includes('wait {"main":"green"}')
  ) {
    const wait = `nforge agent ${shellQuote(root)} wait ${shellQuote(JSON.stringify({ main: 'green' }))}`;
    return {
      ...clean,
      status: 'failed',
      terminal: true,
      ...retry,
      next: { action: 'wait', main: 'green' },
      command: wait,
      waitCommand: wait,
    };
  }
  return { ...clean, status: 'failed', terminal: true, ...retry };
}
