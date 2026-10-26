// SPDX-License-Identifier: Apache-2.0
import { NativeSource } from './native-source.js';
import { orderLandingEntries } from './landing-batch-order.js';
import { landingOverlap } from './landing-overlap.js';
import type { WorkStore } from './work-store.js';
import type { WorkData } from './work-types.js';

/** Read-only adapter shared by the durable selector and status events. Predictions
 * schedule immutable submitted heads; they never supply acceptance evidence. */
export function planLandingTrain(store: WorkStore, data: WorkData, channel: string) {
  const queued = orderLandingEntries(
    (data.landingEntries ?? []).filter(entry => entry.channel === channel && entry.status === 'queued'),
  );
  const main = [...data.channelMoves]
    .reverse()
    .find(move => move.channel === channel && move.status === 'accepted');
  const source = new NativeSource(store.root);
  const active = (data.landingEntries ?? []).filter(entry => {
    if (entry.channel !== channel || entry.status !== 'checking') return false;
    // Acceptance is canonical even if entry settlement lost its lock/reply.
    const batch = data.landingBatches?.find(batch => batch.id === entry.batchId);
    return !batch?.prefixes.some(
      prefix =>
        prefix.entryIds.includes(entry.id) &&
        data.channelMoves.some(
          move =>
            move.channel === channel &&
            move.status === 'accepted' &&
            move.viewId === prefix.viewId &&
            main &&
            source.contains(main.head, move.head),
        ),
    );
  });
  const overlap = landingOverlap(store, data, [...queued, ...active]);
  const pending = overlap.ordered.filter(entry => queued.includes(entry));
  const waits = pending.flatMap((entry, index) => {
    const after = [...active, ...pending.slice(0, index)]
      .filter(earlier => overlap.overlaps(earlier, entry))
      .map(earlier => earlier.id);
    return after.length ? [{ entryId: entry.id, after }] : [];
  });
  return { ...overlap, pending, active, waits };
}
