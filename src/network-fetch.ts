// SPDX-License-Identifier: Apache-2.0
import { currentExchangeProgress } from './exchange-progress-hooks.js';
import { ForgeError } from './errors.js';

const callerDeadlines = new WeakMap<AbortSignal, number>();
/** Retain an existing caller-selected HTTP budget without letting the default
 * header/total deadlines silently shorten it. The native signal still cancels. */
export function networkTimeout(ms: number): AbortSignal {
  const signal = AbortSignal.timeout(ms);
  callerDeadlines.set(signal, performance.now() + ms);
  return signal;
}

export type NetworkOptions = {
  headerTimeoutMs?: number | undefined;
  idleTimeoutMs?: number | undefined;
  totalTimeoutMs?: number | undefined;
  retries?: number | undefined;
  delayMs?: number | undefined;
  request?: typeof fetch | undefined;
};
/** Transport faults remain platform errors in portable server consumers, so a
 * source worker never mistakes a deadline for deterministic source invalidity. */
export class NetworkTransportError extends Error {
  constructor(
    readonly code: 'EXCHANGE_REQUEST_TIMEOUT' | 'EXCHANGE_REQUEST_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'NetworkTransportError';
  }
}
export const networkFailure = (error: unknown): error is ForgeError | NetworkTransportError =>
  (error instanceof ForgeError || error instanceof NetworkTransportError) &&
  ['EXCHANGE_REQUEST_TIMEOUT', 'EXCHANGE_REQUEST_FAILED'].includes(error.code);

export function networkCancellation(signal?: AbortSignal | null) {
  const reason = signal?.reason ?? new ForgeError('CANCELLED', 'Network request cancelled.');
  return reason instanceof Error && reason.name === 'TimeoutError'
    ? new NetworkTransportError('EXCHANGE_REQUEST_TIMEOUT', 'Network request caller deadline reached.')
    : reason;
}

/** A deadline must reject even when a transport ignores AbortSignal. The signal
 * stops the socket; the race stops its caller. Never include URLs or payloads. */
export async function networkDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number,
  signal?: AbortSignal | null,
  label = 'Network request',
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => {
      reject(networkCancellation(signal));
      controller.abort();
    };
    timer = setTimeout(() => {
      reject(new NetworkTransportError('EXCHANGE_REQUEST_TIMEOUT', `${label} deadline reached (${ms} ms).`));
      controller.abort();
    }, ms);
  });
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) throw networkCancellation(signal);
    return await Promise.race([operation(controller.signal), stopped]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/** Shared streaming HTTP boundary for CLI/MCP and portable consumers. Retries
 * before response delivery are safe for reads only unless explicitly selected.
 * Once bytes are exposed, the owning pinned operation handles any replay. */
export async function networkFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  options: NetworkOptions = {},
): Promise<Response> {
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const retries =
    options.retries ??
    currentExchangeProgress()?.networkRetries ??
    (['GET', 'HEAD'].includes(method) ? 3 : 0);
  const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
  const declaredDeadline = signal ? callerDeadlines.get(signal) : undefined;
  const signals = [
    ...new Set([signal, currentExchangeProgress()?.signal].filter((value): value is AbortSignal => !!value)),
  ];
  const aborted = () => signals.find(value => value.aborted);
  const request = options.request ?? fetch;
  for (let attempt = 0; ; attempt++) {
    const stopped = aborted();
    if (stopped) throw networkCancellation(stopped);
    const controller = new AbortController();
    let abortBody: (() => void) | undefined;
    const cancel = () => {
      controller.abort(aborted()?.reason);
      abortBody?.();
    };
    for (const source of signals) source.addEventListener('abort', cancel, { once: true });
    const end =
      options.totalTimeoutMs === undefined && declaredDeadline !== undefined
        ? declaredDeadline
        : performance.now() + (options.totalTimeoutMs ?? 120_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const cleanup = (abort = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const source of signals) source.removeEventListener('abort', cancel);
      if (abort) controller.abort();
      if (reader) {
        void reader.cancel().catch(() => {});
        // Cancel settles pending reads synchronously; release the underlying
        // stream even when its asynchronous cancellation is still finishing.
        reader.releaseLock();
      }
    };
    const remaining = (ms: number) => Math.max(0, Math.ceil(Math.min(ms, end - performance.now())));
    try {
      const response = await networkDeadline(
        deadlineSignal => {
          // Both caller cancellation and the header deadline stop this socket.
          const abort = () => controller.abort(deadlineSignal.reason);
          deadlineSignal.addEventListener('abort', abort, { once: true });
          // Injected transports may answer synchronously; normalize before chaining.
          return Promise.resolve(request(input, { ...init, signal: controller.signal })).finally(() =>
            deadlineSignal.removeEventListener('abort', abort),
          );
        },
        remaining(
          options.headerTimeoutMs ??
            (declaredDeadline === undefined ? 30_000 : declaredDeadline - performance.now()),
        ),
        controller.signal,
      );
      if (
        (response.status === 429 || (response.status >= 500 && response.status !== 560)) &&
        attempt < retries
      ) {
        void response.body?.cancel().catch(() => {});
        cleanup();
      } else if (!response.body) {
        cleanup();
        return response;
      } else {
        reader = response.body.getReader();
        let streamController: ReadableStreamDefaultController<Uint8Array>;
        const expired = (
          error: unknown = new NetworkTransportError(
            'EXCHANGE_REQUEST_TIMEOUT',
            'Network response body deadline reached.',
          ),
        ) => {
          if (finished) return;
          streamController.error(error);
          cleanup(true);
        };
        abortBody = () => expired(networkCancellation(aborted()));
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(expired, remaining(options.idleTimeoutMs ?? 30_000));
          (timer as unknown as { unref?: () => void }).unref?.();
        };
        const body = new ReadableStream<Uint8Array>(
          {
            start(stream) {
              streamController = stream;
              arm();
            },
            async pull(stream) {
              // A waiting consumer owns a live deadline even for synthetic or
              // buffered streams that have no socket keeping Node alive.
              (timer as unknown as { ref?: () => void } | undefined)?.ref?.();
              try {
                const part = await reader!.read();
                if (finished) return;
                if (part.done) {
                  cleanup();
                  stream.close();
                } else {
                  arm();
                  stream.enqueue(part.value);
                }
              } catch (error) {
                if (!finished) {
                  stream.error(error);
                  cleanup(true);
                }
              }
            },
            cancel() {
              cleanup(true);
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
    } catch (error) {
      cleanup(true);
      const stopped = aborted();
      if (stopped) throw networkCancellation(stopped);
      if (error instanceof ForgeError && !networkFailure(error)) throw error;
      if (attempt >= retries) {
        if (networkFailure(error)) throw error;
        throw new NetworkTransportError(
          'EXCHANGE_REQUEST_FAILED',
          'Network request failed; replay the original operation to reconcile its outcome.',
        );
      }
    }
    await networkDeadline(
      () => new Promise(resolve => setTimeout(resolve, (options.delayMs ?? 100) * 2 ** attempt)),
      30_000,
      signal,
    );
  }
}
