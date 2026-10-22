// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';
import { invariant } from './errors.js';
const context = new AsyncLocalStorage<AbortSignal>();
export const withLandingWorker = <T>(signal: AbortSignal, task: () => T) => context.run(signal, task);
export const landingWorkerSignal = () => context.getStore();
export const landingWaitMs = (waitMs?: number) => (context.getStore() ? 0 : waitMs);
/** Stopping the controller never signals or cancels the submitted execution. */
export function assertLandingWorkerActive() {
  invariant(
    !context.getStore()?.aborted,
    'LANDING_WORKER_STOPPED',
    'Landing controller stopped; submitted work is retained.',
  );
}
