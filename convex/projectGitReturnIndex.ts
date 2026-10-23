// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { WorkData } from '../src/work-types';
import type { manifestSchema } from '../src/work-archive-metadata';
import type { z } from 'zod';
import { internal } from './_generated/api';
import { materializeWork, indexBatches, type IndexEntry } from '../src/work-hosted-index';
const equal = (a: IndexEntry, b: IndexEntry) =>
  a.collection === b.collection &&
  a.key === b.key &&
  a.parent === b.parent &&
  a.position === b.position &&
  a.value === b.value &&
  a.status === b.status &&
  a.actor === b.actor;
const identity = (row: { collection: string; key: string }) => JSON.stringify([row.collection, row.key]);
/** Git-backed exchange has no native States or byte-derived provenance. Keep its
 * existing Work-metadata projection without invoking any source/object reader. */
export async function gitReturnIndex(
  ctx: ActionCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    owner: string;
    expectedBackupId: Id<'projectBackups'>;
    backup: Doc<'projectBackups'>;
    revision: number;
    operationId: string;
    at: string;
    data: WorkData;
    manifest: z.infer<typeof manifestSchema>;
  },
) {
  const generation: Doc<'projectWorkGenerations'> | null = await ctx.runQuery(
    internal.projectWorkIndexStore.current,
    { projectId: input.projectId, owner: input.owner },
  );
  if (!generation || generation.backupId !== input.expectedBackupId || generation.revision !== input.revision)
    return;
  const projection = materializeWork(input.data, input.manifest, [], input.backup.transport);
  const remaining = new Map(projection.entries.map(row => [identity(row), row]));
  if (remaining.size !== projection.entries.length) return;
  const entries: IndexEntry[] = [],
    removed: { collection: string; key: string }[] = [];
  const base = {
    projectId: input.projectId,
    owner: input.owner,
    generationId: generation._id,
    revision: input.revision,
  };
  const staged = async () => {
    const partitionId = await ctx.runMutation(internal.projectReturnIndexStage.begin, {
      ...base,
      backupId: input.backup._id,
      localRevision: input.manifest.revision,
      metadata: JSON.stringify(projection.metadata),
      operationId: input.operationId,
      at: input.at,
    });
    if (!partitionId) return;
    const batches = indexBatches(projection.entries);
    for (const [batch, rows] of batches.entries())
      if (
        !(await ctx.runMutation(internal.projectReturnIndexStage.batch, {
          ...base,
          partitionId,
          batch,
          entries: rows,
          last: batch === batches.length - 1,
        }))
      )
        return;
    return {
      generationId: generation._id,
      partitionId,
      metadata: JSON.stringify(projection.metadata),
      entries: [],
      removed: [],
    };
  };
  let cursor: string | null = null,
    bytes = 0;
  do {
    const page: { entries: IndexEntry[]; cursor: string | null } | null = await ctx.runQuery(
      internal.projectWorkIndexStore.snapshotEntries,
      { ...base, cursor },
    );
    if (!page) return;
    for (const old of page.entries) {
      const key = identity(old),
        next = remaining.get(key);
      remaining.delete(key);
      if (!next) {
        const pin = { collection: old.collection, key: old.key };
        removed.push(pin);
        bytes += Buffer.byteLength(JSON.stringify(pin));
      } else if (!equal(old, next)) {
        entries.push(next);
        bytes += Buffer.byteLength(JSON.stringify(next));
      }
      if (entries.length + removed.length > 100 || bytes > 500000) return staged();
    }
    cursor = page.cursor;
  } while (cursor !== null);
  for (const row of remaining.values()) {
    entries.push(row);
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (entries.length + removed.length > 100 || bytes > 500000) return staged();
  }
  return { generationId: generation._id, metadata: JSON.stringify(projection.metadata), entries, removed };
}
