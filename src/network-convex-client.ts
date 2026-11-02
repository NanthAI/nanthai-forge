// SPDX-License-Identifier: Apache-2.0
import { getFunctionName } from 'convex/server';
import { longConvexAction } from './exchange-convex-fetch.js';
import { LONG_ACTION_DEADLINE_MS } from './long-action.js';
import { ConvexClient, ConvexHttpClient } from 'convex/browser';
import { withExchangeProgress } from './exchange-progress.js';
import { currentExchangeProgress } from './exchange-progress-hooks.js';
import { networkDeadline } from './network-fetch.js';

/** Bound the whole RPC, including the SDK's mutation queue and response decode,
 * not only fetch. Cancellation also reaches its current HTTP attempt. */
export function deadlineConvexClient(
  url: string,
  options: NonNullable<ConstructorParameters<typeof ConvexHttpClient>[1]>,
  timeoutMs = 120_000,
): ConvexHttpClient {
  return boundedClient(new ConvexHttpClient(url, options), timeoutMs);
}

/** Live subscriptions keep the enclosing observation deadline; finite RPCs and
 * cleanup on that connection use the same complete-call deadline. */
export function deadlineConvexSubscription(
  url: string,
  options: ConstructorParameters<typeof ConvexClient>[1],
) {
  return boundedClient(new ConvexClient(url, options), 120_000);
}

function boundedClient<T extends object>(client: T, timeoutMs: number): T {
  const methods = new Map<PropertyKey, { source: unknown; bound: unknown }>();
  let mutationTail = Promise.resolve();
  // Preserve the HTTP SDK's serial mutation order while entering each queued
  // request in its own cancellation context. The SDK's internal drain otherwise
  // inherits the first caller's async-local signal for every queued mutation.
  const invoke = async (
    key: PropertyKey,
    value: (...args: unknown[]) => unknown,
    target: T,
    args: unknown[],
    signal: AbortSignal,
  ) => {
    const options = args[2] as { skipQueue?: boolean } | undefined;
    if (key !== 'mutation' || !(target instanceof ConvexHttpClient) || options?.skipQueue)
      return withExchangeProgress({ signal }, () => value.apply(target, args));
    const before = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>(resolve => {
      release = resolve;
    });
    await before;
    try {
      signal.throwIfAborted();
      return await withExchangeProgress({ signal }, () =>
        value.apply(target, [args[0], args[1], { ...options, skipQueue: true }]),
      );
    } finally {
      release();
    }
  };
  return new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (methods.get(key)?.source !== value)
        methods.set(key, {
          source: value,
          bound: ['query', 'mutation', 'action', 'consistentQuery', 'close'].includes(String(key))
            ? (...args: unknown[]) =>
                networkDeadline(
                  signal => invoke(key, value as (...args: unknown[]) => unknown, target, args, signal),
                  key === 'close'
                    ? 5_000
                    : key === 'action' &&
                        timeoutMs === 120_000 &&
                        longConvexAction(getFunctionName(args[0] as never))
                      ? LONG_ACTION_DEADLINE_MS
                      : timeoutMs,
                  key === 'close' ? undefined : currentExchangeProgress()?.signal,
                  key === 'close'
                    ? 'Convex close'
                    : `Convex ${String(key)} ${getFunctionName(args[0] as never)}`,
                )
            : value.bind(target),
        });
      return methods.get(key)!.bound;
    },
  });
}
