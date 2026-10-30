// SPDX-License-Identifier: Apache-2.0
import { planLandingTrain } from './landing-train-plan.js';
import { landingWait, checkingWait } from './landing-waiting.js';
import type { WorkData } from './work-types.js';
import type { WorkStore } from './work-store.js';

/** Node-only (reads the native store); kept apart from landing-waiting so the browser bundle can import the pure wait helpers. */
export function recordLandingWaits(store: WorkStore, data: WorkData, channel: string) {
  const train = planLandingTrain(store, data, channel);
  for (const entry of data.landingEntries ?? []) {
    if (entry.channel !== channel) continue;
    if (entry.status === 'checking') entry.waitingFor = checkingWait(data, entry);
    else if (entry.status === 'queued') {
      const after = train.waits.find(wait => wait.entryId === entry.id)?.after ?? [];
      const blockers = after.flatMap(id => data.landingEntries?.find(entry => entry.id === id) ?? []);
      entry.waitingFor = blockers.length
        ? landingWait(data, 'overlap', 'Waiting for overlapping submitted heads to settle.', blockers)
        : landingWait(
            data,
            'batch-order',
            'Waiting for selection into an available compatible batch.',
            train.active,
          );
    } else delete entry.waitingFor;
  }
  return train;
}
