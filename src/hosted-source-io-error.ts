// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ForgeError } from './errors.js';
import {
  sourceFailureStages,
  sourceFailureCodes,
  sourceFailureCalls,
  slowestSourcePhase,
  type SourcePhaseTiming,
  type SourceFailure,
} from './hosted-source-retry.js';
/** Transport failures are deliberately not ForgeErrors: a scheduled source
 * action must fail so its existing owner can repair the retained quantum. */
export type SourceFailureContext = Pick<SourceFailure, 'call' | 'size' | 'objects'>;
export class SourceIoError extends Error {
  readonly exception: string;
  readonly code: string;
  readonly context: SourceFailureContext;
  constructor(
    error: unknown,
    readonly stage: string,
    readonly object: string | null = null,
    readonly httpStatus: number | null = null,
    context: SourceFailureContext = {},
  ) {
    super('Source I/O did not complete.');
    this.name = 'SourceIoError';
    this.exception = error instanceof SourceIoError ? error.exception : exceptionClass(error);
    this.code = failureCode(error) ?? 'SOURCE_RUNTIME_ERROR';
    const details = { ...context, ...(error instanceof SourceIoError ? error.context : {}) };
    this.context = {
      ...((sourceFailureCalls as readonly unknown[]).includes(details.call) ? { call: details.call } : {}),
      ...Object.fromEntries(
        ['size', 'objects'].flatMap(key => {
          const value = details[key as 'size' | 'objects'];
          return Number.isSafeInteger(value) && value! >= 0 ? [[key, value]] : [];
        }),
      ),
    };
    if (error instanceof SourceIoError) {
      this.stage = error.stage;
      this.object = error.object ?? object;
      this.httpStatus = error.httpStatus ?? httpStatus;
    }
    if (!this.object || !/^[a-f0-9]{64}$/.test(this.object)) this.object = null;
    if (!(sourceFailureStages as readonly string[]).includes(this.stage)) this.stage = 'step';
    if (!Number.isInteger(this.httpStatus) || this.httpStatus! < 100 || this.httpStatus! > 599)
      this.httpStatus = null;
  }
}
function failureCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const data = 'data' in error && error.data && typeof error.data === 'object' ? error.data : null;
  const code = 'code' in error ? error.code : data && 'code' in data ? data.code : null;
  return typeof code === 'string' && (sourceFailureCodes as readonly string[]).includes(code) ? code : null;
}
function exceptionClass(error: unknown) {
  const name = error instanceof Error ? error.name : '';
  return [
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'TimeoutError',
    'AbortError',
    'ConvexError',
    'ForgeError',
  ].includes(name)
    ? name
    : 'UnknownError';
}
export const transientSourceStatus = (status: number) =>
  status === 408 || status === 425 || status === 429 || status >= 500;

/** Only bounded structured context enters retained platform logs. Never log
 * arbitrary messages, stacks, response bodies, URLs, headers or source bytes. */
export function logSourceFailure(
  error: unknown,
  identity: { jobId: string; step: number; index?: number; generation?: number; stepCause?: string | null },
  stage: string,
  started: number,
  timing?: SourcePhaseTiming,
) {
  const cause = sourceFailureCause(error, stage, started, timing);
  const stepCause =
    identity.stepCause && /^[a-z-]{1,32}$/.test(identity.stepCause) ? identity.stepCause : null;
  const io = error instanceof SourceIoError ? error : null;
  console.warn(
    JSON.stringify({
      event: 'forge-source-failure',
      job: identity.jobId,
      step: identity.step,
      task: identity.index ?? null,
      generation: identity.generation ?? null,
      // sourceStepCause (why the step ran); `cause` below is why it failed.
      ...(stepCause ? { stepCause } : {}),
      ...cause,
      object: io?.object && /^[a-f0-9]{64}$/.test(io.object) ? io.object : null,
    }),
  );
}
/** One bounded line per completed step or failed attempt so the existing log-stream
 * instrument can split source memory-time by job kind and phase without a
 * metrics read. Counts and identifiers only; never URLs, messages or bytes. */
/** Why a source step runs, for its log line (Item 686ecdde Fix 3): `save`, `register`, a sync's mode
 * (`sync`, `revert`, `resolution`, `resolve`), or a compose: `compose` on the main its request
 * expected, `recompose` when main moved since that request (a race or a named recompose), with a
 * `batch-` prefix for a cohort. Read from the state the step's begin already loaded: no extra read. */
export function sourceStepCause(jobKind: string | undefined, state: unknown): string | null {
  if (jobKind === 'save') return 'save';
  if (jobKind === 'register-state') return 'register';
  const value = (state ?? {}) as {
    work?: { mode?: unknown };
    batch?: unknown;
    main?: { object?: { sha256?: unknown } };
    request?: { expectedMain?: { head?: unknown } };
  };
  if (jobKind === 'sync') return typeof value.work?.mode === 'string' ? value.work.mode : null;
  if (jobKind !== 'compose') return null;
  const main = value.main?.object?.sha256,
    expected = value.request?.expectedMain?.head;
  if (typeof main !== 'string' || typeof expected !== 'string') return null;
  return `${value.batch ? 'batch-' : ''}${main === expected ? 'compose' : 'recompose'}`;
}
export function logSourceStep(
  identity: { jobId: string; step: number },
  fields: {
    runtime: 'v8' | 'node';
    kind: string | null;
    /** sourceStepCause, carried in the step's begin payload. */
    cause?: string | null;
    from: string | null;
    to: string | null;
    objects: number;
    bytes: number;
    outputs: number;
    outcome?: 'failed';
    putBytes?: {
      state: number;
      progress: number;
      result: number;
      other: number;
      refused: number;
      avoided: number;
    };
    started: number;
    timing?: SourcePhaseTiming;
  },
) {
  const count = (value: number) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const name = (value: string | null) => (value && /^[a-z-]{1,32}$/.test(value) ? value : null);
  // Same channel as forge-source-failure: never mixed into CLI/result stdout.
  console.warn(
    JSON.stringify({
      event: 'forge-source-step',
      ...(fields.timing ? { timing: fields.timing } : {}),
      job: identity.jobId,
      step: identity.step,
      runtime: fields.runtime,
      ...(fields.outcome ? { outcome: fields.outcome } : {}),
      kind: name(fields.kind),
      ...(name(fields.cause ?? null) ? { cause: name(fields.cause ?? null) } : {}),
      from: name(fields.from),
      to: name(fields.to),
      objects: count(fields.objects),
      bytes: count(fields.bytes),
      outputs: count(fields.outputs),
      ...(fields.putBytes
        ? {
            putBytes: Object.fromEntries(
              (['state', 'progress', 'result', 'other', 'refused', 'avoided'] as const).map(key => [
                key,
                count(fields.putBytes![key]),
              ]),
            ),
          }
        : {}),
      elapsedMs: Math.min(600000, Math.max(0, Math.round(performance.now() - fields.started))),
    }),
  );
}
export function sourceFailureCause(
  error: unknown,
  stage: string,
  started: number,
  timing?: SourcePhaseTiming,
): SourceFailure {
  const io = error instanceof SourceIoError ? error : null;
  const selected = io?.stage ?? stage;
  const status = io?.httpStatus;
  const elapsedMs = Math.max(0, Math.round(performance.now() - started));
  const slowestPhase = timing && slowestSourcePhase(timing);
  return {
    stage: (sourceFailureStages as readonly string[]).includes(selected)
      ? (selected as SourceFailure['stage'])
      : 'step',
    exception: (io?.exception ?? exceptionClass(error)) as SourceFailure['exception'],
    code: (failureCode(error) ?? 'SOURCE_RUNTIME_ERROR') as SourceFailure['code'],
    elapsedMs: Math.min(600000, elapsedMs),
    ...(timing ? { timing } : {}),
    ...(slowestPhase ? { slowestPhase } : {}),
    ...(io?.context.call && (sourceFailureCalls as readonly string[]).includes(io.context.call)
      ? { call: io.context.call }
      : {}),
    ...(io?.object && /^[a-f0-9]{64}$/.test(io.object) ? { object: io.object } : {}),
    ...Object.fromEntries(
      ['size', 'objects'].flatMap(key => {
        const value = io?.context[key as 'size' | 'objects'];
        return Number.isSafeInteger(value) && value! >= 0 ? [[key, value]] : [];
      }),
    ),
    httpStatus: Number.isInteger(status) && status! >= 100 && status! <= 599 ? status! : null,
  };
}

export async function withSourceFailureLog<T>(
  identity: { jobId: string; step: number; index?: number; generation?: number },
  stage: string,
  run: () => Promise<T>,
  failed?: (cause: SourceFailure) => Promise<unknown>,
  timing?: () => SourcePhaseTiming | undefined,
) {
  const started = performance.now();
  try {
    return await run();
  } catch (error) {
    const measured = timing?.();
    logSourceFailure(error, identity, stage, started, measured);
    const cause = { ...sourceFailureCause(error, stage, started, measured), step: identity.step };
    try {
      // A fenced step is recorded too (incident e62d834b): the server decides whether it is still the
      // current attempt (then it is retried) or was superseded (then recording is a no-op).
      await failed?.(cause);
    } catch (recordingError) {
      // A lost accounting reply is repaired from the scheduler's stopped run.
      // Its raw exception is never attached to the action rejection either.
      logSourceFailure(recordingError, identity, stage, started);
    }
    const opaque = new SourceIoError(
      error,
      cause.stage,
      error instanceof SourceIoError && error.object && /^[a-f0-9]{64}$/.test(error.object)
        ? error.object
        : null,
      cause.httpStatus,
    );
    throw opaque;
  }
}

/** Carry only trusted call labels and pins across action boundaries. */
export async function sourceCall<T>(
  call: NonNullable<SourceFailure['call']>,
  run: () => Promise<T>,
  context: Omit<SourceFailureContext, 'call'> = {},
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Domain errors keep their settlement semantics; this wrapper is for unknown failures.
    if (error instanceof ForgeError || (error instanceof Error && error.name === 'ConvexError')) throw error;
    throw new SourceIoError(error, 'task', null, null, { call, ...context });
  }
}
