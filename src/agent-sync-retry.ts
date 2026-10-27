// SPDX-License-Identifier: Apache-2.0
import { watch } from 'node:fs';
import { readHostState } from './host-binding.js';
import { flushAgentSync } from './agent-hosted-sync.js';
import type { WorkStore } from './work-store.js';

/** Sleep only for a retained failed delivery. Local preparation can release the deadline early. */
export function waitAgentSyncRetry(store: WorkStore, deadline: number) {
  return new Promise<void>((resolve, reject) => {
    const close = () => {
      clearTimeout(timer);
      watcher.close();
    };
    const inspect = () => {
      try {
        const state = readHostState(store);
        if (
          !state.agentSync?.pending.length ||
          state.binding?.autoSync === false ||
          (state.agentSync.nextAttemptAt ?? 0) !== deadline
        ) {
          close();
          resolve();
        }
      } catch (error) {
        close();
        reject(error);
      }
    };
    const watcher = watch(store.directory, (_event, file) => {
      if (!file || ['hosted-agent-sync.json', 'hosted-binding.json'].includes(String(file))) inspect();
    });
    watcher.once('error', error => {
      close();
      reject(error);
    });
    const timer = setTimeout(
      () => {
        close();
        resolve();
      },
      Math.max(0, deadline - Date.now()),
    );
    inspect(); // Close the race between the caller's read and attaching the filesystem watch.
  });
}

/** The detached sender owns retry deadlines; an empty queue leaves no timer or watcher. */
export async function runAgentSyncRetries(
  store: WorkStore,
  flush = () => flushAgentSync(store),
  wait = (deadline: number) => waitAgentSyncRetry(store, deadline),
) {
  for (;;) {
    const result = await flush();
    if ('waiting' in result && result.waiting) return result; // Another sender owns the queue.
    const state = readHostState(store);
    if (!state.agentSync?.pending.length || state.binding?.autoSync === false) return result;
    const deadline = state.agentSync.nextAttemptAt;
    if (deadline && deadline > Date.now()) await wait(deadline);
    // Successful finite batches continue immediately. Permanent failures have already been
    // retained in --status and removed from pending by flushAgentSync.
  }
}
