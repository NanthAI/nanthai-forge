// SPDX-License-Identifier: Apache-2.0
import { savedOverlapPlan, highOverlap, orderOverlapGroups } from './agent-overlap-plan.js';
import type { WorkStore } from './work-store.js';
import type { WorkData } from './work-types.js';
import type { LandingEntry } from './landing-batch-types.js';
/** Pinned queued heads, not a later edit of the Lane, determine scheduling. */
export function landingOverlap(store: WorkStore, data: WorkData, entries: LandingEntry[]) {
  const pins = new Map(
    entries
      .flatMap(entry => data.views.find(view => view.id === entry.viewId)?.inputs ?? [])
      .map(pin => [pin.laneId, pin.head]),
  );
  const lanes = data.lanes
    .filter(lane => pins.has(lane.id))
    .map(lane => ({ ...lane, head: pins.get(lane.id)! }));
  const plan = savedOverlapPlan(store, lanes);
  const ids = (entry: LandingEntry) =>
    data.views.find(view => view.id === entry.viewId)?.inputs.map(pin => pin.laneId) ?? [];
  const ordered = orderOverlapGroups(plan, entries, ids);
  return { plan, ordered, overlaps: (a: LandingEntry, b: LandingEntry) => highOverlap(plan, ids(a), ids(b)) };
}
