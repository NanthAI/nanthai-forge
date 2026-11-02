// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { setMaxListeners } from 'node:events';
import { homedir, userInfo } from 'node:os';
import { inTestProcess } from './test-isolation.js';
import { dirname, join } from 'node:path';
import { CheckQueue, queueEntries, compareTickets } from './check-queue.js';
import {
  checkoutIoCapacity,
  checkoutIoWaited,
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
    // Acquiring/idle workers already cover these jobs. In particular an await
    // continuation must reuse its worker, not publish another filesystem ticket.
    if (pending.length <= workers.size - active) return;
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
        let until = Infinity;
        for (let i = 0; i < directories.length; i++) {
          if (i)
            queues.push(
              new CheckQueue(directories[i]!, {
                limit: capacity,
                serializeAdmission: false,
                identity: { phase },
              }),
            );
          const admittedUntil = await acquire(queues[i]!, directories[i]!, stop.signal, phase, () =>
            Boolean(pending[0] && (pending[0].phase === phase || pending[0].phase === 'read')),
          );
          if (admittedUntil === false) return;
          until = Math.min(until, admittedUntil);
        }
        let served = false;
        while (pending[0] && (pending[0].phase === phase || pending[0].phase === 'read')) {
          // A later device can consume the earlier device's quantum. Still run
          // one ready job after acquiring all devices before yielding the turn.
          if (served && performance.now() >= until) {
            if (directories.some(directory => queueEntries(directory).some(entry => !entry.ticket?.holding)))
              break;
            // No peer needs the permit: keep it without generating filesystem
            // metadata in the middle of a durability barrier.
            until = performance.now() + 1000;
          }
          const job = pending.shift()!;
          served = true;
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
  const capacityWatchers = directories.map(directory =>
    watch(directory, () => {
      // A negative spare-capacity probe is valid only for that queue snapshot.
      // Wake on admission/release instead of leaving a newly free device idle.
      spareUntil = 0;
      pump();
    }),
  );
  for (const watcher of capacityWatchers) watcher.on('error', () => watcher.close());
  try {
    return await withCheckoutIo(executor, run, { waited: options.waited });
  } finally {
    // Every production fan-out drains before returning, including failure paths.
    // Join idle/acquiring workers too, so cleanup never races a late lease.
    stop.abort();
    for (const watcher of capacityWatchers) watcher.close();
    await Promise.allSettled([...workers]);
    mark();
  }
}
/** Read-only workers share either phase. Write and durability batches drain
 * their active jobs before switching, so fsync does not repeatedly commit a
 * peer's clones/chmods. Matching workers can bypass an incompatible head ticket
 * only within the same finite epoch; later arrivals never extend its origin. */
async function acquire(
  queue: CheckQueue,
  directory: string,
  signal: AbortSignal,
  phase?: CheckoutIoPhase,
  ready: () => boolean = () => true,
): Promise<number | false> {
  const gateDirectory = `${directory}.phase-gate`;
  if (phase) mkdirSync(gateDirectory, { recursive: true, mode: 0o700 });
  let gate: CheckQueue | undefined,
    until = 0;
  const releaseGate = () => {
    gate?.release();
    gate = undefined;
  };
  const select = (entries: ReturnType<typeof queueEntries>) => {
    if (entries.some(entry => !entry.ticket)) return null;
    const holders = entries.filter(entry => entry.ticket?.holding);
    const limit = Math.min(...entries.map(entry => entry.ticket!.limit));
    if (holders.length >= limit) return null;
    const waiting = entries.filter(entry => !entry.ticket?.holding).sort(compareTickets);
    const now = Date.now();
    const writers = holders.filter(entry => entry.ticket?.phase !== 'read');
    const live = writers.filter(entry => {
      const start = entry.ticket?.createdAt ?? 0;
      return start <= now && start + 1000 > now;
    });
    const waitingWriters = waiting.filter(entry => entry.ticket?.phase !== 'read');
    const selected = writers[0]?.ticket?.phase ?? waitingWriters[0]?.ticket?.phase;
    const opposite = waitingWriters.some(entry => entry.ticket?.phase !== selected);
    // Once the epoch expires, stop admitting writes until the current jobs
    // drain. Reads share either phase in FIFO order, without jumping an older
    // writer that may be running an earlier admission protocol.
    const writing = !writers.length || live.length > 0 || !opposite;
    const eligible = waiting.filter(
      entry =>
        (entry.ticket?.phase === 'read' &&
          (!waitingWriters[0] || compareTickets(entry, waitingWriters[0]) < 0)) ||
        (writing &&
          entry.ticket?.phase === selected &&
          writers.every(holder => holder.ticket?.phase === selected)),
    );
    const index = eligible.findIndex(entry => entry.path === queue.path);
    if (index < 0 || index >= limit - holders.length) return null;
    const epoch = live.filter(entry => entry.ticket?.phase === phase).map(entry => entry.ticket!.createdAt!);
    return phase !== 'read' && epoch.length ? Math.min(...epoch) : now;
  };
  const attempt = () => {
    if (!phase) {
      if (!queue.tryAcquire()) return false;
      until = performance.now() + 1000;
      return true;
    }
    const entries = queueEntries(directory);
    const own = entries.find(entry => entry.path === queue.path && entry.ticket?.holding);
    if (own) return true;
    if (select(entries) === null) {
      releaseGate();
      return false;
    }
    gate ??= new CheckQueue(gateDirectory, { limit: 1, serializeAdmission: false });
    if (!gate.tryAcquire()) return false;
    try {
      const epoch = select(queueEntries(directory));
      if (epoch === null) return false;
      // Admission is serialized only for the short metadata update. Ordinary
      // bakery FIFO cannot bypass an incompatible ticket to fill this batch.
      queue.update({ holding: true, createdAt: epoch });
      until = performance.now() + Math.min(1000, Math.max(0, epoch + 1000 - Date.now()));
      return true;
    } finally {
      releaseGate();
    }
  };
  try {
    while (!signal.aborted && ready() && !attempt()) {
      await new Promise<void>((resolve, reject) => {
        const watchers: FSWatcher[] = [];
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
        try {
          for (const path of phase ? [directory, gateDirectory] : [directory])
            watchers.push(watch(path, () => done()));
          // Reused traversal tickets move to the tail through an atomic file
          // replacement. Watch only the head directory, not every peer ticket.
          if (!phase) {
            const head = queueEntries(directory).sort(compareTickets)[0];
            if (head) {
              try {
                watchers.push(watch(head.path, () => done()));
              } catch (error) {
                // A retired head is ordinary: the root watch and the recheck
                // below cover its successor. A missing queue root is fatal.
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              }
            }
          }
        } catch (error) {
          done(error as Error);
        }
        for (const watcher of watchers) watcher.once('error', done);
        try {
          if (!finished && (signal.aborted || !ready() || attempt())) done();
        } catch (error) {
          done(error as Error);
        }
      });
    }
    return signal.aborted || !ready() ? false : until;
  } finally {
    releaseGate();
  }
}

/** Recoverable FIFO ownership of a cache fill or directory barrier batch.
 * Admission holds no volume worker; callbacks acquire those only for actual I/O.
 * Kernel process identities recover tickets after a stopped or killed owner. */
export async function withCheckoutBatch<T>(
  directory: string,
  run: () => Promise<T>,
  existing?: CheckQueue,
): Promise<T> {
  const queue = existing ?? new CheckQueue(directory, { limit: 1, serializeAdmission: false });
  try {
    const start = performance.now();
    try {
      await acquire(queue, directory, new AbortController().signal);
    } finally {
      checkoutIoWaited(performance.now() - start);
    }
    return await run();
  } finally {
    if (!existing) queue.release();
  }
}
