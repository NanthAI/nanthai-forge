// SPDX-License-Identifier: Apache-2.0
import { hostedActionError } from './hosted-action-error.js';
import { ForgeError } from './errors.js';

const retryable = new Set([
  'WORK_BUSY',
  'WORK_CHANGED_DURING_PUSH',
  'HOSTED_CONFLICT',
  'HOSTED_ACTION_FAILED',
  'HOSTED_REQUEST_FAILED',
  'LEGACY_STORAGE_WRITES_PAUSED',
]);
/** Refused writes that end on their own: nothing was committed, so the same
 * request (same operation ID) reconciles once writes return (Issue 72d50375). */
export const transientWriteCodes = [
  'LEGACY_STORAGE_WRITES_PAUSED',
  'HOSTED_CONFLICT',
  'EXCHANGE_REQUEST_TIMEOUT',
  'EXCHANGE_REQUEST_FAILED',
];
/** Marks a transient refusal retryable with when and how to retry; returns null otherwise. */
export function retryableExchangeError(error: ForgeError, operationId?: string | null) {
  if (!transientWriteCodes.includes(error.code)) return null;
  const retryAt = error.retryAt && error.retryAt > Date.now() ? error.retryAt : undefined;
  const when = retryAt ? `after ${new Date(retryAt).toISOString()}` : 'in a moment';
  const reason =
    error.code === 'LEGACY_STORAGE_WRITES_PAUSED'
      ? 'Forge is not accepting writes during approved maintenance'
      : 'Forge could not accept this write right now';
  return new ForgeError(
    error.code,
    `${reason}; nothing was changed. Retry the same command ${when}${operationId ? ` (operation ${operationId})` : ''}. ${error.message}`,
    retryAt,
    { retryable: true, ...(retryAt ? { retryAt: new Date(retryAt).toISOString() } : {}) },
  );
}
/** Only use for receipt-reconciled mutations or reads. The closure must retain
 * its original operation ID and payload across every attempt, including unknown replies. */
export async function retryExchange<T>(
  phase: string,
  operationId: string,
  task: () => Promise<T>,
  options: {
    retries?: number;
    delayMs?: number;
    localSnapshot?: boolean;
    retryCodes?: string[];
    /** Longest single wait for a refusal that names its end (a write pause). */
    maxWaitMs?: number;
  } = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (failure) {
      let error = hostedActionError(failure, phase);
      if (
        options.localSnapshot &&
        ['WORK_STALE', 'SOURCE_CHANGED', 'EXCHANGE_SOURCE_CHANGED'].includes(error.code)
      )
        error = new ForgeError(
          'WORK_CHANGED_DURING_PUSH',
          `Local Work changed during ${phase}. Prepared operation ${operationId} bytes and any uploaded checkpoint remain retained. Retry to reconcile its receipt; if the snapshot was never prepared, start a push from the current Work revision.`,
        );
      if (!retryable.has(error.code) && !options.retryCodes?.includes(error.code)) throw error;
      const backoff = (options.delayMs ?? 100) * 2 ** attempt;
      const until = error.retryAt ? error.retryAt - Date.now() : 0;
      if (attempt >= retries || until > (options.maxWaitMs ?? 60_000))
        throw (
          retryableExchangeError(error, operationId) ??
          new ForgeError(
            error.code,
            `${error.message} ${phase} stopped after ${attempt + 1} attempts (operation ${operationId}). Retry the original operation to reconcile its outcome.`,
            error.retryAt,
          )
        );
      await new Promise(resolve => setTimeout(resolve, Math.max(backoff, until)));
    }
  }
}
