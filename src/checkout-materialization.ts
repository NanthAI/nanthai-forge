// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { setMaxListeners } from 'node:events';
import { homedir, userInfo } from 'node:os';
import { inTestProcess } from './test-isolation.js';
import { dirname, join } from 'node:path';
import { acquire } from './checkout-admission.js';
import { CheckQueue, queueEntries } from './check-queue.js';
import {
  checkoutIoCapacity,
  checkoutVolumeCapacity,
  type CheckoutIoPhase,
  withCheckoutIo,
  type CheckoutIoExecutor,
} from './checkout-io.js';

/** One namespace per OS user/device, independent of project and object-cache settings. */
export function materializationDirectory(path: string) {
  let home = homedir();
  if (!inTestProcess()) {
    try {
      home = userInfo().homedir;
    } catch {
      /* Unmapped container accounts retain the ordinary home fallback. */
    }
  }
  return join(home, '.cache', 'forge', 'materialization-v2', String(statSync(path).dev));
}
type MaterializationPhase = CheckoutIoPhase | 'shared';
type Job = {
  phase: MaterializationPhase;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};
/** Worker permits, not open permits: CPU and network progress do not hold the
 * device. Workers batch ready I/O until the existing one-second wake cadence,
 * then rejoin FIFO, amortizing ticket metadata without starving another open. */
export async function withCheckoutMaterialization<T>(
  stage: string,
  run: () => Promise<T>,
  options: {
    directory?: string;
    /** Small verified trees share either phase, retaining the same worker ceiling. */
    cooperative?: () => boolean;
    paths?: string[];
    waited?: (ms: number) => void;
    budget?: (value: { volumeWorkers: number; localWorkers: number }) => void;
  } = {},
): Promise<T> {
  const directories = options.directory
    ? [options.directory]
    : [
        ...new Set(
          [stage, ...(options.paths ?? [])].map(path => {
            while (!existsSync(path)) path = dirname(path);
            return materializationDirectory(path);
          }),
        ),
      ].sort();
  for (const directory of directories) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stop = new AbortController();
  const capacity = checkoutVolumeCapacity(),
    localCapacity = Math.min(capacity, checkoutIoCapacity()),
    pending: Job[] = [],
    workers = new Set<Promise<void>>();
  options.budget?.({ volumeWorkers: capacity, localWorkers: localCapacity });
  setMaxListeners(localCapacity + 1, stop.signal);
  let active = 0,
    spareUntil = 0,
    stalled: number | undefined;
  const mark = () => {
    if (pending.length && !active) stalled ??= performance.now();
    else if (stalled !== undefined) {
      options.waited?.(performance.now() - stalled);
      stalled = undefined;
    }
  };
  const executor: CheckoutIoExecutor = (callback, phase) =>
    new Promise((resolve, reject) => {
      pending.push({
        phase: options.cooperative?.() === false ? 'shared' : phase,
        run: callback,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      mark();
      pump();
    });
  function pump() {
    if (stop.signal.aborted || !pending.length || workers.size >= localCapacity) return;
    // Always give this open one waiting worker. Extra workers consume only spare
    // permits; ten opens do not each manufacture four waiting tickets.
    if (workers.size) {
      if (performance.now() < spareUntil) return;
      if (directories.some(directory => queueEntries(directory).length >= capacity)) {
        spareUntil = performance.now() + 1000;
        return;
      }
    }
    const phase = pending[0]!.phase;
    const queues: CheckQueue[] = [];
    // Publish choosing/tickets synchronously before another local producer pumps.
    try {
      queues.push(
        new CheckQueue(directories[0]!, { limit: capacity, serializeAdmission: false, identity: { phase } }),
      );
    } catch (error) {
      for (const queue of queues.reverse()) queue.release();
      while (pending.length) pending.shift()!.reject(error);
      mark();
      return;
    }
    const worker = (async () => {
      try {
        for (let i = 0; i < directories.length; i++) {
          if (i)
            queues.push(
              new CheckQueue(directories[i]!, {
                limit: capacity,
                serializeAdmission: false,
                identity: { phase },
              }),
            );
          if (!(await acquire(queues[i]!, directories[i]!, stop.signal))) return;
        }
        let until = performance.now() + 1000;
        while (pending[0]?.phase === phase) {
          if (performance.now() >= until) {
            if (directories.some(directory => queueEntries(directory).some(entry => !entry.ticket?.holding)))
              break;
            // No peer needs the permit: keep it without generating filesystem
            // metadata in the middle of a durability barrier.
            until = performance.now() + 1000;
          }
          const job = pending.shift()!;
          active++;
          mark();
          try {
            job.resolve(await job.run());
          } catch (error) {
            job.reject(error);
          } finally {
            active--;
            mark();
          }
          // Await continuations before retiring an idle worker; a copy's next
          // hash/chmod or a file's fsync/close reuses the same permit.
          if (!pending.length) await new Promise<void>(resolve => setImmediate(resolve));
        }
      } catch (error) {
        while (pending.length) pending.shift()!.reject(error);
        mark();
      } finally {
        for (const queue of queues.reverse()) queue.release();
      }
    })();
    workers.add(worker);
    void worker.finally(() => {
      workers.delete(worker);
      pump();
    });
  }
  try {
    return await withCheckoutIo(executor, run);
  } finally {
    // Every production fan-out drains before returning, including failure paths.
    // Join idle/acquiring workers too, so cleanup never races a late lease.
    stop.abort();
    await Promise.allSettled([...workers]);
    mark();
  }
}
/** One editing write pass per device preserves filesystem transaction locality.
 * Verification/network preparation remains outside this lease and shares the
 * worker budget. This is a single-writer rule, not a CPU-derived pipeline count. */
export async function withCheckoutWritePass<T>(
  stage: string,
  run: () => Promise<T>,
  options: { directory?: string; waited?: (ms: number) => void } = {},
): Promise<T> {
  const start = performance.now(),
    directory = options.directory ?? `${materializationDirectory(stage)}.writes`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const queue = new CheckQueue(directory, { limit: 1, serializeAdmission: false });
  try {
    await acquire(queue, directory);
    options.waited?.(performance.now() - start);
    return await run();
  } finally {
    queue.release();
  }
}
