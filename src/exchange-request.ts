import { networkFetch, networkFailure, networkDeadline, networkCancellation } from './network-fetch.js';
// SPDX-License-Identifier: Apache-2.0
import { currentExchangeProgress } from './exchange-progress-hooks.js';
import { ForgeError } from './errors.js';
import { observeExchangeRequest, observeExchangeResponse } from './exchange-observation-hooks.js';

export type ExchangeRequestOptions = {
  retries?: number;
  delayMs?: number;
  headerTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  onBytes?: ((done: number, total?: number) => void) | undefined;
};

/** Consume the response inside the deadline. Readers call progressed after each
 * nonempty chunk; their complete read (or deliberate cancellation) is retried.
 * Call names are fixed labels, never URLs, credentials or server response text. */
export async function exchangeRequest<T>(
  call: string,
  url: string | URL | Request,
  init: RequestInit,
  consume: (response: Response, progressed: () => void) => Promise<T>,
  options: ExchangeRequestOptions = {},
): Promise<T> {
  const scope = currentExchangeProgress();
  const signals = [scope?.signal, init.signal].filter((value): value is AbortSignal => !!value);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  const attempts = (options.retries ?? 3) + 1;
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw networkCancellation(signal);
    scope?.progress?.(call, false);
    const started = performance.now();
    let response: Response | undefined;
    try {
      const result = await networkDeadline(
        async deadlineSignal => {
          observeExchangeRequest(url, init);
          response = await networkFetch(url, { ...init, signal: deadlineSignal }, { ...options, retries: 0 });
          if (
            (response.status === 429 || (response.status >= 500 && response.status !== 560)) &&
            attempt < attempts
          )
            return { retry: true as const };
          return { retry: false as const, value: await consume(response, () => scope?.progress?.(call)) };
        },
        options.totalTimeoutMs ?? 120_000,
        signal,
      );
      if (!result.retry) return result.value;
    } catch (failure) {
      if (signal?.aborted) throw networkCancellation(signal);
      let error = failure;
      if (networkFailure(error) && error.code === 'EXCHANGE_REQUEST_TIMEOUT') {
        const total = options.totalTimeoutMs ?? 120_000;
        const kind =
          performance.now() - started >= total
            ? 'total request'
            : response
              ? 'body idle'
              : 'response headers';
        error = new ForgeError(
          'EXCHANGE_REQUEST_TIMEOUT',
          `${call} timed out (${kind}; attempt ${attempt}/${attempts}). Retry the original operation to reconcile its outcome.`,
        );
      }
      if (error instanceof ForgeError && !networkFailure(error)) throw error;
      if (attempt >= attempts)
        throw error instanceof ForgeError
          ? error
          : new ForgeError(
              'EXCHANGE_REQUEST_FAILED',
              `${call} failed after ${attempts} attempts. Retry the original operation to reconcile its outcome.`,
            );
    } finally {
      if (response?.body && !response.bodyUsed && !response.body.locked)
        void response.body.cancel().catch(() => {});
    }
    await new Promise(resolve => setTimeout(resolve, (options.delayMs ?? 100) * 2 ** (attempt - 1)));
  }
}

/** Buffer JSON/object responses before handing them to the client, so a stalled
 * body cannot outlive its timer. Range readers use exchangeRequest directly. */
export function exchangeFetch(
  call: string,
  url: string | URL | Request,
  init: RequestInit = {},
  options: ExchangeRequestOptions = {},
): Promise<Response> {
  return exchangeRequest(
    call,
    url,
    init,
    async (response, progressed) => {
      const total = Number(response.headers.get('content-length')) || undefined;
      let done = 0;
      options.onBytes?.(done, total);
      if (!response.body) return response;
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          if (!part.value.length) continue;
          chunks.push(part.value);
          done += part.value.length;
          observeExchangeResponse(part.value.length);
          progressed();
          options.onBytes?.(done, total);
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      // Reuse the received chunks; constructing a Response from a byte array
      // would copy the complete object again before its caller consumes it.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
    options,
  );
}
