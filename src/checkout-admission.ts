// SPDX-License-Identifier: Apache-2.0
import { existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import { CheckQueue } from './check-queue.js';
import { invariant } from './errors.js';

/** Bakery order already bounds shared workers. A second global phase gate would
 * leave compatible spare capacity idle behind a different-phase waiter. Large
 * editing passes retain their separate transaction-locality lease. */
export async function acquire(queue: CheckQueue, directory: string, signal?: AbortSignal) {
  const attempt = () => {
    invariant(
      !queue.cancelled(),
      'CHECKOUT_QUEUE_CANCELLED',
      'Checkout permit was cancelled; retry the original operation.',
    );
    invariant(
      existsSync(join(queue.path, 'ticket.json')),
      'CHECKOUT_QUEUE_LOST',
      'Checkout permit was removed; retry the original operation.',
    );
    return queue.tryAcquire();
  };
  while (!signal?.aborted && !attempt()) {
    await new Promise<void>((resolve, reject) => {
      const watcher = watch(directory, () => done());
      const timer = setTimeout(() => done(), 1000);
      const abort = () => done();
      let finished = false;
      function done(error?: Error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        watcher.close();
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      }
      signal?.addEventListener('abort', abort, { once: true });
      watcher.once('error', done);
      try {
        if (signal?.aborted || attempt()) done();
      } catch (error) {
        done(error as Error);
      }
    });
  }
  return !signal?.aborted;
}
