// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
export const sourcePhaseNames = ['startup', 'read', 'compute', 'write', 'convex'] as const;
export type SourcePhaseTiming = {
  startupMs: number;
  readMs: number;
  computeMs: number;
  writeMs: number;
  convexMs: number;
  gets: number;
  puts: number;
  heads: number;
};
export type SlowSourcePhase = (typeof sourcePhaseNames)[number];
export const sourceTimingMax = 999_999_999;
export function slowestSourcePhase(timing: SourcePhaseTiming): SlowSourcePhase {
  return sourcePhaseNames.reduce((slowest, phase) =>
    timing[`${phase}Ms`] > timing[`${slowest}Ms`] ? phase : slowest,
  );
}
export const sourceFailureStages = [
  'task',
  'step',
  'small-save',
  'source-head',
  'source-put',
  'source-descriptors',
  'source-headers',
  'source-body',
  'durable-headers',
  'durable-body',
  'scheduled-task',
  'scheduled-step',
  'compose-watch',
] as const;
export const sourceFailureClasses = [
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'TimeoutError',
  'AbortError',
  'ConvexError',
  'ForgeError',
  'UnknownError',
] as const;
export const sourceFailureCodes = [
  'EXCHANGE_REQUEST_FAILED',
  'EXCHANGE_REQUEST_TIMEOUT',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'SOURCE_JOB_FENCED',
  'SOURCE_UNAVAILABLE',
  'SOURCE_STATE_TOO_LARGE',
  'SOURCE_HASH_MISMATCH',
  'SOURCE_RECIPE_INVALID',
  'SOURCE_PAGE_INVALID',
  'SOURCE_JOB_INVALID',
  'SOURCE_CLOSURE_INVALID',
  'INVALID_WORK_BACKUP',
  'INVALID_NATIVE_SOURCE',
  'R2_UPLOAD_FAILED',
  'R2_VERIFY_FAILED',
  'R2_NOT_CONFIGURED',
  'SOURCE_RETRY_EXHAUSTED',
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_REQUIRE_ESM',
  'SOURCE_RUNTIME_ERROR',
] as const;
export const sourceFailureCalls = [
  'task-begin',
  'task-input',
  'task-progress-read',
  'task-run',
  'task-stage',
  'task-progress-store',
  'task-complete',
  'import-declarations',
  'merge-read',
  'merge-text',
  'merge-markers',
  'merge-publish',
] as const;
const phaseValue = z.number().int().min(0).max(sourceTimingMax);
export const sourcePhaseTimingSchema = z
  .object({
    startupMs: phaseValue,
    readMs: phaseValue,
    computeMs: phaseValue,
    writeMs: phaseValue,
    convexMs: phaseValue,
    gets: phaseValue,
    puts: phaseValue,
    heads: phaseValue,
  })
  .strict();
export const sourceFailureSchema = z
  .object({
    stage: z.enum(sourceFailureStages),
    exception: z.enum(sourceFailureClasses),
    code: z.enum(sourceFailureCodes).nullable(),
    step: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    call: z.enum(sourceFailureCalls).optional(),
    object: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    objects: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    elapsedMs: z.number().int().min(0).max(600000),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    timing: sourcePhaseTimingSchema.optional(),
    slowestPhase: z.enum(sourcePhaseNames).optional(),
  })
  .strict();
export type SourceFailure = z.infer<typeof sourceFailureSchema>;
export const SOURCE_MAX_FAILED_ATTEMPTS = 6;
export const sourceRetryBackoff = (failures: number) =>
  Math.min(60000, 2000 * 2 ** Math.min(Math.max(0, failures - 1), 5));
export const unknownSourceFailure = (
  stage: 'scheduled-task' | 'scheduled-step' | 'compose-watch',
): SourceFailure => ({
  stage,
  exception: 'UnknownError',
  code: 'SOURCE_RUNTIME_ERROR',
  elapsedMs: 0,
  httpStatus: null,
});
export function sourceFailurePhase(cause?: SourceFailure) {
  return cause?.slowestPhase ? ` Longest source phase: ${cause.slowestPhase}.` : '';
}
export function sourceRetryFailureMessage(cause?: SourceFailure) {
  return (
    'Source repair exhausted; the original inputs and identity are retained. Use the advertised continuation to start a new attempt.' +
    (cause
      ? ` Last bounded cause: ${JSON.stringify(sourceFailureSchema.parse({ ...cause, timing: undefined }))}`
      : '')
  );
}
/** A preparing landing's failed or fenced source step and its cause (incident e62d834b: the queue and
 * `wait` said only "composing"). Built from the step row its reader already holds; no extra read. The
 * step retries itself up to `maxAttempts`; `retryAt` is when the next attempt may start. */
export function sourceStepFailureField(row: {
  step: number;
  failedAttempts?: number;
  lastFailure?: SourceFailure;
  lastFailureAt?: number;
  retryAt?: number;
}) {
  if (!row.lastFailure) return undefined;
  const { code, stage, exception, timing, slowestPhase } = row.lastFailure;
  return {
    step: row.step,
    code: code ?? 'SOURCE_RUNTIME_ERROR',
    stage,
    exception,
    ...(timing ? { timing } : {}),
    ...(slowestPhase ? { slowestPhase } : {}),
    attempts: row.failedAttempts ?? 1,
    maxAttempts: SOURCE_MAX_FAILED_ATTEMPTS,
    ...(row.lastFailureAt !== undefined ? { at: new Date(row.lastFailureAt).toISOString() } : {}),
    ...(row.retryAt !== undefined ? { retryAt: new Date(row.retryAt).toISOString() } : {}),
  };
}
