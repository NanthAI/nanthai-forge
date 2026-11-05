// SPDX-License-Identifier: Apache-2.0
import { shellQuote } from './agent-brief-render.js';
import { operationWait } from './agent-operation-wait.js';

type Reply = Record<string, unknown>;
const failedRuns = new Set(['failed', 'cancelled', 'runner-unavailable', 'interrupted']);

/** A stopped compose child needs the retained public finish replay, not observation. */
export function stoppedFinishSource(result: Reply) {
  const submission = result.submission as { phase?: string } | undefined;
  const progress = result.progress as { status?: string; outcome?: { status?: string } } | undefined;
  return (
    submission?.phase === 'composing' &&
    (progress?.status === 'retryable' ||
      progress?.status === 'failed' ||
      progress?.outcome?.status === 'failed')
  );
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

/** Admitted work has one blocking continuation, shared by CLI and MCP.
 * Preparation before admission and stopped source jobs keep their original replay. */
export function hostedObservationContinuation(root: string, result: Reply, operationId?: string): Reply {
  if (stoppedFinishSource(result)) return result;
  const submission = result.submission as
    | { operationId?: string; error?: { code?: string }; observation?: { state?: string }; phase?: string }
    | undefined;
  const run = result.run as { id?: string; status?: string } | undefined;
  if (result.phase === 'check' && run?.id && !['passed', ...failedRuns].includes(run.status ?? ''))
    return { ...result, ...operationWait(root, { runId: run.id }) };
  const state = submission?.observation?.state ?? submission?.phase;
  const pending = submission && !['landed', 'terminal-failed', 'superseded'].includes(state ?? '');
  const conflict = submission?.error?.code === 'COMPOSITION_CONFLICT' && !result.recovery && !result.conflict;
  const replayOperation = (result.replayParameters as Reply | undefined)?.operationId;
  const original =
    operationId ?? (typeof replayOperation === 'string' ? replayOperation : submission?.operationId);
  if ((!pending && !conflict) || !original) return result;
  const continuation = operationWait(root, { operationIds: [original], until: 'acceptance' });
  if (!pending) return { ...result, next: continuation.next, command: continuation.command };
  return {
    ...result,
    ...continuation,
    ...(result.nextCommand ? { nextCommand: continuation.command } : {}),
  };
}

/** Normalize only already-observed outcomes. No source, journal, transport or clock access. */
export function normalizeHostedFinishResult(root: string, selection: Reply, result: Reply): Reply {
  const submission = result.submission as
    | { phase?: string; observation?: { state?: string }; error?: { code?: string } }
    | undefined;
  const progress = result.progress as { status?: string; outcome?: { status?: string } } | undefined;
  const run = result.run as { status?: string } | undefined;
  const state = submission?.observation?.state ?? submission?.phase;
  const failed = submission
    ? state === 'terminal-failed'
    : run
      ? failedRuns.has(run.status ?? '')
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
