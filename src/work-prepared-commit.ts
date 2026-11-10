// SPDX-License-Identifier: Apache-2.0
import { exhaustedWorkRetries } from './friction-retry.js';
import { workProgressIdentity } from './work-progress.js';
import { ForgeError } from './errors.js';
import { workLockWaitMs } from './work-lock.js';
import type { WorkStore } from './work-store.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';

type StoreAccess = Pick<WorkStore, 'locked' | 'readRecords' | 'records'>;

/** Prepare immutable record pages before admission. Retry metadata CAS conflicts
 * and transient admission contention without rerunning the caller's source
 * capture, merge or materialization. */
export function preparedRecordCommit<T>(
  store: StoreAccess,
  operation: string,
  prepare: (tx: WorkRecordTransaction) => () => T,
): T {
  let end: number | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
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
      } finally {
        tx.dispose();
      }
    } catch (error) {
      if (
        !(error instanceof ForgeError && ['WORK_BUSY', 'WORK_STALE', 'SOURCE_CHANGED'].includes(error.code))
      )
        throw error;
      end ??= Date.now() + (workLockWaitMs() || 1000);
      if (Date.now() >= end) {
        const operationId = workProgressIdentity().operationId;
        if (operationId) exhaustedWorkRetries(operationId, 'WORK_BUSY', attempt);
        throw new ForgeError(
          'WORK_BUSY',
          `${operation} could not commit before lock patience expired. Retry the original operation to reconcile; existing work is preserved.`,
        );
      }
      // Independent drivers should not restage and rejoin FIFO admission in lockstep.
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Math.min(1 + Math.random() * 24, end - Date.now()),
      );
    }
  }
}
