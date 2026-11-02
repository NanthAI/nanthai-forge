// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, statSync, watch } from 'node:fs';
import { setMaxListeners } from 'node:events';
import { homedir, userInfo } from 'node:os';
import { inTestProcess } from './test-isolation.js';
import { dirname, join } from 'node:path';
import { CheckQueue, queueEntries, compareTickets } from './check-queue.js';
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
type Job = {
  phase: CheckoutIoPhase;
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
      pending.push({ phase, run: callback, resolve: resolve as (value: unknown) => void, reject });
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
          if (!(await acquire(queues[i]!, directories[i]!, phase, stop.signal))) return;
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
/** Gate contenders retain their bakery ticket while choosing settles. Admission
 * metadata is never fsynced, and ineligible waiters publish no mutex traffic. */
async function acquire(queue: CheckQueue, directory: string, phase: CheckoutIoPhase, signal: AbortSignal) {
  const gateDirectory = `${directory}.phase-gate`;
  mkdirSync(gateDirectory, { recursive: true, mode: 0o700 });
  let gate: CheckQueue | undefined;
  const releaseGate = () => {
    gate?.release();
    gate = undefined;
  };
  const eligible = (entries: ReturnType<typeof queueEntries>) => {
    if (entries.some(entry => !entry.ticket)) return false;
    const limit = Math.min(...entries.map(entry => entry.ticket!.limit));
    if (entries.filter(entry => entry.ticket?.holding).length >= limit) return false;
    if (entries.some(entry => entry.ticket?.holding && entry.ticket.phase !== phase)) return false;
    const ordered = entries.sort(compareTickets);
    const first = ordered.find(entry => !entry.ticket?.holding);
    return first?.ticket?.phase === phase && ordered.findIndex(entry => entry.path === queue.path) < limit;
  };
  const attempt = () => {
    const entries = queueEntries(directory);
    // A watcher recheck may already have acquired this exact ticket.
    if (entries.some(entry => entry.path === queue.path && entry.ticket?.holding)) return true;
    if (!eligible(entries)) {
      releaseGate();
      return false;
    }
    gate ??= new CheckQueue(gateDirectory, { limit: 1, serializeAdmission: false });
    if (!gate.tryAcquire()) return false;
    try {
      return eligible(queueEntries(directory)) && queue.tryAcquire();
    } finally {
      releaseGate();
    }
  };
  try {
    while (!signal.aborted && !attempt()) {
      await new Promise<void>((resolve, reject) => {
        const watchers = [directory, gateDirectory].map(path => watch(path, () => done()));
        const timer = setTimeout(() => done(), 1000);
        const abort = () => done();
        let finished = false;
        function done(error?: Error) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          for (const watcher of watchers) watcher.close();
          signal.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve();
        }
        signal.addEventListener('abort', abort, { once: true });
        for (const watcher of watchers) watcher.once('error', done);
        try {
          if (signal.aborted || attempt()) done();
        } catch (error) {
          done(error as Error);
        }
      });
    }
    return !signal.aborted;
  } finally {
    releaseGate();
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
    while (!queue.tryAcquire()) {
      await new Promise<void>((resolve, reject) => {
        const watcher = watch(directory, () => done()),
          timer = setTimeout(() => done(), 1000);
        let finished = false;
        function done(error?: Error) {
          if (finished) return;
          finished = true;
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
    options.waited?.(performance.now() - start);
    return await run();
  } finally {
    queue.release();
  }
}
