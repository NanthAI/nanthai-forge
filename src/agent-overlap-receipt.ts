// SPDX-License-Identifier: Apache-2.0
import { CoordinationJournal } from './agent-coordination-journal.js';
import { boundPeers } from './agent-peers-bound.js';
import type { PeersDigest } from './agent-peers.js';
import type { WorkStore } from './work-store.js';

/** Lifecycle inbox delivery is separate from historical peers/brief observations. */
export function overlapReceipt(
  store: WorkStore,
  laneId: string,
  peers?: PeersDigest,
  readOnly = false,
  detail = false,
  operationId?: string,
) {
  const journal = new CoordinationJournal(store);
  let selected = false;
  const select = (pending: ReturnType<CoordinationJournal['pendingOverlaps']>) => {
    if (pending.length) {
      peers ??= { v: 1, coverage: 'local' };
      delete peers.clear;
      peers.inbox = pending;
    } else if (peers) delete peers.inbox;
    if (peers) boundPeers(peers, detail);
    selected = true;
    return peers;
  };
  try {
    if (readOnly) select(journal.pendingOverlaps(laneId));
    else peers = journal.deliverOverlaps(laneId, select, operationId);
  } catch {
    // Delivery bookkeeping contention must not hide an agent's final alert.
    if (!selected)
      try {
        select(journal.pendingOverlaps(laneId));
      } catch {
        /* The incomplete receipt below reports an unavailable journal. */
      }
    peers ??= { v: 1 };
    delete peers.clear;
    peers.coverage = 'local-incomplete';
  }
  return peers;
}
