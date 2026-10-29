// SPDX-License-Identifier: Apache-2.0
import type { Id } from './_generated/dataModel';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalQuery, type ActionCtx } from './_generated/server';
import { accessibleProject } from './projectAuthority';
import { r2Config, presignGet } from './r2';
import { blobStore, type BlobId } from './blobStore';
import { invariant } from '../src/errors';

/** Retained storage IDs are immutable aliases after a legacy archive's Convex copy is purged. */
export const resolve = internalQuery({
  args: { storageId: v.string(), actor: v.union(v.string(), v.null()) },
  returns: v.union(
    v.null(),
    v.object({ digest: v.string(), size: v.number(), url: v.string(), purged: v.boolean() }),
  ),
  handler: async (ctx, { storageId, actor }) => {
    const direct = storageId.startsWith('r2archive:')
      ? await ctx.db.get(storageId.slice(10) as Id<'projectBackups'> | Id<'projectProposals'>)
      : null;
    if (storageId.startsWith('r2archive:'))
      invariant(direct, 'PROJECT_UNAVAILABLE', 'Original archive is unavailable.');
    const [backup] = direct
      ? []
      : await ctx.db
          .query('projectBackups')
          .withIndex('by_storage', q => q.eq('storageId', storageId as Id<'_storage'>))
          .take(1);
    const [proposal] =
      direct || backup
        ? []
        : await ctx.db
            .query('projectProposals')
            .withIndex('by_storage', q => q.eq('storageId', storageId as Id<'_storage'>))
            .take(1);
    const [original] =
      direct || backup || proposal
        ? []
        : await ctx.db
            .query('projectBackups')
            .withIndex('by_archive_storage', q =>
              q.eq('archiveReceipt.storageId', storageId as Id<'_storage'>),
            )
            .take(1);
    const row = direct ?? backup ?? proposal ?? original,
      source = original
        ? original.archiveReceipt
        : direct && 'archiveReceipt' in direct && direct.transport === 'objects'
          ? direct.archiveReceipt
          : row;
    if (!row || source?.location !== 'r2' || !source.r2Committed || !source.r2Key) return null;
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
      purged: !!source.r2ConvexPurged || !source.storageId,
    };
  },
});
export async function archiveSource(ctx: ActionCtx, id: BlobId) {
  const user = await ctx.auth.getUserIdentity();
  // Artifact references belong to blobStore. Legacy IDs and owning-archive
  // aliases resolve through the current-authorized archive query.
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

/** Read reference for newly resumed R2 archives, which have no legacy storage ID. */
export const archiveRef = (row: { _id: string; storageId?: string }) =>
  row.storageId ?? `r2archive:${row._id}`;
