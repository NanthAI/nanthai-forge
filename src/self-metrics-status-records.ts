// SPDX-License-Identifier: Apache-2.0
import { PeersCache } from './agent-peers-cache.js';
import { pageSize } from './work-records.js';
import { statusMetrics } from './self-metrics-status.js';
import type { WorkRecordTransaction, WorkCollection, WorkRecord } from './work-record-transaction.js';
/** Reuse immutable page projections across CLI calls. A warm status reads only
 * compact cached pages; changed pages hydrate from their exact pinned records. */
export function recordStatusMetrics(root: string, tx: WorkRecordTransaction, now = new Date().toISOString()) {
  const cache = new PeersCache(root);
  const rows = <K extends WorkCollection>(collection: K): WorkRecord<K>[] => {
    const index = tx.manifest.collections[collection];
    return (index?.pages ?? []).flatMap((hash, page) => {
      const key = `metrics-status-v1:${collection}:${hash}`;
      const cached = cache.read<WorkRecord<K>[]>(key);
      if (cached) return cached;
      const values = Array.from({ length: Math.min(pageSize, index!.count - page * pageSize) }, (_, offset) =>
        tx.at(collection, page * pageSize + offset),
      );
      cache.write(key, values);
      return values;
    });
  };
  return statusMetrics(
    root,
    {
      ...tx.data(),
      lanes: rows('lanes'),
      views: rows('views'),
      runs: rows('runs'),
      channelMoves: rows('channelMoves'),
      landingEntries: rows('landingEntries'),
      landingBatches: [],
      githubChecks: rows('githubChecks'),
    },
    now,
  );
}
