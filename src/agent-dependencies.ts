// SPDX-License-Identifier: Apache-2.0
import { stackLanding } from './agent-stack.js';
import { invariant } from './errors.js';
import { allRecords } from './agent-lifecycle.js';
import { landedViews } from './agent-landed-views.js';
import { currentChannelHead } from './agent-defaults.js';
import type { WorkStore } from './work-store.js';
import type { Lane, WorkView } from './work-types.js';

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
    const lane = store.select('lanes', laneId, 'id', true);
    const after = lane?.after;
    return after || (lane?.stack && !lane.stack.detached)
      ? [{ laneId, after: after ?? { intentId: store.select('lanes', lane!.stack!.laneId)!.intentId } }]
      : [];
  });
  if (!dependencies.length) return [];
  const head = currentChannelHead(store, channel);
  const landed = head ? landedViews(store, channel, head) : undefined;
  return dependencies.filter(({ laneId, after }) => {
    const lane = store.select('lanes', laneId)!;
    if (lane.stack && !lane.stack.detached) {
      if (!stackLanding(store, lane)) return true;
      const parent = store.select('lanes', lane.stack.laneId);
      if ('intentId' in after && after.intentId === parent?.intentId) return false;
    }

    if ('viewId' in after) return !landed?.results.some(({ view }) => view.id === after.viewId);
    const lanes = allRecords<Lane>(store, 'lanes').filter(lane => lane.intentId === after.intentId);
    return (
      !lanes.length ||
      lanes.some(
        lane =>
          // Batch Candidates can carry this Intent's inputs under another Intent.
          !landed?.results.some(
            ({ view, alreadyOnMain }) =>
              view.inputs.some(pin => pin.laneId === lane.id && pin.head === lane.head) &&
              (alreadyOnMain || landed.contains(lane.head)),
          ),
      )
    );
  });
}

/** Source containment alone cannot establish that a Lane participated in a landing. */
export function acceptedInputs(store: WorkStore, inputs: WorkView['inputs'], channel: string, head: string) {
  const { results } = landedViews(store, channel, head);
  return inputs.every(input =>
    results.some(({ view }) =>
      view.inputs.some(pin => pin.laneId === input.laneId && pin.head === input.head),
    ),
  );
}
