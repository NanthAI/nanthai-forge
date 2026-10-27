import { orderLandingEntries } from './landing-batch-order.js';
// SPDX-License-Identifier: Apache-2.0
import { PeersSource } from './agent-peers-source.js';
import { PeersCache } from './agent-peers-cache.js';
import { landingPositions } from './landing-records-index.js';
import { queueAheadPreview, QUEUE_AHEAD_LIMIT } from './queue-ahead-preview.js';
import { channelStatus } from './work-channel.js';
import type { WorkStore } from './work-store.js';
import type { LandingEntry } from './landing-batch-types.js';

/** Only active queue headers and selected Candidates; retained history is excluded. */
function readNativeQueueAhead(store: WorkStore, entry: LandingEntry) {
  if (!['queued', 'checking'].includes(entry.status)) return undefined;
  const tx = store.readRecords();
  if (!tx) throw new Error('Selected queue-ahead records are unavailable.');
  try {
    const rows = landingPositions(store, tx, 'landingEntries', ['queued', 'checking'], entry.channel).map(
      position => tx.fieldsAt('landingEntries', position).record,
    );
    const active = rows.filter(row => row.channel === entry.channel);
    const ordered = [
      ...active.filter(row => row.status === 'checking'),
      ...orderLandingEntries(active.filter(row => row.status === 'queued')),
    ];
    const index = ordered.findIndex(row => row.id === entry.id);
    const ahead = index < 0 ? [] : ordered.slice(0, index);
    if (!ahead.length) return undefined;
    let main: string | null | undefined;
    if (store.native) {
      for (const position of tx.positions('channelMoves', entry.channel, 'channel').reverse()) {
        const move = tx.fieldsAt('channelMoves', position).record;
        if (move.status === 'accepted') {
          main = move.head;
          break;
        }
      }
    } else main = channelStatus(store, tx.data()).find(channel => channel.name === entry.channel)?.head;
    main ??= store.select('views', entry.viewId)?.base;
    if (!main) return undefined;
    return queueAheadPreview(
      new PeersSource(store, main),
      new PeersCache(store.root),
      store.root,
      main,
      entry.head,
      ahead.slice(0, QUEUE_AHEAD_LIMIT + 1).map(row => ({
        id: row.id,
        head: row.head,
        status:
          row.status === 'queued' && row.runId && store.select('runs', row.runId)?.status === 'passed'
            ? 'ready'
            : row.status,
        lanes:
          ahead.indexOf(row) < QUEUE_AHEAD_LIMIT
            ? (store.select('views', row.viewId)?.inputs.map(pin => pin.laneId) ?? [])
            : [],
      })),
    );
  } finally {
    tx.dispose();
  }
}

/** Advisory metadata/source availability never changes the canonical outcome. */
export function nativeQueueAhead(store: WorkStore, entry: LandingEntry) {
  try {
    return readNativeQueueAhead(store, entry);
  } catch {
    return {
      main: null,
      considered: 0,
      more: true,
      conflicts: [],
      unavailable: [entry.id],
      cost: { composeCalls: 0, cacheHits: 0, durationMs: 0, maxComposeCalls: QUEUE_AHEAD_LIMIT * 2 },
    };
  }
}
