// SPDX-License-Identifier: Apache-2.0
import { withWorkLockOptions } from './work-lock.js';

/** Install before worker setup. Synchronous lock admission must yield immediately:
 * Atomics.wait prevents Node from delivering signals or running a shutdown timer.
 * The referenced deadline also closes provider sockets left by detached checks. */
export async function detachedWorker<T>(run: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (controller.signal.aborted) return;
    deadline = setTimeout(() => process.exit(0), 1000);
    controller.abort();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    return await withWorkLockOptions(
      { nonblocking: true, waitMs: 0, cancelled: () => controller.signal.aborted },
      () => run(controller.signal),
    );
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    if (deadline) clearTimeout(deadline);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}
