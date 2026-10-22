// SPDX-License-Identifier: Apache-2.0
import { landingWorkerStates } from './landing-worker-status.js';
import { notifyAutoExchange } from './auto-exchange-notify.js';
import type { WorkStore } from './work-store.js';
const pending = new Map<string, { excludedId: string | undefined }>();
/** Invalidation after publication or driver release, deferred past the owner lock.
 * No daemon is spawned and no timer exists while idle. Startup repairs lost wakes. */
export function wakeLandingWorker(store: WorkStore, excludedId?: string) {
  const previous = pending.get(store.directory);
  if (previous) {
    // Coalescing keeps the union of recipients. A durable Work publication
    // wakes everybody, even if a peer-only release was already scheduled.
    if (previous.excludedId !== excludedId) previous.excludedId = undefined;
    return;
  }
  const delivery = { excludedId };
  pending.set(store.directory, delivery);
  setImmediate(() => {
    pending.delete(store.directory);
    try {
      for (const state of landingWorkerStates(store))
        if (state.status !== 'stopped' && state.id !== delivery.excludedId)
          notifyAutoExchange(state.endpoint);
    } catch {
      // The saved source/Work outcome is independent of this notification.
    }
  });
}
