// SPDX-License-Identifier: Apache-2.0
import { ShotError } from './options.mjs';

/** Observe the app's real Convex subscriptions without retaining values, arguments or auth frames. */
export function observeData(page) {
  let current;
  page.on('websocket', socket => {
    const url = new URL(socket.url());
    if (!url.hostname.endsWith('.convex.cloud')) return;
    const state = { pending: new Set(), queries: new Map(), seen: false, failed: false, changed: Date.now() };
    current = state;
    socket.on('framesent', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload));
        if (message.type !== 'ModifyQuerySet') return;
        state.changed = Date.now();
        for (const change of message.modifications) {
          if (change.type === 'Add') {
            state.seen = true;
            state.pending.add(change.queryId);
            state.queries.set(change.queryId, change.udfPath);
          } else if (change.type === 'Remove') state.pending.delete(change.queryId);
        }
      } catch {
        /* Non-query frames have no bearing on readiness. */
      }
    });
    socket.on('framereceived', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload));
        if (message.type !== 'Transition') return;
        state.changed = Date.now();
        for (const change of message.modifications) {
          state.pending.delete(change.queryId);
          if (
            change.type === 'QueryFailed' &&
            !(
              state.queries.get(change.queryId) === 'projectReaders:shared' &&
              /Could not find public function for ['"]projectReaders:shared['"]/.test(
                change.errorMessage ?? '',
              )
            )
          )
            state.failed = true;
        }
      } catch {
        /* Do not log frame contents. */
      }
    });
  });
  return async function settled(required = true) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (current?.failed)
        throw new ShotError('A live data query failed; no successful screenshot recorded.');
      if (
        (!required && (!current || (!current.seen && Date.now() - current.changed >= 500))) ||
        (current?.seen && current.pending.size === 0 && Date.now() - current.changed >= 500)
      )
        return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new ShotError('The app did not finish its live data subscriptions.');
  };
}
