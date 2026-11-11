// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerRpcAttemptObserver } from './exchange-observation-hooks.js';

export type CheckoutPrepObservation = {
  /** Includes command RPCs before checkout; excludes later dependency linking and bookkeeping. */
  scope: 'command-through-checkout';
  /** Process monotonic origin through hosted CLI dispatch; null for direct library callers. */
  startupMs: number | null;
  /** Actual HTTP attempts, including retries; SDK calls cancelled while queued send none. */
  rpcAttempts: number;
  /** Complete SDK calls, including its queue, retries and response decode. Walls may overlap. */
  rpc: { name: string; calls: number; wallMs: number; failed: number }[];
};
const current = new AsyncLocalStorage<CheckoutPrepObservation>();
registerRpcAttemptObserver(() => {
  const value = current.getStore();
  if (value) value.rpcAttempts++;
});
export function checkoutPrepObservation(): CheckoutPrepObservation | undefined {
  const value = current.getStore();
  return (
    value && {
      scope: value.scope,
      startupMs: value.startupMs,
      rpcAttempts: value.rpcAttempts,
      rpc: value.rpc.map(row => ({ ...row })),
    }
  );
}
/** Executable agent commands start before freshness checks, which can make RPCs. */
export function beginCheckoutPrepObservation() {
  current.enterWith({ scope: 'command-through-checkout', startupMs: null, rpcAttempts: 0, rpc: [] });
}
/** Nested checkouts share their command's observation. There are no timers, I/O or idle work. */
export function withCheckoutPrepObservation<T>(run: () => Promise<T>, startupMs: number | null = null) {
  const held = current.getStore();
  if (held) {
    if (startupMs !== null) held.startupMs ??= startupMs;
    return run();
  }
  return current.run({ scope: 'command-through-checkout', startupMs, rpcAttempts: 0, rpc: [] }, run);
}
export async function measureCheckoutRpc<T>(name: string, run: () => Promise<T>): Promise<T> {
  const value = current.getStore();
  if (!value) return run();
  let row = value.rpc.find(row => row.name === name);
  if (!row) value.rpc.push((row = { name, calls: 0, wallMs: 0, failed: 0 }));
  row.calls++;
  const start = performance.now();
  try {
    return await run();
  } catch (error) {
    row.failed++;
    throw error;
  } finally {
    row.wallMs += performance.now() - start;
  }
}
