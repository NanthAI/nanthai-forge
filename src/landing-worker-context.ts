// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';
import { withOwnerChecks } from './check-execution-context.js';
import { withWorkLockOptions } from './work-lock.js';
import { invariant } from './errors.js';
const context = new AsyncLocalStorage<AbortSignal>();
const controller = new AsyncLocalStorage<boolean>();
export const withLandingController = <T>(run: () => T) => controller.run(true, run);
export const landingController = () => controller.getStore() === true || !!context.getStore();
export const withLandingWorker = <T>(signal: AbortSignal, task: () => T) =>
  context.run(signal, () =>
    withWorkLockOptions({ nonblocking: true, cancelled: () => signal.aborted }, () => withOwnerChecks(task)),
  );
export const landingWorkerSignal = () => context.getStore();
/** Execution handoff outlives the driver that registered it. */
export const withoutLandingWorker = <T>(task: () => T) => context.exit(task);
export const landingWaitMs = (waitMs?: number) => (context.getStore() ? 0 : waitMs);
/** Stopping the controller never signals or cancels the submitted execution. */
export function assertLandingWorkerActive() {
  invariant(
    !context.getStore()?.aborted,
    'LANDING_WORKER_STOPPED',
    'Landing controller stopped; submitted work is retained.',
  );
}
