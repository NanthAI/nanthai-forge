// SPDX-License-Identifier: Apache-2.0
import { PeersCache } from './agent-peers-cache.js';
import { PeersSource } from './agent-peers-source.js';
import { regionSummary } from './agent-region-summary.js';
import { pageHashes, pageSize } from './work-records.js';
import type { WorkStore } from './work-store.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';
import type { Lane } from './work-types.js';

/** Publish changed header pages on the write path. Immutable page hashes pin every
 * entry; missing/deleted caches still rebuild through the ordinary reader. */
export function indexPeerRecords(root: string, tx: WorkRecordTransaction, changedPages?: number[]) {
  const cache = new PeersCache(root),
    lanes = tx.manifest.collections.lanes;
  if (!lanes) return;
  for (const page of changedPages ?? lanes.pages.map((_, index) => index)) {
    const hash = lanes.pages[page]!,
      key = `lane-fields-v1:${hash}`;
    if (cache.read(key)) continue;
    const hashes = pageHashes(tx.directory, hash),
      slot = `lane-page-slot-v1:${page}`;
    const prior = cache.read<{ hashes: string[]; records: Lane[] }>(slot);
    const records = hashes.map((id, offset) =>
      prior?.hashes[offset] === id && prior.records[offset]
        ? prior.records[offset]!
        : tx.fieldsAt('lanes', page * pageSize + offset).record,
    );
    cache.write(slot, { hashes, records });
    cache.write(key, records);
  }
}

/** Outside the owner lock: prime exact manifests, inventory and live-file stamps
 * after materialization/checkpoint/sync. Fresh metadata is still checked on reads. */
export function indexPeerSource(store: WorkStore, laneId: string) {
  const lane = store.select('lanes', laneId, 'id', true);
  if (!lane || !['active', 'paused', 'ready'].includes(lane.state)) return;
  const source = new PeersSource(store, () => {}, lane.base);
  source.state(lane.base);
  source.state(lane.head);
  regionSummary(source, new PeersCache(store.root), lane.base, lane.head, () => [
    source.state(lane.base).files,
    source.state(lane.head).files,
  ]);
  source.live(lane);
}
