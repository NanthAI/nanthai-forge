// SPDX-License-Identifier: Apache-2.0
import { checkTerminal, checkUnsuccessful } from './check-run-state.js';
import { landingStateField, type LandingRecord } from './landing-state.js';
import { shellQuote } from './shell-quote.js';
import { operationWait } from './agent-operation-wait.js';
import { landingHold } from './hosted-landing-hold.js';
import { syncRequiredAdvice, syncRequiredContinuation } from './hosted-would-conflict.js';

type Reply = Record<string, unknown>;

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

/** A new attempt retains the complete selection, never the failed operation identity. */
export function finishRetryContinuation(root: string, selection: Reply) {
  const retry = {
    ...Object.fromEntries(
      Object.entries(selection).filter(([key]) => !['operationId', 'action'].includes(key)),
    ),
    retry: true,
    reason: 'other',
  };
  const command = `nforge agent ${shellQuote(root)} finish ${shellQuote(JSON.stringify(retry))}`;
  return { next: { action: 'finish', ...retry }, command, retry, retryCommand: command };
}

/** Pending admitted work waits for its canonical parent outcome.
 * Preparation before admission and retryable source children retain their recovery. */
export function hostedObservationContinuation(root: string, result: Reply, operationId?: string): Reply {
  if (retryableFinishSource(result)) return result;
  const submission = result.submission as
    | { operationId?: string; error?: { code?: string }; observation?: { state?: string }; phase?: string }
    | undefined;
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
  const state = submission?.observation?.state ?? submission?.phase;
  // Only unfinished work waits. A terminal conflict follows its sync/resolve recovery,
  // never a wait on an operation that already ended.
  const pending = submission && !['landed', 'terminal-failed', 'superseded'].includes(state ?? '');
  const replayOperation = (result.replayParameters as Reply | undefined)?.operationId;
  const original =
    operationId ?? (typeof replayOperation === 'string' ? replayOperation : submission?.operationId);
  if (!pending || !original) return result;
  const continuation = operationWait(root, { operationIds: [original], until: 'acceptance' });
  // A held landing names who releases it beside the wait (5c59940b); derived, no read.
  const hold = landingHold(submission as Parameters<typeof landingHold>[0]);
  return {
    ...result,
    ...(hold ? { hold } : {}),
    ...continuation,
    ...(result.nextCommand ? { nextCommand: continuation.command } : {}),
  };
}

/** Normalize only already-observed outcomes. No source, journal, transport or clock access. A
 * normalized reply with a submission gains `landingState` {state, label, nextStep} (src/landing-state.ts). */
export function normalizeHostedFinishResult(root: string, selection: Reply, result: Reply): Reply {
  const normalized = normalizeObservedFinish(root, selection, result);
  // A reply left untouched (a source step still being retried) keeps its identity: callers use it
  // to tell source recovery from wait advice, and add the field themselves.
  return normalized === result ? result : withFinishLandingState(selection, result, normalized);
}
/** Add `landingState` from `result.submission` to `reply` (default `result`); unchanged without one. */
export function withFinishLandingState(selection: Reply, result: Reply, reply: Reply = result): Reply {
  const submission = result.submission as LandingRecord | undefined;
  if (!submission || typeof submission !== 'object') return reply;
  const replay = result.replayParameters as { laneId?: unknown } | undefined;
  const laneId =
    typeof replay?.laneId === 'string'
      ? replay.laneId
      : typeof selection.laneId === 'string'
        ? selection.laneId
        : undefined;
  return { ...reply, landingState: landingStateField(submission, laneId) };
}
/** Identity-preserving: returns `result` itself when nothing was observed to normalize. */
export function normalizeObservedFinish(root: string, selection: Reply, result: Reply): Reply {
  const submission = result.submission as
    | { phase?: string; observation?: { state?: string }; error?: { code?: string } }
    | undefined;
  const progress = result.progress as { status?: string; outcome?: { status?: string } } | undefined;
  const run = result.run as { status?: string } | undefined;
  const state = submission?.observation?.state ?? submission?.phase;
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
          'instruction',
          'retry',
          'retryCommand',
        ].includes(key),
    ),
  );
  if (!submission && progress && (progress.status === 'failed' || progress.outcome?.status === 'failed'))
    clean.progress = progress;
  if (submission) {
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
  return { ...clean, status: 'failed', terminal: true, ...finishRetryContinuation(root, selection) };
}
