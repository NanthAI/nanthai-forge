// SPDX-License-Identifier: Apache-2.0
import type { WorkStore } from './work-store.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';
import { recoverRuns } from './work-run.js';
/** Reconcile retained active runners only; completed history is immutable here. */
export function recoverRecordRuns(store: WorkStore, tx: WorkRecordTransaction) {
  const positions = [
    ...tx.positions('runs', 'queued', 'status'),
    ...tx.positions('runs', 'preparing', 'status'),
    ...tx.positions('runs', 'running', 'status'),
  ];
  const runs = positions.map(position => tx.at('runs', position)),
    previous = runs.map(run => JSON.stringify(run));
  if (!recoverRuns(store, { runs })) return tx;
  runs.forEach((run, index) => {
    if (JSON.stringify(run) !== previous[index]) tx.replace('runs', positions[index]!, run);
  });
  store.commitRecords(tx);
  return store.records();
}
