// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { renewableDevice } from './deployment-origin.js';
import { measureCheckoutRpc } from './checkout-prep-observation.js';
import { getFunctionName } from 'convex/server';
import { longConvexAction } from './long-action.js';
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

/** Which surface of this CLI process makes its calls, for the spend ledger's caller kind
 * (convex/cliServer.ts logCaller): agent commands declare `agent`; a person's own commands send
 * nothing and count as `cli`. A label for metering only, never an authority. */
const declaredCaller: 'agent' | undefined =
  ['agent', 'x', 'mcp'].includes(process.argv[2]!) || process.env.FORGE_HELD_LAND_WORKER === '1'
    ? 'agent'
    : undefined;
/** A deployment older than the caller field (or a function outside the guarded builders) refuses
 * the extra argument in argument validation, before any handler runs; only that exact refusal sends
 * the call again without it. */
const callerRefusal = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /ArgumentValidationError/.test(message) && /extra field `forgeCaller`/.test(message);
};
const withCaller = (args: unknown[]) => [
  args[0],
  { ...((args[1] as object | undefined) ?? {}), forgeCaller: declaredCaller },
  ...args.slice(2),
];

function boundedClient<T extends object>(client: T, timeoutMs: number): T {
  const methods = new Map<PropertyKey, { source: unknown; bound: unknown }>();
  const undeclared = new Set<string>();
  /** Send the declared caller, once per function falling back to the untagged form on refusal. */
  const declare = async (name: string, args: unknown[], run: (args: unknown[]) => unknown) => {
    if (!declaredCaller || !name || undeclared.has(name)) return run(args);
    try {
      return await run(withCaller(args));
    } catch (error) {
      if (!callerRefusal(error)) throw error;
      undeclared.add(name);
      return run(args);
    }
  };
  let mutationTail = Promise.resolve();
  let credential: string | undefined;
  const refreshed = async (token: string | undefined) => {
    const saved = renewableDevice(token);
    if (!saved || saved.expiresAt > Date.now()) return token;
    return (await (await import('./device-key.js')).renewDevice(saved.deployment)).token;
  };
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
    const saved = renewableDevice(credential);
    if (key !== 'close' && saved && saved.expiresAt <= Date.now() && target instanceof ConvexHttpClient) {
      const token = await refreshed(credential);
      if (token !== credential) {
        target.setAuth(token!);
        credential = token;
      }
    }
    const options = args[2] as { skipQueue?: boolean } | undefined,
      name = key === 'close' ? '' : getFunctionName(args[0] as never),
      run = (sent: unknown[]) => value.apply(target, sent);
    if (key !== 'mutation' || !(target instanceof ConvexHttpClient) || options?.skipQueue)
      return withExchangeProgress({ signal }, () => declare(name, args, run));
    const before = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>(resolve => {
      release = resolve;
    });
    await before;
    try {
      signal.throwIfAborted();
      // A refused tagged attempt and its untagged retry both run inside this queue slot.
      return await withExchangeProgress({ signal }, () =>
        declare(name, [args[0], args[1], { ...options, skipQueue: true }], run),
      );
    } finally {
      release();
    }
  };
  return new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (key === 'clearAuth')
        return (...args: unknown[]) => {
          credential = undefined;
          return value.apply(target, args);
        };
      if (key === 'setAuth')
        return (auth: string | (() => Promise<string | null>), ...rest: unknown[]) => {
          if (typeof auth === 'string') {
            credential = auth;
            return value.call(target, auth, ...rest);
          }
          return value.call(
            target,
            async () => (await refreshed((await auth()) ?? undefined)) ?? null,
            ...rest,
          );
        };
      // Live reads (agent waits and observers) carry the declared caller too; a refusal arrives as the
      // subscription's error, and the same subscription restarts untagged.
      if (key === 'onUpdate' && declaredCaller)
        return (query: unknown, args: unknown, onUpdate: unknown, onError?: (error: Error) => void) => {
          const name = getFunctionName(query as never);
          const subscribe = (tag: boolean): (() => void) =>
            value.call(target, query, tag ? withCaller([query, args])[1] : args, onUpdate, (error: Error) => {
              if (!tag || !callerRefusal(error)) return onError?.(error);
              undeclared.add(name);
              current();
              current = subscribe(false);
            });
          let current = subscribe(!undeclared.has(name));
          return () => current();
        };
      if (methods.get(key)?.source !== value)
        methods.set(key, {
          source: value,
          bound: ['query', 'mutation', 'action', 'consistentQuery', 'close'].includes(String(key))
            ? (...args: unknown[]) => {
                const name = key === 'close' ? '' : getFunctionName(args[0] as never);
                const call = () =>
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
                    key === 'close' ? 'Convex close' : `Convex ${String(key)} ${name}`,
                  );
                return key === 'close' ? call() : measureCheckoutRpc(name, call);
              }
            : value.bind(target),
        });
      return methods.get(key)!.bound;
    },
  });
}
