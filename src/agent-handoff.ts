// SPDX-License-Identifier: Apache-2.0
import { decisionContext } from './decision-types.js';
import { decisionRecords } from './decisions.js';
import { invariant } from './errors.js';
import { latestHandoff } from './agent-handoff-types.js';
import type { WorkStore } from './work-store.js';

type StoreAccess = Pick<
  WorkStore,
  'commitRecords' | 'load' | 'locked' | 'observing' | 'readRecords' | 'records' | 'select'
>;

export function readHandoff(store: StoreAccess, laneId: string) {
  return store.observing(() => {
    const tx = store.readRecords(),
      data = tx ? undefined : store.load(),
      lane = tx?.fields('lanes', laneId)?.record ?? data?.lanes.find(lane => lane.id === laneId);
    invariant(lane, 'NOT_FOUND', 'Lane not found.');
    const intent =
      tx?.find('intents', lane.intentId)?.record ?? data?.intents.find(intent => intent.id === lane.intentId);
    invariant(intent, 'NOT_FOUND', 'Intent not found.');
    return {
      revision: tx?.revision ?? data!.revision,
      result: {
        laneId,
        decisions: decisionContext(decisionRecords(store), lane.intentId),
        handoff: latestHandoff(intent.notes, laneId),
        ...(lane.stack
          ? {
              parentHandoff: (() => {
                const parent =
                  tx?.fields('lanes', lane.stack.laneId)?.record ??
                  data?.lanes.find(item => item.id === lane.stack!.laneId);
                const notes = parent
                  ? ((
                      tx?.find('intents', parent.intentId)?.record ??
                      data?.intents.find(item => item.id === parent.intentId)
                    )?.notes ?? [])
                  : [];
                return parent ? latestHandoff(notes, parent.id) : null;
              })(),
            }
          : {}),
      },
    };
  });
}
