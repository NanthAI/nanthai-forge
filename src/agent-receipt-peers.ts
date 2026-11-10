// SPDX-License-Identifier: Apache-2.0
import type { SavedPeerPaths } from './agent-peer-ranking.js';
import { PeersCache } from './agent-peers-cache.js';
import { type PeersDigest } from './agent-peers.js';
import type { WorkStore } from './work-store.js';

type StoreAccess = Pick<WorkStore, 'root' | 'select'>;

type Indexed = { base: string; head: string; peers: PeersDigest };

/** Detached analysis publishes an observation, never a delivery. */
export function retainIndexedPeers(store: StoreAccess, laneId: string, peers: PeersDigest) {
  const lane = store.select('lanes', laneId, 'id', true);
  if (lane) {
    const cache = new PeersCache(store.root);
    const paths = cache.read<SavedPeerPaths>(`peer-paths-v1:${lane.base}:${lane.head}`);
    if (paths) cache.write(`peer-paths-latest-v1:${laneId}`, paths);
    cache.write(`receipt-peers-v1:${laneId}`, {
      base: lane.base,
      head: lane.head,
      peers,
    } satisfies Indexed);
  }
}
