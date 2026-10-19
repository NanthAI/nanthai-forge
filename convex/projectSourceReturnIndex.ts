// SPDX-License-Identifier: Apache-2.0
'use node';
import { workProjection } from './projectSourceProjection';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import type { WorkData } from '../src/work-types';
import type { sourceManifestSchema } from '../src/work-archive-metadata';
import type { z } from 'zod';
import { indexBatches, type IndexEntry } from '../src/work-hosted-index';

const identity = (row: { collection: string; key: string }) => JSON.stringify([row.collection, row.key]);
const equal = (a: IndexEntry, b: IndexEntry) =>
  a.collection === b.collection &&
  a.key === b.key &&
  a.parent === b.parent &&
  a.position === b.position &&
  a.value === b.value &&
  a.status === b.status &&
  a.actor === b.actor;
type ReturnIndexInput = {
  projectId: Id<'hostedProjects'>;
  owner: string;
  expectedBackupId: Id<'projectBackups'>;
  backup: Doc<'projectBackups'>;
  revision: number;
  operationId?: string;
  at?: string;
  data: WorkData;
  manifest: z.infer<typeof sourceManifestSchema>;
  transport?: 'objects';
};
export async function sourceReturnIndex(ctx: ActionCtx, input: ReturnIndexInput) {
  try {
    return await projectIndex(ctx, input);
  } catch (error) {
    if (input.transport === 'objects') throw error;
    // Derived index availability/format is not an additional source-return
    // precondition. The original final mutation still checks current authority
    // and source/Work CAS; failed optimization uses its existing rebuild path.
    return undefined;
  }
}
async function projectIndex(ctx: ActionCtx, input: ReturnIndexInput) {
  const generation: Doc<'projectWorkGenerations'> | null = await ctx.runQuery(
    internal.projectWorkIndexStore.current,
    { projectId: input.projectId, owner: input.owner },
  );
  if (!generation || generation.backupId !== input.expectedBackupId || generation.revision !== input.revision)
    return;
  const stream = await workProjection(ctx, input, input.owner);
  // Native object returns stream View provenance into a private partition.
  // Legacy archives retain their existing incremental comparison behavior.
  if (input.transport === 'objects' && input.manifest.kind === 'forge-native-work-backup') {
    const base = {
      projectId: input.projectId,
      owner: input.owner,
      generationId: generation._id,
      revision: input.revision,
    };
    const partitionId = await ctx.runMutation(internal.projectReturnIndexStage.begin, {
      ...base,
      backupId: input.backup._id,
      localRevision: input.manifest.revision,
      metadata: JSON.stringify(stream.metadata),
      operationId: input.operationId,
      at: input.at,
    });
    if (!partitionId) return;
    let batch = 0;
    for await (const entries of stream.batches()) {
      if (
        !(await ctx.runMutation(internal.projectReturnIndexStage.batch, {
          ...base,
          partitionId,
          batch: batch++,
          entries,
          last: false,
        }))
      )
        return;
    }
    if (
      !(await ctx.runMutation(internal.projectReturnIndexStage.batch, {
        ...base,
        partitionId,
        batch,
        entries: [],
        last: true,
        metadata: JSON.stringify(stream.metadata),
      }))
    )
      return;
    return {
      generationId: generation._id,
      partitionId,
      metadata: JSON.stringify(stream.metadata),
      entries: [],
      removed: [],
    };
  }
  const projection = { metadata: stream.metadata, entries: [] as IndexEntry[] };
  for await (const batch of stream.batches()) projection.entries.push(...batch);
  const remaining = new Map(projection.entries.map(row => [identity(row), row]));
  const staged = async () => {
    const base = {
      projectId: input.projectId,
      owner: input.owner,
      generationId: generation._id,
      revision: input.revision,
    };
    const partitionId: Id<'projectWorkGenerations'> | null = await ctx.runMutation(
      internal.projectReturnIndexStage.begin,
      {
        ...base,
        backupId: input.backup._id,
        localRevision: input.manifest.revision,
        metadata: JSON.stringify(projection.metadata),
      },
    );
    if (!partitionId) return;
    const batches = indexBatches(projection.entries);
    for (const [batch, entries] of batches.entries()) {
      if (
        !(await ctx.runMutation(internal.projectReturnIndexStage.batch, {
          ...base,
          partitionId,
          batch,
          entries,
          last: batch === batches.length - 1,
        }))
      )
        return;
    }
    return {
      generationId: generation._id,
      partitionId,
      metadata: JSON.stringify(projection.metadata),
      entries: [],
      removed: [],
    };
  };
  // Duplicate logical keys cannot use the incremental shortcut. The original
  // full-generation path retains its existing handling of such imported Work.
  if (remaining.size !== projection.entries.length) return;
  const entries: IndexEntry[] = [],
    removed: { collection: string; key: string }[] = [],
    seen = new Set<string>();
  let bytes = 0,
    cursor: string | null = null;
  const fits = () => entries.length + removed.length <= 100 && bytes <= 500000;
  do {
    const page: { entries: IndexEntry[]; cursor: string | null } | null = await ctx.runQuery(
      internal.projectWorkIndexStore.snapshotEntries,
      {
        projectId: input.projectId,
        owner: input.owner,
        generationId: generation._id,
        revision: input.revision,
        cursor,
      },
    );
    if (!page) return;
    for (const old of page.entries) {
      const key = identity(old);
      if (seen.has(key)) return;
      seen.add(key);
      const next = remaining.get(key);
      remaining.delete(key);
      if (!next) {
        const pin = { collection: old.collection, key: old.key };
        removed.push(pin);
        bytes += Buffer.byteLength(JSON.stringify(pin));
      } else if (!equal(old, next)) {
        entries.push(next);
        bytes += Buffer.byteLength(JSON.stringify(next));
      }
      if (!fits()) return staged();
    }
    cursor = page.cursor;
  } while (cursor !== null);
  for (const row of remaining.values()) {
    entries.push(row);
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (!fits()) return staged();
  }
  // This is an internal RPC batch budget, never a retained Work capacity limit.
  return { generationId: generation._id, metadata: JSON.stringify(projection.metadata), entries, removed };
}
