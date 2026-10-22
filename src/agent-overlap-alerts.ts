// SPDX-License-Identifier: Apache-2.0
import { currentChannelHead } from './agent-defaults.js';
import { NativeSource } from './native-source.js';
import { digest } from './hash.js';
import { allRecords } from './agent-lifecycle.js';
import { CoordinationJournal } from './agent-coordination-journal.js';
import { savedOverlapPlan } from './agent-overlap-plan.js';
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
export function recordOverlapAlerts(store: WorkStore, laneId: string) {
  const main = currentChannelHead(store, 'main');
  const source = store.native ? new NativeSource(store.root) : undefined;
  const lanes = allRecords<Lane>(store, 'lanes').filter(
    lane =>
      ['active', 'paused', 'ready'].includes(lane.state) && !(main && source?.contains(main, lane.head)),
  );
  const plan = savedOverlapPlan(store, lanes, laneId);
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
          text: `High overlap: ${item.file}; proposed region owner ${owner.id.slice(0, 8)} (${owner.name}). Land ${item.first.slice(0, 8)} first (${item.orderReason}); sync after ${item.first.slice(0, 8)} lands.`,
        };
      }),
    );
  new CoordinationJournal(store).recordOverlaps(alerts);
  return plan.coverage;
}
