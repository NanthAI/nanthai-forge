// SPDX-License-Identifier: Apache-2.0
import { regionsNear, type PredictiveOverlap } from './agent-predictive-overlap.js';
export type OverlapAlert = {
  noticeId: string;
  kind: 'overlap-notice';
  class?: 'blocking' | 'advisory';
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
