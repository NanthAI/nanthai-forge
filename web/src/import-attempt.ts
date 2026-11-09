// SPDX-License-Identifier: AGPL-3.0-only
export type ImportAttempt = { operationId: string; url: string; ref?: string };

/**
 * What the GitHub import form keeps after `start` threw. No code means the outcome is unknown (the
 * network dropped), so the same request and operation id are retried and the server reconciles them.
 * A server code is a refusal that was not executed: nothing started, the form is editable again and
 * the next try is a new request.
 */
export function importAttemptAfterStartError(
  attempt: ImportAttempt | null,
  code: string | undefined,
): ImportAttempt | null {
  return code === undefined ? attempt : null;
}
