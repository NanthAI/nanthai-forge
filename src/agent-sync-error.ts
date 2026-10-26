// SPDX-License-Identifier: Apache-2.0

/** Convex structured errors carry data; transport/unknown outcomes must remain retryable. */
export function agentSyncError(error: unknown) {
  const e = error as {
    code?: unknown;
    message?: unknown;
    data?: unknown;
    status?: number;
    name?: string;
  } | null;
  let data = e?.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      /* Not a structured application error. */
    }
  }
  const structured =
    data && typeof data === 'object' ? (data as { code?: unknown; message?: unknown }) : undefined;
  const code =
    typeof structured?.code === 'string'
      ? structured.code
      : typeof e?.code === 'string'
        ? e.code
        : e?.name === 'ArgumentValidationError' ||
            /ArgumentValidationError|validation failed/i.test(String(e?.message ?? ''))
          ? 'VALIDATION'
          : e?.status
            ? `HTTP_${e.status}`
            : e?.name === 'TimeoutError' || e?.name === 'AbortError'
              ? 'TIMEOUT'
              : 'HOSTED_SYNC_PENDING';
  const message =
    typeof structured?.message === 'string'
      ? structured.message
      : typeof e?.message === 'string'
        ? e.message
        : 'Hosted activity publication failed.';
  const transient =
    /NETWORK|TIMEOUT|TIMEDOUT|ECONN|ENOTFOUND|EAI_AGAIN|RATE|TOO_MANY|HTTP_(408|429|5\d\d)|UNAVAILABLE|AUTH|TOKEN|LOGIN|EXPIRED/.test(
      code,
    ) ||
    [
      'HOSTED_SYNC_PENDING',
      'HOSTED_ACTION_FAILED',
      'HOSTED_REQUEST_FAILED',
      'HOSTED_CONFLICT',
      'INTERNAL_ERROR',
    ].includes(code);
  return { code, message: message.slice(0, 1000), transient };
}
