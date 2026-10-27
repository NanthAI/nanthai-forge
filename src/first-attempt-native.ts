// SPDX-License-Identifier: Apache-2.0
import { allRecords } from './agent-lifecycle.js';
import { firstAttemptLandRate, type LandRateEntry } from './first-attempt-land-rate.js';
import type { WorkStore } from './work-store.js';
import type { LandingEntry } from './landing-batch-types.js';
/** Explicit landing read only: retained entry headers and input pins, no source,
 * timers, scheduling, mutation, or inferred flake classification. */
export function nativeFirstAttemptLandRate(store: WorkStore, now = new Date()) {
  const tx = store.readRecords?.();
  const history = tx
    ? tx.manifest.collections.landingEntries
      ? allRecords<LandingEntry>(store, 'landingEntries')
      : []
    : (store.load().landingEntries ?? []);
  const entries = history.filter(entry => entry.channel === 'main');
  const records: LandRateEntry[] = entries.map(entry => ({
    id: entry.id,
    at: entry.arrivedAt,
    laneIds: store.select('views', entry.viewId)?.inputs.map(pin => pin.laneId) ?? [],
    accepted: entry.status === 'accepted',
    pending: ['queued', 'checking', 'awaiting-review'].includes(entry.status),
    cause:
      entry.status === 'conflict'
        ? 'conflict'
        : entry.status === 'cancelled'
          ? 'cancelled'
          : entry.stall
            ? 'stall'
            : entry.status === 'failed' && !entry.error
              ? 'check-failure-or-flake'
              : 'other',
  }));
  return firstAttemptLandRate(
    records,
    new Date(now.getTime() - 7 * 86400000).toISOString(),
    now.toISOString(),
  );
}
