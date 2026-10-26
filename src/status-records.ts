// SPDX-License-Identifier: Apache-2.0
import type { WorkCollection, WorkRecordTransaction } from './work-record-transaction.js';
import type { WorkView } from './work-types.js';
import { pageSize } from './work-records.js';

/** Page positions before reading records. Offsets count backwards from newest. */
export function statusPositions(
  tx: WorkRecordTransaction,
  collection: WorkCollection,
  offset: number,
  limit: number,
  selected?: number[],
) {
  const total = selected?.length ?? tx.manifest.collections[collection]?.count ?? 0;
  const length = Math.max(0, Math.min(limit, total - offset));
  return {
    total,
    offset,
    more: offset + length < total,
    nextOffset: offset + length < total ? offset + length : null,
    items: Array.from({ length }, (_, index) =>
      selected ? selected[total - offset - index - 1]! : total - offset - index - 1,
    ),
  };
}

/** Saved Candidate pins without its potentially large diff or histories. */
export function statusView(tx: WorkRecordTransaction, position: number) {
  const { record, counts } = tx.fieldsAt('views', position);
  const array = <T>(field: string) =>
    Array.from(
      { length: Math.min(pageSize, counts[field] ?? 0) },
      (_, index) => tx.fieldAt('views', position, field, index) as T,
    );
  return {
    ...record,
    details: '',
    inputs: array<WorkView['inputs'][number]>('inputs'),
    dependencies: array<NonNullable<WorkView['dependencies']>[number]>('dependencies'),
    inputCount: counts.inputs ?? 0,
    dependencyCount: counts.dependencies ?? 0,
    detailDeferred: true,
  };
}

/** Main is selected independently of any recent-history page. */
export function statusMain(tx: WorkRecordTransaction) {
  const positions = tx.positions('channelMoves', 'main', 'channel');
  for (let index = positions.length - 1; index >= 0; index--) {
    const move = tx.fieldsAt('channelMoves', positions[index]!).record;
    if (move.status === 'accepted') return move;
  }
}
