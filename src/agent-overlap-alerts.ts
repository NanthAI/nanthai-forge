// SPDX-License-Identifier: Apache-2.0
import { recordMetricOverlapSave } from './self-metrics-overlap.js';
import { currentChannelHead } from './agent-defaults.js';
import { PeersSource, RECEIPT_ANCESTRY_READS } from './agent-peers-source.js';
import { digest } from './hash.js';
import { allRecords } from './agent-lifecycle.js';
import { CoordinationJournal } from './agent-coordination-journal.js';
import { savedOverlapPlan } from './agent-overlap-plan.js';
import { rankPeerLanes } from './agent-peer-ranking.js';
import { PeersCache } from './agent-peers-cache.js';
import { changedPaths } from './agent-sync.js';
import type { WorkStore } from './work-store.js';
import type { Lane } from './work-types.js';
import { regionsNear, type PredictiveOverlap } from './agent-predictive-overlap.js';
export type OverlapAlert = {
  noticeId: string;
  kind: 'overlap-notice';
  at: string;
  lanes: string[];
  heads: string[];
  file: string;
  regions: PredictiveOverlap['mine'][];
  symbols?: string[];
  proposedOrder: string[];
  participants?: { lane: string; actor?: string; intent: string }[];
  text: string;
};
/** Connected overlapping ranges are independently deduplicated within a file. */
export function overlapRegions(item: PredictiveOverlap) {
  if (item.symbols?.length) return item.symbols.map(symbol => ({ ...item, symbols: [symbol] }));
  if (!item.mine?.length || !item.peer?.length) return [item];
  const mine = item.mine,
    peer = item.peer,
    aligned = item.alignedPeer ?? peer;
  const remaining = new Set(mine.map((_, index) => index));
  const out: PredictiveOverlap[] = [];
  for (const start of remaining) {
    const left = new Set([start]),
      right = new Set<number>();
    remaining.delete(start);
    for (const i of left)
      for (let j = 0; j < aligned.length; j++) {
        if (!regionsNear(mine[i]!, aligned[j]!)) continue;
        right.add(j);
        for (const other of remaining)
          if (regionsNear(mine[other]!, aligned[j]!)) {
            left.add(other);
            remaining.delete(other);
          }
      }
    if (!right.size) return [item]; // Structural/unknown ranges retain file scope.
    out.push({
      ...item,
      mine: [...left].map(i => mine[i]!),
      peer: [...right].map(i => peer[i]!),
      ...(item.alignedPeer ? { alignedPeer: [...right].map(i => aligned[i]!) } : {}),
    });
  }
  return out;
}
/** A checkpoint fans out one immutable inbox item to both participants. */
export function recordOverlapAlerts(
  store: WorkStore,
  laneId: string,
  maxPeers = Infinity,
  checkpoint = false,
) {
  const main = currentChannelHead(store, 'main');
  const tx = store.readRecords();
  const fields = tx
    ? Array.from(
        { length: tx.manifest.collections.lanes?.count ?? 0 },
        (_, index) => tx.fieldsAt('lanes', index).record,
      )
    : allRecords<Lane>(store, 'lanes');
  const open = fields
    .filter(lane => ['active', 'paused', 'ready'].includes(lane.state))
    .sort((a, b) => a.id.localeCompare(b.id));
  const focus = open.find(lane => lane.id === laneId);
  const source = new PeersSource(
    store,
    focus?.base ?? '',
    Number.isFinite(maxPeers) ? RECEIPT_ANCESTRY_READS : Infinity,
  );
  if (!focus) return 'local-incomplete';
  const scope = [
    ...(focus.scope?.paths ?? []),
    ...changedPaths(source.state(focus.base).files, source.state(focus.head).files),
  ];
  const ranking = rankPeerLanes(
    source,
    new PeersCache(store.root),
    scope,
    open.filter(lane => lane.id !== laneId),
  );
  // Analysis is complete for path candidates; maxPeers bounds ancestry, never
  // lets an unrelated Lane displace an overlapping one or drops a bilateral alert.
  const selected = [focus, ...ranking.ranked.filter(peer => ranking.shared.has(peer.id))];
  const recent = source.ancestry(),
    ancestry = source.ancestry('');
  let incomplete = ranking.incomplete;
  const lanes = selected.filter(lane => {
    try {
      // A verified descendant of main cannot already be contained by main.
      // Prove that short direction first; older/unrelated heads still use full ancestry.
      if (main && lane.head !== main && recent.contains(lane.head, main)) return true;
      return !(main && ancestry.contains(main, lane.head));
    } catch {
      incomplete = true;
      return false;
    }
  });
  if (checkpoint)
    recordMetricOverlapSave(
      store.directory,
      focus,
      lanes,
      lane =>
        changedPaths(
          source.state(lane.id === focus.id ? (source.state(lane.head).parents[0] ?? lane.base) : lane.base)
            .files,
          source.state(lane.head).files,
        ),
      !incomplete,
    );
  const plan = savedOverlapPlan(store, lanes, laneId);
  if (incomplete) plan.coverage = 'local-incomplete';
  const participants = new Map<string, NonNullable<OverlapAlert['participants']>[number]>();
  const participant = (id: string) => {
    let known = participants.get(id);
    if (known) return known;
    const lane = lanes.find(lane => lane.id === id)!;
    const actor = lane.owner?.actor ?? lane.startedBy?.name;
    known = {
      lane: id,
      ...(actor ? { actor } : {}),
      intent:
        (
          tx?.fields('intents', lane.intentId)?.record ??
          (!tx ? store.select('intents', lane.intentId) : undefined)
        )?.outcome ?? lane.name,
    };
    participants.set(id, known);
    return known;
  };
  const alerts = plan.pairs
    .filter(pair => pair.lanes.includes(laneId))
    .flatMap(pair =>
      pair.overlaps.flatMap(overlapRegions).map(item => {
        const canonical = [...pair.lanes].sort();
        const regions = canonical.map(id => (id === pair.lanes[0] ? item.mine : item.peer));
        const noticeId = digest(JSON.stringify([canonical, item.file, regions, item.symbols ?? []]));
        const owner = lanes.find(lane => lane.id === item.first)!;
        return {
          noticeId,
          kind: 'overlap-notice' as const,
          at: new Date().toISOString(),
          lanes: canonical,
          heads: canonical.map(id => lanes.find(lane => lane.id === id)!.head),
          file: item.file,
          regions,
          ...(item.symbols ? { symbols: item.symbols } : {}),
          proposedOrder: [item.first, ...pair.lanes.filter(id => id !== item.first)],
          participants: canonical.map(participant),
          text: `High overlap: ${item.file}; proposed region owner ${owner.id.slice(0, 8)} (${owner.name}). Land ${item.first.slice(0, 8)} first (${item.orderReason}); sync after ${item.first.slice(0, 8)} lands.`,
        };
      }),
    );
  new CoordinationJournal(store).recordOverlaps(alerts);
  return plan.coverage;
}
