// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { allRecords } from './agent-lifecycle.js';
import { NativeSource } from './native-source.js';
import { gitIsAncestor } from './work-git.js';
import { currentChannelHead } from './agent-defaults.js';
import type { WorkStore } from './work-store.js';
import type { Lane, WorkData, WorkView } from './work-types.js';

type After = NonNullable<Lane['after']>;
export function validateAfter(store: WorkStore, after: After, intentId?: string) {
  if ('intentId' in after) {
    invariant(store.select('intents', after.intentId), 'NOT_FOUND', 'Dependency Intent not found.');
    invariant(after.intentId !== intentId, 'BAD_ARGUMENT', 'An Intent cannot wait for itself.');
  } else invariant(store.select('views', after.viewId), 'NOT_FOUND', 'Dependency Candidate not found.');
}
/** Landing dependencies are Work records, not mutable source-composition pins.
 * A dependency must have landed in the destination Channel's retained history. */
export function waitingDependencies(store: WorkStore, laneIds: string[], channel = 'main') {
  const dependencies = laneIds.flatMap(laneId => {
    const after = store.select('lanes', laneId, 'id', true)?.after;
    return after ? [{ laneId, after }] : [];
  });
  if (!dependencies.length) return [];
  const moves = allRecords<WorkData['channelMoves'][number]>(store, 'channelMoves').filter(
    move => move.channel === channel && move.status === 'accepted',
  );
  const head = currentChannelHead(store, channel);
  const ancestry = head && store.native ? new NativeSource(store.root).ancestry() : undefined;
  const contains = (candidate: string) =>
    !!head && (ancestry ? ancestry.contains(head, candidate) : gitIsAncestor(store.root, candidate, head));
  const views = allRecords<WorkView>(store, 'views');
  return dependencies.filter(({ after }) => {
    if ('viewId' in after) return !moves.some(move => move.viewId === after.viewId && contains(move.head));
    const landedViews = views.filter(
      view =>
        view.intentId === after.intentId &&
        moves.some(move => move.viewId === view.id && contains(move.head)),
    );
    const lanes = allRecords<Lane>(store, 'lanes').filter(lane => lane.intentId === after.intentId);
    return (
      !lanes.length ||
      lanes.some(
        lane =>
          !contains(lane.head) ||
          !landedViews.some(view =>
            view.inputs.some(pin => pin.laneId === lane.id && pin.head === lane.head),
          ),
      )
    );
  });
}

/** Source containment alone cannot establish that a Lane participated in a landing. */
export function acceptedInputs(store: WorkStore, inputs: WorkView['inputs'], channel: string, head: string) {
  const ancestry = store.native ? new NativeSource(store.root).ancestry() : undefined;
  const moves = allRecords<WorkData['channelMoves'][number]>(store, 'channelMoves').filter(
    move =>
      move.channel === channel &&
      move.status === 'accepted' &&
      (ancestry ? ancestry.contains(head, move.head) : gitIsAncestor(store.root, move.head, head)),
  );
  const views = moves.flatMap(move => {
    const view = store.select('views', move.viewId);
    return view ? [view] : [];
  });
  return inputs.every(input =>
    views.some(view => view.inputs.some(pin => pin.laneId === input.laneId && pin.head === input.head)),
  );
}
