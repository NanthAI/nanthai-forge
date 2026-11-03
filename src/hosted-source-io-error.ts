// SPDX-License-Identifier: Apache-2.0
import { sourceFailureStages, sourceFailureCodes, type SourceFailure } from './hosted-source-retry.js';
/** Transport failures are deliberately not ForgeErrors: a scheduled source
 * action must fail so its existing owner can repair the retained quantum. */
export class SourceIoError extends Error {
  readonly exception: string;
  readonly code: string | null;
  constructor(
    error: unknown,
    readonly stage: string,
    readonly object: string | null = null,
    readonly httpStatus: number | null = null,
  ) {
    super('Source I/O did not complete.');
    this.name = 'SourceIoError';
    this.exception = error instanceof SourceIoError ? error.exception : exceptionClass(error);
    this.code = failureCode(error);
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
  identity: { jobId: string; step: number; index?: number; generation?: number },
  stage: string,
  started: number,
) {
  const cause = sourceFailureCause(error, stage, started);
  const io = error instanceof SourceIoError ? error : null;
  console.warn(
    JSON.stringify({
      event: 'forge-source-failure',
      job: identity.jobId,
      step: identity.step,
      task: identity.index ?? null,
      generation: identity.generation ?? null,
      ...cause,
      object: io?.object && /^[a-f0-9]{64}$/.test(io.object) ? io.object : null,
    }),
  );
}
export function sourceFailureCause(error: unknown, stage: string, started: number): SourceFailure {
  const io = error instanceof SourceIoError ? error : null;
  const selected = io?.stage ?? stage;
  const status = io?.httpStatus;
  return {
    stage: (sourceFailureStages as readonly string[]).includes(selected)
      ? (selected as SourceFailure['stage'])
      : 'step',
    exception: (io?.exception ?? exceptionClass(error)) as SourceFailure['exception'],
    code: failureCode(error) as SourceFailure['code'],
    elapsedMs: Math.min(600000, Math.max(0, Math.round(performance.now() - started))),
    httpStatus: Number.isInteger(status) && status! >= 100 && status! <= 599 ? status! : null,
  };
}

export async function withSourceFailureLog<T>(
  identity: { jobId: string; step: number; index?: number; generation?: number },
  stage: string,
  run: () => Promise<T>,
  failed?: (cause: SourceFailure) => Promise<unknown>,
) {
  const started = performance.now();
  try {
    return await run();
  } catch (error) {
    logSourceFailure(error, identity, stage, started);
    const cause = sourceFailureCause(error, stage, started);
    try {
      if (cause.code !== 'SOURCE_JOB_FENCED') await failed?.(cause);
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
