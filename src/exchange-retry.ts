// SPDX-License-Identifier: Apache-2.0
import { hostedActionError } from './hosted-action-error.js';
import { ForgeError } from './errors.js';

const retryable = new Set([
  'WORK_BUSY',
  'WORK_CHANGED_DURING_PUSH',
  'HOSTED_CONFLICT',
  'HOSTED_ACTION_FAILED',
  'HOSTED_REQUEST_FAILED',
]);
/** Only use for receipt-reconciled mutations or reads. The closure must retain
 * its original operation ID and payload across every attempt, including unknown replies. */
export async function retryExchange<T>(
  phase: string,
  operationId: string,
  task: () => Promise<T>,
  options: { retries?: number; delayMs?: number; localSnapshot?: boolean } = {},
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
      if (!retryable.has(error.code)) throw error;
      if (attempt >= retries)
        throw new ForgeError(
          error.code,
          `${error.message} ${phase} stopped after ${attempt + 1} attempts (operation ${operationId}). Retry the original operation to reconcile its outcome.`,
          error.retryAt,
        );
      await new Promise(resolve => setTimeout(resolve, (options.delayMs ?? 100) * 2 ** attempt));
    }
  }
}
