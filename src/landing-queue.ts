import { assertLandingWorkerActive, landingWaitMs } from './landing-worker-context.js';
// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { workProgress, workProgressIdentity } from './work-progress.js';
import { workQueueWaitMs } from './work-lock.js';
import { invariant } from './errors.js';
import { CheckQueue, queueHolder } from './check-queue.js';
import { digest } from './hash.js';
import type { WorkStore } from './work-store.js';

export type LandingPosition = { status: 'waiting to land' | 'landing'; position: number };
const held = new AsyncLocalStorage<ReadonlySet<string>>();
export const landingDirectory = (store: WorkStore, channel: string) =>
  join(store.directory, 'landing-queue', digest(channel));

/** Reuse H1's cross-process bakery tickets and kernel process identities. No Work
 * lock is held while waiting or checking. Nested acceptance reuses our slot. */
export async function withQueueSlot<T>(
  directory: string,
  task: () => Promise<T>,
  options: {
    waitMs?: number | undefined;
    observe?: (position: LandingPosition) => void;
    phase?: string;
    control?: CheckQueue;
    anchor?: string;
  } = {},
): Promise<{ value: T } | { waiting: LandingPosition }> {
  assertLandingWorkerActive();
  if (held.getStore()?.has(directory)) return { value: await task() };
  const waitMs = landingWaitMs(options.waitMs) ?? workQueueWaitMs(),
    end = Date.now() + waitMs;
  invariant(
    Number.isSafeInteger(waitMs) && waitMs >= 0,
    'BAD_ARGUMENT',
    'Queue waitMs must be a nonnegative safe integer.',
  );
  const queue = new CheckQueue(directory, {
    limit: 1,
    serializeAdmission: !!options.control,
    ...(options.anchor ? { anchor: options.anchor } : {}),
  });
  let last = '',
    reportedAt = 0;
  try {
    for (;;) {
      if (options.control) {
        queue.follow(options.control);
        invariant(!queue.cancelled(), 'CANCELLED', 'Finish cancelled while waiting for queue admission.');
      }
      const current = queue.position(),
        position: LandingPosition = {
          status: current.acquired ? 'landing' : 'waiting to land',
          position: current.position,
        };
      const details = `queue position=${current.position} holder=${current.acquired ? 'this operation' : queueHolder(current.holder)}`;
      if (
        (!current.acquired || workProgressIdentity().operationId) &&
        (details !== last || Date.now() - reportedAt >= 5000)
      ) {
        workProgress(
          current.acquired ? (options.phase ?? 'landing') : 'waiting for lock',
          details,
          directory,
        );
        last = details;
        reportedAt = Date.now();
      }
      options.observe?.(position);
      if (current.acquired) {
        const scope = new Set(held.getStore());
        scope.add(directory);
        return { value: await held.run(scope, task) };
      }
      if (Date.now() >= end) return { waiting: position };
      await new Promise(resolve => setTimeout(resolve, Math.min(100, end - Date.now())));
    }
  } finally {
    queue.release();
  }
}
export function withLandingSlot<T>(
  store: WorkStore,
  channel: string,
  task: () => Promise<T>,
  options?: Parameters<typeof withQueueSlot<T>>[2],
) {
  return withQueueSlot(landingDirectory(store, channel), task, { anchor: store.directory, ...options });
}
