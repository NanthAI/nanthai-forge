// SPDX-License-Identifier: Apache-2.0
import { setTimeout as delay } from 'node:timers/promises';

/** Codes that mean the reply is unknown or the server asked for the same payload again (a network
 * failure after the client's own attempts; a server conflict or failed request that says "retry
 * the original payload"). Without these a busy machine's one lost reply ended the worker
 * (Issue 57a557e9: EXCHANGE_REQUEST_FAILED on projectHostedCheckWorker:control). */
const transient = [
  'R2_VERIFY_FAILED',
  'R2_OBJECT_MISSING',
  'RUNNER_UNAVAILABLE',
  'EXCHANGE_REQUEST_FAILED',
  'EXCHANGE_REQUEST_TIMEOUT',
  'HOSTED_REQUEST_FAILED',
  'HOSTED_ACTION_FAILED',
  'HOSTED_CONFLICT',
];
/** Retry the same retained payload after an unknown reply. Never reconstruct an
 * event, claim, output message or byte chunk between deliveries. */
export async function deliverMacCallback<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      const failure = error as { code?: string; data?: { code?: string } };
      const code = failure.code ?? failure.data?.code;
      if (attempt >= 2 || (code && !transient.includes(code))) throw error;
      await delay(250 * (attempt + 1));
    }
  }
}
