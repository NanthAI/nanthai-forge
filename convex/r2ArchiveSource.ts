// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Id } from './_generated/dataModel';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalQuery, type ActionCtx } from './_generated/server';
import { accessibleProject } from './projectAuthority';
import { r2Config, presignGet } from './r2';
import { blobStore, type BlobId } from './blobStore';
import { invariant } from '../src/errors';

/** A committed R2 archive named by `r2archive:<row id>`; the row's own R2 record is the only source. */
export const resolve = internalQuery({
  args: { storageId: v.string(), actor: v.union(v.string(), v.null()) },
  returns: v.union(
    v.null(),
    v.object({ digest: v.string(), size: v.number(), url: v.string(), purged: v.boolean() }),
  ),
  handler: async (ctx, { storageId, actor }) => {
    if (!storageId.startsWith('r2archive:')) return null;
    const row = await ctx.db.get(storageId.slice(10) as Id<'projectBackups'> | Id<'projectProposals'>);
    invariant(row, 'PROJECT_UNAVAILABLE', 'Original archive is unavailable.');
    const source = 'archiveReceipt' in row && row.transport === 'objects' ? row.archiveReceipt : row;
    if (source?.location !== 'r2' || !source.r2Committed || !source.r2Key) return null;
    if (actor) await accessibleProject(ctx, row.projectId, actor);
    else {
      const project = await ctx.db.get(row.projectId);
      invariant(
        project?.visibility === 'public' && !project.removal,
        'PROJECT_UNAVAILABLE',
        'This project is unavailable.',
      );
    }
    return {
      digest: source.digest,
      size: source.size,
      url: await presignGet(r2Config(), source.r2Key),
      purged: true,
    };
  },
});
export async function archiveSource(ctx: ActionCtx, id: BlobId) {
  const user = await ctx.auth.getUserIdentity();
  // Artifact references belong to blobStore. Archive rows resolve through the
  // current-authorized archive query.
  const r2: { digest: string; size: number; url: string; purged: boolean } | null = id.startsWith('r2blob:')
    ? null
    : await ctx.runQuery(makeFunctionReference<'query'>('r2ArchiveSource:resolve'), {
        storageId: id,
        actor: user?.subject ?? null,
      });
  if (id.startsWith('r2archive:')) invariant(r2, 'INVALID_WORK_BACKUP', 'Stored archive is unavailable.');
  return r2
    ? {
        metadata: { size: r2.size, sha256: r2.digest },
        getUrl: async () => r2.url,
        purged: r2.purged,
        direct: true,
      }
    : {
        metadata: await blobStore(ctx).getMetadata(id),
        getUrl: () => blobStore(ctx).getUrl(id),
        purged: false,
        direct: id.startsWith('r2blob:'),
      };
}

/** Read reference for an R2 archive row. */
export const archiveRef = (row: { _id: string }) => `r2archive:${row._id}`;
