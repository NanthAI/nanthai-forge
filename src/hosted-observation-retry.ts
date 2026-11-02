// SPDX-License-Identifier: Apache-2.0
import { withExchangeProgress } from './exchange-progress.js';
import { hostedActionError } from './hosted-action-error.js';

const transient = new Set([
  'EXCHANGE_REQUEST_FAILED',
  'EXCHANGE_REQUEST_TIMEOUT',
  'HOSTED_ACTION_FAILED',
  'HOSTED_REQUEST_FAILED',
  'HOSTED_CONFLICT',
]);
export type ObservationStop = 'timeout' | 'cancelled';
/** Active read waits only. A transport failure says nothing about the retained
 * operation. Retry no faster than the existing two-second observation fallback;
 * successful waits add no calls and idle clients acquire no timers or calls. */
export async function retryHostedObservation<T>(options: {
  timeoutSeconds: number;
  signal?: AbortSignal | undefined;
  emit: (event: unknown) => void;
  attempt: (remainingSeconds: number, signal: AbortSignal) => Promise<T>;
  pending: (status: ObservationStop) => T;
}): Promise<T> {
  const controller = new AbortController();
  const end = performance.now() + options.timeoutSeconds * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay: ReturnType<typeof setTimeout> | undefined;
  let status: ObservationStop | undefined;
  let finish: (value: T) => void;
  const stop = new Promise<T>(resolve => {
    finish = resolve;
  });
  const leave = (reason: ObservationStop) => {
    if (status) return;
    status = reason;
    controller.abort();
    finish(options.pending(reason));
  };
  const cancel = () => leave('cancelled');
  const expire = () => {
    const remaining = end - performance.now();
    if (remaining <= 0) leave('timeout');
    else timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  // A zero wait keeps its finite initial read, without subscribing or retrying.
  if (options.timeoutSeconds > 0) expire();
  try {
    for (let attempt = 0; !status; attempt++) {
      try {
        const result = await Promise.race([
          withExchangeProgress({ signal: controller.signal }, () =>
            options.attempt(Math.max(0, (end - performance.now()) / 1000), controller.signal),
          ),
          stop,
        ]);
        return status ? options.pending(status) : result;
      } catch (error) {
        if (status) return options.pending(status);
        const normalized = hostedActionError(error, 'observation');
        if (!transient.has(normalized.code)) throw error;
        if (!options.timeoutSeconds || performance.now() >= end) return options.pending('timeout');
        const retryAfterMs = Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4));
        options.emit({
          type: 'observation-retry',
          code: normalized.code,
          attempt: attempt + 1,
          retryAfterMs,
          message: 'Observation unavailable; the operation is still in progress. Continuing to wait.',
        });
        await Promise.race([
          new Promise<void>(resolve => {
            delay = setTimeout(resolve, retryAfterMs);
          }),
          stop,
        ]);
      }
    }
    return options.pending(status!);
  } finally {
    controller.abort();
    clearTimeout(timer);
    clearTimeout(delay);
    options.signal?.removeEventListener('abort', cancel);
  }
}
