import { postAcceptMoves } from './post-accept-coverage.js';
// SPDX-License-Identifier: Apache-2.0
import { previewMeasurements } from './preview-accounting.js';
import { PeersCache } from './agent-peers-cache.js';
import { pageSize } from './work-records.js';
import type { WorkCollection, WorkRecord, WorkRecordTransaction } from './work-record-transaction.js';

/** Existing immutable page cache: at most one page is hydrated on a cache miss.
 * Keys include the projection version; no idle observers or full Work load. */
export function accountingRecords<K extends WorkCollection, T>(
  root: string,
  tx: WorkRecordTransaction,
  collection: K,
  project: (row: WorkRecord<K>) => T,
): T[] {
  const cache = new PeersCache(root),
    index = tx.manifest.collections[collection];
  return (index?.pages ?? []).flatMap((hash, page) => {
    const key = `accounting-page-v4:${collection}:${hash}`,
      cached = cache.read<T[]>(key);
    if (cached) return cached;
    const rows = Array.from({ length: Math.min(pageSize, index!.count - page * pageSize) }, (_, offset) =>
      project(tx.at(collection, page * pageSize + offset)),
    );
    cache.write(key, rows);
    return rows;
  });
}
export function accountingContext(root: string, tx: WorkRecordTransaction) {
  return {
    batches: accountingRecords(
      root,
      tx,
      'landingBatches',
      ({ id, status, entryIds, prefixes, diagnosis }) => ({
        id,
        status,
        entryIds,
        prefixes,
        ...(diagnosis
          ? {
              diagnosis: {
                nodes: diagnosis.nodes.map(({ runId, parentId }) => ({
                  runId,
                  ...(parentId ? { parentId } : {}),
                })),
              },
            }
          : {}),
      }),
    ),
    entries: accountingRecords(root, tx, 'landingEntries', row => row),
    moves: postAcceptMoves(
      accountingRecords(
        root,
        tx,
        'channelMoves',
        ({ id, status, at, channel, postAccept, postAcceptRunId, postAcceptAuditRunId }) => ({
          id,
          status,
          at,
          channel,
          ...(postAccept ? { postAccept } : {}),
          ...(postAcceptRunId ? { postAcceptRunId } : {}),
          ...(postAcceptAuditRunId ? { postAcceptAuditRunId } : {}),
        }),
      ),
    ),
    previews: previewMeasurements(tx.directory).rows,
  };
}
