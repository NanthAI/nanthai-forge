// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';

// Scheduling windows, never limits on retained Work or the operation's total work.
export const LONG_ACTION_BUDGET_MS = 4 * 60_000;
export const LONG_ACTION_DEADLINE_MS = 7 * 60_000;
export const LONG_ACTION_STALLED_CALLS = 5;
export const longActionExpired = (started: number) => Date.now() - started >= LONG_ACTION_BUDGET_MS;

/** Elapsed time, ETA and invocation/read accounting are not committed progress. */
export function pendingProgressGuard(phase: string, operationId: string) {
  let previous: string | undefined,
    unchanged = 0;
  return (progress?: string) => {
    let position: unknown = progress ?? null;
    if (progress) {
      try {
        const value = JSON.parse(progress);
        position = Object.fromEntries(
          ['phase', 'step', 'done', 'total', 'itemDone', 'itemTotal', 'itemPending', 'rowsPending', 'cursor']
            .filter(key => value[key] !== undefined)
            .map(key => [key, value[key]]),
        );
      } catch {
        /* Older endpoints may send plain progress text. */
      }
    }
    const current = JSON.stringify(position);
    unchanged = current === previous ? unchanged + 1 : 0;
    previous = current;
    if (unchanged >= LONG_ACTION_STALLED_CALLS)
      throw new ForgeError(
        'EXCHANGE_ACTION_STALLED',
        `${phase} made no committed progress across ${LONG_ACTION_STALLED_CALLS + 1} calls (operation ${operationId}). Progress remains saved. Retry the original operation with the same operation ID and inputs to resume.`,
      );
  };
}

export type PendingAction = { pending: true; progress?: string };
export const isPendingAction = (value: unknown): value is PendingAction =>
  !!value && typeof value === 'object' && 'pending' in value && value.pending === true;

/** Receipt-reconciled callers retain their exact pins across scheduling windows. */
export async function continueLongAction<T>(
  phase: string,
  operationId: string,
  run: (continuation: boolean) => Promise<T | PendingAction>,
  onProgress?: (progress: string) => void,
): Promise<T> {
  const guard = pendingProgressGuard(phase, operationId);
  let continuation = false;
  while (true) {
    const result = await run(continuation);
    if (!isPendingAction(result)) return result;
    guard(result.progress);
    if (result.progress) onProgress?.(result.progress);
    continuation = true;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}
