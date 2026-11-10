// SPDX-License-Identifier: Apache-2.0
import { PeersCache } from './agent-peers-cache.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';
import { pageHashes, pageSize } from './work-records.js';
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
