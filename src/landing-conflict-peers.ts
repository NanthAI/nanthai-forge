// SPDX-License-Identifier: Apache-2.0
import { savedOverlapPlan } from './agent-overlap-plan.js';
import { NativeSource } from './native-source.js';
import type { WorkStore } from './work-store.js';
import type { WorkView } from './work-types.js';
/** Attribute an actual merge conflict to saved, accepted overlapping inputs. */
export function landingConflictPeers(store: WorkStore, main: string, inputs: WorkView['inputs']) {
  if (!store.native) return [];
  const data = store.load(),
    source = new NativeSource(store.root);
  const mine = new Set(inputs.map(pin => pin.laneId));
  const accepted = data.channelMoves
    .filter(move => move.status === 'accepted' && source.contains(main, move.head))
    .flatMap(move => data.views.find(view => view.id === move.viewId)?.inputs ?? [])
    .filter(pin => !mine.has(pin.laneId));
  const pins = new Map([...accepted, ...inputs].map(pin => [pin.laneId, pin.head]));
  const plan = savedOverlapPlan(
    store,
    data.lanes.filter(lane => pins.has(lane.id)).map(lane => ({ ...lane, head: pins.get(lane.id)! })),
  );
  return [
    ...new Set(
      plan.pairs
        .filter(pair => pair.lanes.some(id => mine.has(id)))
        .flatMap(pair => pair.lanes.filter(id => !mine.has(id))),
    ),
  ];
}
