// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';
import { checkoutIo } from './checkout-io.js';
import { materializationDirectory, withCheckoutBatch } from './checkout-materialization.js';
import { mapExchange } from './exchange-parallel.js';
import { CheckQueue, queueEntries } from './check-queue.js';

type FileIo = <T>(run: () => Promise<T>) => Promise<T>;
const batches = new AsyncLocalStorage<{
  directory: string;
  queue: CheckQueue;
  phase: string;
}>();

/** Retain the last copy turn through its barriers/publication. A peer must not
 * dirty the filesystem between completing a tree and flushing its new inodes.
 * Long traversals still yield this same recoverable ticket in finite turns. */
export async function withCheckoutFileBatch<T>(
  stage: string,
  run: () => Promise<T>,
  files?: number,
): Promise<T> {
  const directory = `${materializationDirectory(stage)}.writes`;
  if (batches.getStore()?.directory === directory) return run();
  const phase = files === undefined ? 'copy' : `copy:${files}`;
  const queue = new CheckQueue(directory, {
    limit: 1,
    serializeAdmission: false,
    identity: { phase },
  });
  try {
    return await withCheckoutBatch(directory, () => batches.run({ directory, queue, phase }, run), queue);
  } finally {
    queue.release();
  }
}

/** Traverse in manifest/directory order under one finite mutation batch. Keep
 * the lease while uncontended: writing ticket metadata per directory would make
 * each fsync commit that traffic too. After a one-second quantum, copies yield
 * to smaller/unknown work and barriers yield to another phase; equal/larger
 * copies and same-phase barriers retain transaction locality. Waiting owns no I/O worker or descriptor. */
export async function visitCheckoutFiles<T>(
  stage: string,
  phase: 'copy' | 'durability',
  paths: Iterable<T>,
  run: (path: T, io: FileIo) => Promise<void>,
) {
  const iterator = paths[Symbol.iterator]();
  let next = iterator.next();
  if (next.done) return;
  const directory = `${materializationDirectory(stage)}.writes`;
  let remaining = Array.isArray(paths) ? paths.length : Infinity;
  const label = phase === 'copy' && Number.isFinite(remaining) ? `copy:${remaining}` : phase;
  const workers = 16; // The existing bounded file lookahead, not an I/O worker count.
  const current = batches.getStore();
  const existing = current?.directory === directory ? current.queue : undefined;
  const queue =
    existing ??
    new CheckQueue(directory, { limit: 1, serializeAdmission: false, identity: { phase: label } });
  if (existing && current!.phase !== label) {
    queue.update({ phase: label });
    current!.phase = label;
  }
  try {
    while (!next.done) {
      await withCheckoutBatch(
        directory,
        async () => {
          let active = 0,
            since = 0,
            spent = 0,
            failed = false,
            yielded = false;
          const io: FileIo = run =>
            checkoutIo(async () => {
              if (active++ === 0) since = performance.now();
              try {
                return await run();
              } finally {
                if (--active === 0) spent += performance.now() - since;
              }
            }, phase);
          await mapExchange(Array.from({ length: workers }), workers, async () => {
            while (!failed && !yielded && !next.done) {
              // Only actual file work consumes this turn. Waiting for the
              // volume's other phase cannot reduce a batch to one file per worker.
              if (spent + (active ? performance.now() - since : 0) >= 1000) {
                if (
                  queueEntries(directory).some(
                    entry =>
                      !entry.ticket?.holding &&
                      (phase === 'durability'
                        ? entry.ticket?.phase !== 'durability'
                        : !entry.ticket?.phase?.startsWith('copy:') ||
                          Number(entry.ticket.phase.slice(5)) < remaining),
                  )
                ) {
                  yielded = true;
                  break;
                }
                spent = 0;
                if (active) since = performance.now();
              }
              const path = next.value;
              next = iterator.next();
              remaining--;
              try {
                await run(path, io);
              } catch (error) {
                failed = true;
                throw error;
              }
            }
          });
        },
        queue,
      );
      if (!next.done)
        queue.update({
          holding: false,
          ...(phase === 'copy' && Number.isFinite(remaining) ? { phase: `copy:${remaining}` } : {}),
          number: Math.max(0, ...queueEntries(directory).map(entry => entry.ticket?.number ?? 0)) + 1,
        });
    }
  } finally {
    if (!existing) queue.release();
  }
}
