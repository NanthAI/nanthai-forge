// SPDX-License-Identifier: Apache-2.0
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';

export function updateRemoteRun(store: WorkStore, run: CheckRun) {
  store.locked(() => {
    const tx = store.records(),
      selected = tx.find('runs', run.id)!;
    // Cancellation is owned by the latest record, not this controller's cached copy.
    const { cancelRequested, cancellation } = selected.record;
    tx.replace('runs', selected.position, {
      ...run,
      ...(cancelRequested ? { cancelRequested, cancellation } : {}),
    });
    store.commitRecords(tx);
  });
}
