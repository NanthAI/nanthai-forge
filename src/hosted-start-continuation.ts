// SPDX-License-Identifier: Apache-2.0
import { shellQuote } from './shell-quote.js';

/** Seconds start waits for checkout and dependency sharing once the Lane is durable (Issue d41bb6e5). */
export const START_COMPLETION_SECONDS = 300;

export type BoundedStep<T> =
  | { status: 'done'; value: T }
  | { status: 'timeout' }
  | { status: 'failed'; error: unknown };

/** Race one step against the remaining bound. The abandoned step keeps running but can no longer
 * reject unhandled; the caller reports it as incomplete and hands back the replay. */
export async function boundedStep<T>(step: Promise<T>, milliseconds: number): Promise<BoundedStep<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<BoundedStep<T>>(resolve => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), Math.max(0, milliseconds));
  });
  try {
    return await Promise.race([
      step.then(
        (value): BoundedStep<T> => ({ status: 'done', value }),
        (error): BoundedStep<T> => ({ status: 'failed', error }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The exact replay of this start: same parameters, same operation id, the intended path.
 * Replaying it reconciles the retained start and materializes the same Lane once. */
export function startContinuation(
  root: string,
  data: unknown,
  operationId: string,
  path: string,
  reason: 'stalled' | 'failed' | 'no-placement',
) {
  const replay = { ...(data as Record<string, unknown>), operationId, path, open: true };
  return {
    reason,
    path,
    command: `nforge agent ${shellQuote(root)} start ${shellQuote(JSON.stringify(replay))}`,
  };
}
