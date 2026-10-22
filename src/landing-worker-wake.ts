// SPDX-License-Identifier: Apache-2.0
import { landingWorkerStates } from './landing-worker-status.js';
import { notifyAutoExchange } from './auto-exchange-notify.js';
import type { WorkStore } from './work-store.js';
const pending = new Set<string>();
/** Invalidation after durable publication, deferred past the short owner lock.
 * No daemon is spawned and no timer exists while idle. Startup repairs lost wakes. */
export function wakeLandingWorker(store: WorkStore) {
  if (pending.has(store.directory)) return;
  pending.add(store.directory);
  setImmediate(() => {
    pending.delete(store.directory);
    try {
      for (const state of landingWorkerStates(store))
        if (state.status !== 'stopped') notifyAutoExchange(state.endpoint);
    } catch {
      // The saved source/Work outcome is independent of this notification.
    }
  });
}
