// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';

type StoreAccess = Pick<WorkStore, 'commitRecords' | 'locked' | 'records'>;

export function updateRemoteRun(store: StoreAccess, run: CheckRun) {
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
