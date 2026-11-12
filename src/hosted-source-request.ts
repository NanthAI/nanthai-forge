// SPDX-License-Identifier: Apache-2.0
import { hostedActionError } from './hosted-action-error.js';
/** A caller deadline says nothing about server completion. The operation was
 * prepared before submit: subscribe to that exact receipt, never submit new work.
 * A successful call does no reconciliation I/O. */
export async function reconcileSourceRequest<T>(
  operationId: string,
  submit: () => Promise<T>,
  wait: () => Promise<T>,
): Promise<T> {
  try {
    return await submit();
  } catch (error) {
    if (hostedActionError(error, 'source submit').code !== 'EXCHANGE_REQUEST_TIMEOUT') throw error;
    console.error(
      JSON.stringify({
        type: 'source-request-reconcile',
        operationId,
        message: 'Request window ended; waiting on the original server operation.',
      }),
    );
    return wait();
  }
}
