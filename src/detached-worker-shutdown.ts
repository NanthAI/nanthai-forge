// SPDX-License-Identifier: Apache-2.0
import { withWorkLockOptions } from './work-lock.js';
import { recordFailure } from './system-errors.js';

/** One line saying why a detached worker stopped early: code or error name, then the message (bounded).
 * The launcher discards a worker's stderr, so the full stack also goes to the bounded diagnostics log
 * and its path is named. Never prints environment values or file contents. */
export function workerStopReason(label: string, error: unknown) {
  const raw = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  const code = typeof raw?.code === 'string' ? raw.code : typeof raw?.name === 'string' ? raw.name : 'Error';
  const message = (typeof raw?.message === 'string' ? raw.message : String(error)).replace(/\s+/g, ' ');
  const { diagnostics } = recordFailure(error);
  return `${label} stopped: ${code}: ${message.slice(0, 400)}${diagnostics ? ` (stack in ${diagnostics})` : ''}\n`;
}

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
