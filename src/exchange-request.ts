// SPDX-License-Identifier: Apache-2.0
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
  const attempts = (options.retries ?? 3) + 1;
  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController();
    // Abort only unfinished requests. The Convex runtime fails the whole action
    // asynchronously ("not in a state that permits close") when a completed
    // response stream is aborted, so a try/catch here cannot contain it.
    let completed = false;
    const release = () => {
      if (!completed) controller.abort();
    };
    let idle: ReturnType<typeof setTimeout> | undefined;
    let expire: (error: ForgeError) => void;
    const deadline = new Promise<never>((_, reject) => {
      expire = reject;
    });
    const timeout = (kind: string, ms: number) => {
      expire(
        new ForgeError(
          'EXCHANGE_REQUEST_TIMEOUT',
          `${call} timed out (${kind}, ${ms} ms; attempt ${attempt}/${attempts}). Retry the original operation to reconcile its outcome.`,
        ),
      );
      release();
    };
    function armIdle(ms: number, kind: string) {
      clearTimeout(idle);
      idle = setTimeout(() => timeout(kind, ms), ms);
    }
    const progressed = () => {
      if (!controller.signal.aborted) armIdle(options.idleTimeoutMs ?? 30_000, 'body idle');
    };
    const request = async () => {
      observeExchangeRequest(url, init);
      const response = await fetch(url, { ...init, signal: controller.signal });
      progressed();
      if (
        (response.status === 429 || (response.status >= 500 && response.status !== 560)) &&
        attempt < attempts
      ) {
        await response.body?.cancel();
        completed = true;
        return { retry: true as const };
      }
      const value = await consume(response, progressed);
      completed = true;
      return { retry: false as const, value };
    };
    armIdle(options.headerTimeoutMs ?? 30_000, 'response headers');
    const totalMs = options.totalTimeoutMs ?? 120_000,
      totalTimer = setTimeout(() => timeout('total request', totalMs), totalMs);
    try {
      const result = await Promise.race([request(), deadline]);
      if (!result.retry) return result.value;
    } catch (error) {
      // Validation/authority failures are final, rather than transport retries.
      if (error instanceof ForgeError && error.code !== 'EXCHANGE_REQUEST_TIMEOUT') throw error;
      if (attempt >= attempts)
        throw error instanceof ForgeError
          ? error
          : new ForgeError(
              'EXCHANGE_REQUEST_FAILED',
              `${call} failed after ${attempts} attempts. Retry the original operation to reconcile its outcome.`,
            );
    } finally {
      clearTimeout(idle);
      clearTimeout(totalTimer);
      release();
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
