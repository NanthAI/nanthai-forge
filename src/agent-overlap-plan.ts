// SPDX-License-Identifier: Apache-2.0
import { PeersSource } from './agent-peers-source.js';
import { PeersCache } from './agent-peers-cache.js';
import { regionSummary } from './agent-region-summary.js';
import { overlapOrder, predictiveOverlaps, type PredictiveOverlap } from './agent-predictive-overlap.js';
import type { WorkStore } from './work-store.js';
import type { Lane } from './work-types.js';

export type OverlapPlan = {
  order: string[];
  pairs: { lanes: [string, string]; overlaps: PredictiveOverlap[] }[];
  groups: { order: string[]; paths: string[] }[];
  coverage: 'local' | 'local-incomplete';
};
/** Saved source only; shared by publication, landing and the pending-work view. */
export function savedOverlapPlan(store: WorkStore, lanes: Lane[], focus?: string): OverlapPlan {
  const plan: OverlapPlan = { order: [], pairs: [], groups: [], coverage: 'local' };
  if (!lanes.length) return plan;
  const source = new PeersSource(store, lanes[0]!.base),
    cache = new PeersCache(store.root);
  const summaries = new Map<string, ReturnType<typeof regionSummary>>();
  for (const lane of lanes) {
    try {
      summaries.set(
        lane.id,
        regionSummary(source, cache, lane.base, lane.head, () => [
          source.state(lane.base).files,
          source.state(lane.head).files,
        ]),
      );
    } catch {
      plan.coverage = 'local-incomplete';
    }
  }
  const ordered = [...lanes].sort((a, b) => {
    const mine = summaries.get(a.id),
      theirs = summaries.get(b.id);
    if (!mine || !theirs) return a.id.localeCompare(b.id);
    return overlapOrder(a, mine, b, theirs).first === a.id ? -1 : 1;
  });
  plan.order = ordered.map(lane => lane.id);
  for (let i = 0; i < ordered.length; i++)
    for (const peer of ordered.slice(i + 1)) {
      if (focus && ordered[i]!.id !== focus && peer.id !== focus) continue;
      const lane = ordered[i]!,
        mine = summaries.get(lane.id),
        theirs = summaries.get(peer.id);
      if (!mine || !theirs) continue;
      try {
        const predictions = predictiveOverlaps(source, cache, lane, mine, peer, theirs);
        if (predictions.some(item => item.risk === 'unknown')) plan.coverage = 'local-incomplete';
        const overlaps = predictions.filter(item => item.risk === 'high');
        if (overlaps.length) plan.pairs.push({ lanes: [lane.id, peer.id], overlaps });
      } catch {
        plan.coverage = 'local-incomplete';
      }
    }
  const remaining = new Set(plan.pairs.flatMap(pair => pair.lanes));
  for (const id of plan.order) {
    if (!remaining.delete(id)) continue;
    const group = new Set([id]);
    for (const member of group)
      for (const pair of plan.pairs) {
        if (!pair.lanes.includes(member)) continue;
        for (const other of pair.lanes) if (remaining.delete(other)) group.add(other);
      }
    plan.groups.push({
      order: plan.order.filter(lane => group.has(lane)),
      paths: [
        ...new Set(
          plan.pairs
            .filter(pair => pair.lanes.every(lane => group.has(lane)))
            .flatMap(pair => pair.overlaps.map(item => item.file)),
        ),
      ].sort(),
    });
  }
  return plan;
}
export function highOverlap(plan: OverlapPlan, left: string[], right: string[]) {
  return plan.pairs.some(
    ({ lanes: [a, b] }) => (left.includes(a) && right.includes(b)) || (left.includes(b) && right.includes(a)),
  );
}

/** Stable dependency order for groups; disjoint groups retain submission order. */
export function orderOverlapGroups<T>(plan: OverlapPlan, entries: T[], ids: (entry: T) => string[]): T[] {
  const precedes = (a: T, b: T) =>
    plan.pairs.some(
      pair =>
        ids(a).includes(pair.overlaps[0]!.first) &&
        pair.lanes.some(id => ids(b).includes(id) && id !== pair.overlaps[0]!.first),
    );
  const remaining = [...entries],
    ordered: T[] = [];
  while (remaining.length) {
    const index = remaining.findIndex(entry => !remaining.some(other => precedes(other, entry)));
    ordered.push(remaining.splice(index < 0 ? 0 : index, 1)[0]!);
  }
  return ordered;
}
