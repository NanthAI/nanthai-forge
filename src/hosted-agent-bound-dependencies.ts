// SPDX-License-Identifier: Apache-2.0
import { waitingDependencies, validateAfter, acceptedInputs } from './agent-dependencies.js';
import { currentChannelHead } from './agent-defaults.js';
import { landedViews } from './agent-landed-views.js';
import { allRecords } from './agent-lifecycle.js';
import type { WorkStore } from './work-store.js';
import type { Lane } from './work-types.js';
import type { RetainedBoundSubmission } from './hosted-agent-bound.js';

/** Preserve native ordering declarations while their saved records remain the
 * local cache. An unresolved dependency is pending, never an implicit accept. */
export function waitingBoundDependencies(store: WorkStore, retained: RetainedBoundSubmission) {
  const waiting = waitingDependencies(
    store,
    retained.inputs.map(pin => pin.laneId),
  );
  const after = retained.command.after as Lane['after'];
  if (!after) return waiting;
  validateAfter(store, after, retained.inputs[0]?.intentId);
  const head = currentChannelHead(store, 'main');
  const accepted =
    head &&
    ('viewId' in after
      ? landedViews(store, 'main', head).results.some(result => result.view.id === after.viewId)
      : (() => {
          const lanes = allRecords<Lane>(store, 'lanes').filter(lane => lane.intentId === after.intentId);
          return (
            lanes.length > 0 &&
            acceptedInputs(
              store,
              lanes.map(lane => ({ laneId: lane.id, head: lane.head })),
              'main',
              head,
            )
          );
        })());
  return accepted ? waiting : [...waiting, { laneId: retained.inputs[0]!.laneId, after }];
}
