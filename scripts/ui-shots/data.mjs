// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ShotError } from './options.mjs';
import { convexFrames } from './convex-frames.mjs';

/** Observe the app's real Convex subscriptions without retaining values, arguments or auth frames. */
export function observeData(page, deployment) {
  let current;
  page.on('websocket', socket => {
    const url = new URL(socket.url());
    if (deployment ? `https://${url.host}` !== deployment : !url.hostname.endsWith('.convex.cloud')) return;
    const state = { pending: new Set(), queries: new Map(), seen: false, failed: false, changed: Date.now() };
    current = state;
    convexFrames(socket, {
      sent(message) {
        if (message.type !== 'ModifyQuerySet' || !Array.isArray(message.modifications)) return;
        state.changed = Date.now();
        for (const change of message.modifications) {
          if (change.type === 'Add') {
            state.seen = true;
            state.pending.add(change.queryId);
            state.queries.set(change.queryId, change.udfPath);
          } else if (change.type === 'Remove') state.pending.delete(change.queryId);
        }
      },
      received(message) {
        if (message.type !== 'Transition' || !Array.isArray(message.modifications)) return;
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
      },
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
