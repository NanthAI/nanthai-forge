// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import { workLockWaitMs } from './work-lock.js';

/** Receipt-reconciled phases retain their command and operation ID. FIFO lock
 * admission can advance metadata on every turn, so retry revision races for the
 * configured patience window instead of exhausting a handful of immediate turns. */
export async function retryWorkPhase<T>(
  operationId: string,
  run: () => T | Promise<T>,
  codes = ['WORK_BUSY', 'WORK_STALE'],
): Promise<T> {
  // Keep the existing short phase reconciliation window for explicit fast-busy
  // callers; owner/Lane lock admission itself still honours waitMs:0 immediately.
  let end: number | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof ForgeError && codes.includes(error.code))) throw error;
      // Time spent in the initial phase is not contention wait.
      end ??= Date.now() + (workLockWaitMs() || 1000);
      if (Date.now() >= end)
        throw new ForgeError(
          error.code,
          `${error.message} Retry the original operation ${operationId} to reconcile its retained outcome.`,
          error.retryAt,
        );
      const backoff = Math.min(25 * 2 ** Math.min(attempt, 5), 500);
      const delay = Math.min(backoff * (0.5 + Math.random() * 0.5), end - Date.now());
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
