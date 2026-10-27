// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { isCompactWorkRecord } from './work-record-transaction.js';
import type { WorkStore } from './work-store.js';
import type { WorkData } from './work-types.js';
import type { WorkCollection, WorkRecordTransaction } from './work-record-transaction.js';

/** Publish only changed selected records. The projection is never saved as a
 * complete Work snapshot. A caller already owning the lock can stage against
 * its fresh selected pointer without another admission or whole-Work prepare. */
export function editRecordProjection<T>(
  store: WorkStore,
  tx: WorkRecordTransaction,
  data: WorkData,
  writable: readonly WorkCollection[],
  edit: (data: WorkData) => T,
  beforePublish?: () => void,
  underLock = false,
): T | Promise<T> {
  const before = new Map(
    writable.map(collection => [
      collection,
      new Map((data[collection] ?? []).map(record => [record.id, JSON.stringify(record)])),
    ]),
  );
  const result = edit(data);
  // A projection publishes replacements and appends only; removing a selected
  // record would otherwise be silently dropped.
  for (const collection of writable) {
    const ids = new Set((data[collection] ?? []).map(record => record.id));
    invariant(
      [...before.get(collection)!.keys()].every(id => ids.has(id)),
      'INVALID_WORK_STORE',
      `A selected-record edit cannot remove ${collection} records.`,
    );
  }
  const changes = writable.flatMap(collection =>
    (data[collection] ?? []).flatMap(record =>
      before.get(collection)!.get(record.id) === JSON.stringify(record) ? [] : [{ collection, record }],
    ),
  );
  if (changes.length) {
    // A compact scheduling record is not a replacement base: verify only the
    // records being changed, without hydrating unrelated retained histories.
    for (const { collection, record } of changes) {
      const position = tx.positions(collection, record.id)[0];
      invariant(
        !isCompactWorkRecord(record) &&
          (position === undefined ||
            before.get(collection)!.get(record.id) === JSON.stringify(tx.at(collection, position))),
        'INVALID_WORK_STORE',
        `A selected-record edit requires a full ${collection} record before replacement.`,
      );
    }
    tx.setSchema(data.schema);
    for (const { collection, record } of changes) {
      const position = tx.positions(collection, record.id)[0];
      if (position === undefined) tx.append(collection, record);
      else tx.replace(collection, position, record);
    }
    store.prepareCommitRecords(tx);
  }
  const publish = () => {
    beforePublish?.();
    if (changes.length) store.commitRecords(tx, undefined, { prepared: true });
    else tx.assertCurrent();
    return result;
  };
  return underLock ? publish() : store.lockedAsync(publish);
}
