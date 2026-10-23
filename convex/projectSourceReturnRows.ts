// SPDX-License-Identifier: Apache-2.0
'use node';
import type { IntentRecords } from './projectSourceReturnRecords';
import type { Id } from './_generated/dataModel';
import type { ActionCtx } from './_generated/server';
import type { Cursor } from './projectSourceReturnStep';
import { storeReturnMetadata } from './projectSourceReturnMetadata';
import { workIndexRows, type IndexEntry } from '../src/work-hosted-index';

/** Store full-index output as bounded immutable batches, never a second Work.
 * These pages remain private until the existing staging/final CAS publishes. */
export async function storeOutputRows(
  ctx: ActionCtx,
  c: Cursor,
  rows: Iterable<IndexEntry>,
  partitionId: Id<'projectWorkGenerations'>,
) {
  let batch: IndexEntry[] = [],
    bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    (c.outputRefs ??= []).push(
      await storeReturnMetadata(ctx, c.final.projectId, c.final.owner, partitionId, batch),
    );
    batch = [];
    bytes = 0;
  };
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (batch.length && (batch.length >= 100 || bytes + size > 256 * 1024)) await flush();
    batch.push(row);
    bytes += size;
  }
  await flush();
}
export async function prepareFullReturnRows(
  ctx: ActionCtx,
  c: Cursor,
  partitionId: Id<'projectWorkGenerations'>,
  records?: IntentRecords,
) {
  const rows = workIndexRows(
      c.snapshot.data,
      c.snapshot.manifest,
      [],
      c.snapshot.backup.transport,
      new Map(),
      true,
      !!records,
    ),
    summaries: IndexEntry[] = [],
    counts: Record<string, number> = {};
  let metadata: import('../src/work-hosted-index').IndexMetadata | undefined;
  function* output() {
    let next = rows.next();
    while (!next.done) {
      const row = next.value;
      if (row.collection === 'lanes' || row.collection === 'views') summaries.push(row);
      else {
        counts[row.collection] = (counts[row.collection] ?? 0) + 1;
        yield row;
      }
      next = rows.next();
    }
    metadata = next.value;
  }
  await storeOutputRows(ctx, c, output(), partitionId);
  if (records) {
    (c.outputRefs ??= []).push(...(records.output ?? []));
    for (const [collection, count] of Object.entries(records.counts ?? {})) counts[collection] = count;
  }
  c.metadata = {
    ...metadata!,
    counts,
    ...(records
      ? {
          defaultIntentId: records.defaultIntentId,
        }
      : {}),
  };
  c.diffstats = { records: summaries };
}
