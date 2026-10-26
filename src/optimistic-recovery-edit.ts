// SPDX-License-Identifier: Apache-2.0
import { editRecordProjection } from './work-record-edit.js';
import { postAcceptRecords, preparePostAcceptRecords } from './post-accept-records.js';
import type { WorkStore } from './work-store.js';
import type { WorkData } from './work-types.js';

export async function recoveryEdit<T>(
  store: WorkStore,
  edit: (data: WorkData) => T,
  viewIds: string[] = [],
  moveIds: string[] = [],
) {
  const prepared = store.readRecords();
  if (prepared) {
    try {
      await preparePostAcceptRecords(store, prepared);
    } finally {
      prepared.dispose();
    }
  }
  return store.lockedAsync(() => {
    const tx = store.readRecords();
    if (!tx) {
      const data = store.load(),
        result = edit(data);
      data.revision++;
      store.save(data);
      return result;
    }
    try {
      const data = postAcceptRecords(store, tx);
      for (const id of moveIds) {
        const move = tx.find('channelMoves', id)?.record;
        if (move && !data.channelMoves.some(item => item.id === id)) data.channelMoves.push(move);
      }
      for (const id of viewIds) {
        const view = tx.find('views', id)?.record;
        if (view && !data.views.some(item => item.id === id)) data.views.push(view);
      }
      data.lanes = [...new Set(data.views.flatMap(view => view.inputs.map(pin => pin.laneId)))].flatMap(
        id => tx.find('lanes', id)?.record ?? [],
      );
      for (const id of new Set(data.lanes.map(lane => lane.intentId))) {
        const intent = tx.find('intents', id)?.record;
        if (!intent) continue;
        const position = data.intents.findIndex(item => item.id === id);
        // Scheduling may already contain a compact, read-only copy of this Intent.
        if (position < 0) data.intents.push(intent);
        else data.intents[position] = intent;
      }
      return editRecordProjection(
        store,
        tx,
        data,
        ['channelMoves', 'views', 'lanes', 'intents'],
        edit,
        undefined,
        true,
      );
    } finally {
      tx.dispose();
    }
  });
}
