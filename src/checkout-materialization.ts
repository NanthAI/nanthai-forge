// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, statSync, watch } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { join } from 'node:path';
import { CheckQueue } from './check-queue.js';

/** Three full pipelines avoid the filesystem contention knee measured on APFS.
 * This phases work, never admission: every request retains its own FIFO ticket. */
export const materializationSlots = (cores = cpus().length) =>
  Math.max(1, Math.min(3, Math.floor(cores / 3)));

/** Key by the destination device, not the project, object cache or checkout root. */
export function materializationDirectory(stage: string) {
  return join(
    process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
    'forge',
    'materialization-v1',
    String(statSync(stage).dev),
  );
}

/** Schedule the whole private copy/verify/flush pass together. Keeping the slot
 * through both durability barriers prevents copy and fsync pipelines multiplying
 * across processes. CheckQueue reclaims only dead kernel process identities;
 * unique tickets avoid a stale reaper deleting a new holder's slot. */
export async function withCheckoutMaterialization<T>(
  stage: string,
  run: () => Promise<T>,
  options: { directory?: string; slots?: number } = {},
): Promise<T> {
  const directory = options.directory ?? materializationDirectory(stage);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const queue = new CheckQueue(directory, {
    limit: options.slots ?? materializationSlots(),
    serializeAdmission: false,
  });
  try {
    while (!queue.tryAcquire()) {
      await new Promise<void>((resolve, reject) => {
        // Register before checking again, so a release cannot be missed between
        // observing a full queue and sleeping. Only pending requests own a timer.
        const watcher = watch(directory, () => done());
        const timer = setTimeout(() => done(), 1000);
        function done(error?: Error) {
          clearTimeout(timer);
          watcher.close();
          if (error) reject(error);
          else resolve();
        }
        watcher.once('error', done);
        try {
          if (queue.tryAcquire()) done();
        } catch (error) {
          done(error as Error);
        }
      });
    }
    return await run();
  } finally {
    queue.release();
  }
}
