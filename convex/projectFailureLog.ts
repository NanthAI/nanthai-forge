// SPDX-License-Identifier: Apache-2.0
// Failure log (Item 2c420916). A failed operation (save, compose, sync,
// check, cancel, ...) or a failed landing appends one bounded row in the mutation that settles it, so
// the cause outlives Convex's short function logs. The healthy path reads and writes nothing here, an
// idle project costs nothing. The health report reads it on demand (convex/projectFailureReport.ts).
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { scrubText } from '../src/client-error-text';
import {
  FAILURE_ERROR_CHARS,
  FAILURE_FILES_KEPT,
  FAILURE_FILE_CHARS,
  FAILURE_STEP_CHARS,
  checkFailureCodes,
  messageDetail,
  type FailureDetail,
} from '../src/failure-noise';

/** Most characters of a failure message kept. */
export const FAILURE_MESSAGE_MAX = 240;
export type FailureRecord = FailureDetail & {
  schema: 1;
  kind: 'operation' | 'landing';
  code: string;
  message: string;
  /** From the operation's first attempt (or the landing's submission) to the failure; null when unknown. */
  elapsedMs: number | null;
};

/** Endings someone chose (a cancel, an abandoned Lane, a superseded landing) are not failures: nothing is
 * logged and nothing is read for them. */
const chosenEndings = new Set([
  'CANCELLED',
  'LANDING_CANCELLED',
  'LANDING_SUPERSEDED',
  'CHECK_CANCELLED',
  'SOURCE_JOB_CANCELLED',
  'RECOVERY_SUPERSEDED',
]);

const sanitize = (text: string, max: number) =>
  scrubText(
    text
      .replace(/\s+/g, ' ')
      .replace(/\/(?:Users|home)\/[^/\s]+/g, '~')
      .trim(),
    max,
  );
/** One line, scrubbed by the shared client-error rules (URL queries, tokens), home folder names removed. */
export const sanitizeFailureMessage = (text: string) => sanitize(text, FAILURE_MESSAGE_MAX);

/**
 * The bounded detail a failed check keeps (Item 44f2b109): its failing test files and first error from the
 * summary the landing already holds, else the failing job step its settled message names. Pure; reads
 * nothing. Only check failures carry it (the message alone says enough for any other code).
 */
export function failureDetail(state: {
  testFiles?:
    | { counts: { failed: number }; failed: { file: string; report: { firstError?: string | undefined } }[] }
    | undefined;
  error: { code: string; message: string };
}): FailureDetail {
  if (!checkFailureCodes.has(state.error.code)) return {};
  const failed = state.testFiles?.failed ?? [];
  if (failed.length) {
    const files = failed.slice(0, FAILURE_FILES_KEPT).map(item => sanitize(item.file, FAILURE_FILE_CHARS));
    const first = failed[0]!.report.firstError;
    const more = Math.max(failed.length, state.testFiles!.counts.failed) - files.length;
    return {
      files,
      ...(more > 0 ? { more } : {}),
      ...(first ? { error: sanitize(first, FAILURE_ERROR_CHARS) } : {}),
    };
  }
  // A run that named no file: its job and line, as the message sentence carries them.
  const step = messageDetail(state.error.message).step;
  return step ? { step: sanitize(step, FAILURE_STEP_CHARS) } : {};
}

/**
 * Append one failure row unless this operation already has one (a replayed settle writes nothing).
 * Called only on the failure branch: one indexed read and one insert per failure.
 */
export async function recordFailure(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    operationId: string;
    kind: FailureRecord['kind'];
    error: { code: string; message: string };
    startedAt?: string | undefined;
    detail?: FailureDetail | undefined;
  },
) {
  if (chosenEndings.has(input.error.code)) return false;
  const old = await ctx.db
    .query('projectFailures')
    .withIndex('by_project_and_operation', q =>
      q.eq('projectId', input.projectId).eq('operationId', input.operationId),
    )
    .first();
  if (old) return false;
  const started = input.startedAt ? Date.parse(input.startedAt) : NaN;
  const record: FailureRecord = {
    schema: 1,
    kind: input.kind,
    code: input.error.code.slice(0, 80),
    message: sanitizeFailureMessage(input.error.message),
    elapsedMs: Number.isFinite(started) ? Math.max(0, Date.now() - started) : null,
    ...input.detail,
  };
  await ctx.db.insert('projectFailures', {
    projectId: input.projectId,
    operationId: input.operationId,
    value: JSON.stringify(record),
  });
  return true;
}
