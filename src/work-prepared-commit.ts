// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import { workLockWaitMs } from './work-lock.js';
import type { WorkStore } from './work-store.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';

/** Prepare immutable record pages before admission. Retry metadata CAS conflicts
 * without rerunning the caller's source capture, merge or materialization. */
export function preparedRecordCommit<T>(
  store: WorkStore,
  operation: string,
  prepare: (tx: WorkRecordTransaction) => () => T,
): T {
  const end = Date.now() + (workLockWaitMs() || 1000);
  for (;;) {
    let tx = store.readRecords();
    if (!tx) tx = store.locked(() => store.records(), { operation: `${operation} migration` });
    try {
      let publish: () => T;
      try {
        publish = prepare(tx);
      } catch (error) {
        // An error from an obsolete snapshot is not authoritative.
        return store.locked(
          () => {
            tx.assertCurrent();
            throw error;
          },
          { operation },
        );
      }
      return store.locked(
        () => {
          tx.assertCurrent();
          return publish();
        },
        { operation },
      );
    } catch (error) {
      if (!(error instanceof ForgeError && error.code === 'WORK_STALE')) throw error;
      if (Date.now() >= end)
        throw new ForgeError(
          'WORK_STALE',
          `${operation} could not commit before lock patience expired. Retry the original operation to reconcile; existing work is preserved.`,
        );
    }
  }
}
