import { digest } from './hash.js';
// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { compactDetailPage, slimWorkFormat } from './work-record-details.js';
import { detailWriter } from './work-detail-store.js';
import type { WorkStore } from './work-store.js';
import type { WorkData } from './work-types.js';

type Progress = { collection: number; offset: number; id: string; fromSchema: number };
const collections = ['runs', 'automaticActions'] as const;
/** Each finite page publishes its cursor atomically with its converted records.
 * Lost replies replay the selected cursor; objects are immutable and deduplicated.
 * Historical pointers and receipts are never rewritten. Call under the Work lock. */
export function migrateWorkDetails(store: WorkStore, pageSize = 128) {
  invariant(
    store.native,
    'UNSUPPORTED_NATIVE_WORK',
    'Record detail migration applies to a native Work owner.',
  );
  invariant(
    Number.isSafeInteger(pageSize) && pageSize > 0,
    'BAD_ARGUMENT',
    'Choose a positive migration page size.',
  );
  const tx = store.readRecords();
  if (!tx) return { complete: false, migrated: 0 };
  const raw = tx.manifest.fields.workDetailMigration as Progress | undefined;
  if (!raw && tx.manifest.fields.workDetailsMigrated === true) return { complete: true, migrated: 0 };
  const input = digest(store.pointer()!);
  const progress = raw ?? {
    collection: 0,
    offset: 0,
    id: `${input.slice(0, 8)}-${input.slice(8, 12)}-5${input.slice(13, 16)}-a${input.slice(17, 20)}-${input.slice(20, 32)}`,
    fromSchema: Number(tx.manifest.fields.schema),
  };
  invariant(
    Number.isSafeInteger(progress.collection) &&
      progress.collection >= 0 &&
      progress.collection < collections.length &&
      Number.isSafeInteger(progress.offset) &&
      progress.offset >= 0,
    'INVALID_WORK_STORE',
    'The retained migration cursor is invalid.',
  );
  const collection = collections[progress.collection];
  if (!collection) return { complete: true, migrated: 0 };
  const count = tx.manifest.collections[collection]?.count ?? 0;
  const end = Math.min(count, progress.offset + pageSize);
  const put = detailWriter(store.directory);
  tx.setSchema(slimWorkFormat(Number(tx.manifest.fields.schema)) as WorkData['schema']);
  const records = Array.from({ length: end - progress.offset }, (_, index) =>
    tx.at(collection, progress.offset + index),
  );
  const compact = compactDetailPage(collection, records, put) as typeof records;
  tx.replacePage(collection, progress.offset, compact);
  const next =
    end < count
      ? { collection: progress.collection, offset: end }
      : { collection: progress.collection + 1, offset: 0 };
  const complete = next.collection === collections.length;
  if (complete) {
    tx.manifest.fields.workDetailsMigrated = true;
    tx.manifest.fields.workDetailMigrationReceipt = {
      id: progress.id,
      converter: 'work-details-v1',
      fromSchema: progress.fromSchema,
      revision: tx.revision,
    };
    if (!tx.manifest.keys.includes('workDetailMigrationReceipt'))
      tx.manifest.keys.push('workDetailMigrationReceipt');
    if (!tx.manifest.keys.includes('workDetailsMigrated')) tx.manifest.keys.push('workDetailsMigrated');
    delete tx.manifest.fields.workDetailMigration;
    tx.manifest.keys = tx.manifest.keys.filter(key => key !== 'workDetailMigration');
  } else {
    tx.manifest.fields.workDetailMigration = { ...progress, ...next };
    if (!tx.manifest.keys.includes('workDetailMigration')) tx.manifest.keys.push('workDetailMigration');
  }
  store.commitRecords(tx, tx.revision, { advisory: false });
  return { complete, migrated: end - progress.offset };
}
