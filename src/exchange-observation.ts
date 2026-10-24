// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { registerExchangeObserver } from './exchange-observation-hooks.js';

export const exchangeObservationSchema = z.object({
  scope: z.literal('this-process-attempt'),
  startedAt: z.string(),
  elapsedMs: z.number().nonnegative(),
  measured: z.object({
    requests: z.number().nonnegative(),
    rpcRequests: z.number().nonnegative(),
    requestBodyBytes: z.number().nonnegative(),
    responseBodyBytes: z.number().nonnegative(),
  }),
  estimatedUsd: z.null(),
  billedUsd: z.null(),
});
export type ExchangeObservation = z.infer<typeof exchangeObservationSchema>;
const current = new AsyncLocalStorage<{
  started: number;
  startedAt: string;
  measured: ExchangeObservation['measured'];
}>();
registerExchangeObserver(() => current.getStore()?.measured);
export function currentExchangeObservation(): ExchangeObservation | undefined {
  const value = current.getStore();
  if (!value) return;
  return {
    scope: 'this-process-attempt',
    startedAt: value.startedAt,
    elapsedMs: Math.max(0, performance.now() - value.started),
    measured: { ...value.measured },
    estimatedUsd: null,
    billedUsd: null,
  };
}
/** Actual HTTP attempts, including retries. Body bytes exclude headers/TLS and
 * server-internal work; they are observations, never a dollar estimate. */
export async function withExchangeObservation<T>(run: () => Promise<T>) {
  const started = performance.now(),
    startedAt = new Date().toISOString(),
    measured = { requests: 0, rpcRequests: 0, requestBodyBytes: 0, responseBodyBytes: 0 };
  return current.run({ started, startedAt, measured }, async () => ({
    value: await run(),
    observation: currentExchangeObservation()!,
  }));
}
