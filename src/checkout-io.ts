// SPDX-License-Identifier: Apache-2.0
import { availableParallelism } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mapExchange } from './exchange-parallel.js';

/** Local dispatch follows the Node filesystem pool; the shared host budget
 * allows one kernel filesystem worker per OS-assigned CPU, across all processes. */
export const checkoutVolumeCapacity = () => availableParallelism();
export function checkoutIoCapacity() {
  const configured = Number(process.env.UV_THREADPOOL_SIZE ?? 4);
  return Number.isInteger(configured) && configured > 0 ? Math.min(1024, configured) : 4;
}
export type CheckoutIoPhase = 'copy' | 'durability';
export type CheckoutIoExecutor = <T>(run: () => Promise<T>, phase: CheckoutIoPhase) => Promise<T>;
const budget = new AsyncLocalStorage<CheckoutIoExecutor>();
export function withCheckoutIo<T>(executor: CheckoutIoExecutor, run: () => Promise<T>) {
  return budget.run(executor, run);
}
export const checkoutIoActive = () => budget.getStore() !== undefined;
export function checkoutIo<T>(run: () => Promise<T>, phase: CheckoutIoPhase = 'copy'): Promise<T> {
  return budget.getStore()?.(run, phase) ?? run();
}
/** Producers retain the existing bounded lookahead; permits cover actual work. */
export function mapCheckoutIo<T, R>(
  items: readonly T[],
  run: (item: T, index: number) => Promise<R>,
  phase: CheckoutIoPhase = 'copy',
) {
  return mapExchange(items, 16, (item, index) => checkoutIo(() => run(item, index), phase));
}
