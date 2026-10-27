// SPDX-License-Identifier: Apache-2.0
import type { WorkData, Lane, DependencyPin } from './work-types.js';
import type { WorkStore } from './work-store.js';

const savedCount = Symbol('preview saved checkpoints');
/** Availability from a pinned record header, or a complete legacy Lane. No
 * preview consumer uses checkpoint contents as source or check evidence. */
export const hasPreviewSave = (lane: Lane) =>
  ((lane as Lane & { [savedCount]?: number })[savedCount] ?? lane.checkpoints.length) > 0;

/** Pinned preview inputs and dependency closure. Preview readers need saved/not
 * saved availability, not every old checkpoint or every Intent conversation.
 * This projection is read-only and must never be saved as complete Work. */
export function landingPreviewRecords(store: WorkStore, laneIds: string[]) {
  const tx = store.native ? store.readRecords?.() : undefined;
  if (!tx) return store.load();
  const data = tx.data();
  data.lanes = Array.from({ length: tx.manifest.collections.lanes?.count ?? 0 }, (_, position) => {
    const selected = tx.fieldsAt('lanes', position),
      lane = selected.record;
    // Enumerable symbols survive the pinned-head clone; JSON never exposes them.
    Object.defineProperty(lane, savedCount, { value: selected.counts.checkpoints ?? 0, enumerable: true });
    return lane;
  });
  data.checks = Array.from({ length: tx.manifest.collections.checks?.count ?? 0 }, (_, position) =>
    tx.at('checks', position),
  );
  for (const position of tx.positions('channelMoves', 'main', 'channel').reverse()) {
    const move = tx.at('channelMoves', position);
    if (move.status === 'accepted') {
      data.channelMoves.push(move);
      break;
    }
  }
  const intents = new Set<string>(),
    views = new Set<string>(),
    lanes = new Set<string>();
  const dependency = (pin: DependencyPin) => {
    if (pin.kind === 'view') view(pin.viewId);
    else intent(pin.intentId);
  };
  const intent = (id: string) => {
    if (intents.has(id)) return;
    intents.add(id);
    const selected = tx.find('intents', id)?.record;
    if (!selected) return;
    data.intents.push(selected);
    for (const pin of selected.dependencies ?? []) dependency(pin);
  };
  const view = (id: string) => {
    if (views.has(id)) return;
    views.add(id);
    const selected = tx.find('views', id)?.record;
    if (!selected) return;
    data.views.push(selected);
    for (const pin of selected.dependencies ?? []) dependency(pin);
  };
  const lane = (selected: Lane) => {
    if (lanes.has(selected.id)) return;
    lanes.add(selected.id);
    intent(selected.intentId);
    if (selected.stack && !selected.stack.detached) {
      const parent = data.lanes.find(lane => lane.id === selected.stack!.laneId);
      if (parent) lane(parent);
    } else if (selected.after) {
      const after = selected.after;
      if ('viewId' in after) view(after.viewId);
      else
        for (const sibling of data.lanes.filter(
          lane => lane.intentId === after.intentId && lane.state !== 'abandoned',
        ))
          lane(sibling);
    }
  };
  for (const id of laneIds) {
    const selected = data.lanes.find(lane => lane.id === id);
    if (selected) lane(selected);
  }
  return data as WorkData;
}
