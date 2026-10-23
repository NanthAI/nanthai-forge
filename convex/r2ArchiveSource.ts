// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalQuery, type ActionCtx } from './_generated/server';
import { accessibleProject } from './projectAuthority';
import { r2Config, presignGet } from './r2';
import { blobStore, type BlobId } from './blobStore';
import { invariant } from '../src/errors';

/** Retained storage IDs are immutable aliases after a legacy archive's Convex copy is purged. */
export const resolve = internalQuery({
  args: { storageId: v.id('_storage'), actor: v.union(v.string(), v.null()) },
  returns: v.union(
    v.null(),
    v.object({ digest: v.string(), size: v.number(), url: v.string(), purged: v.boolean() }),
  ),
  handler: async (ctx, { storageId, actor }) => {
    const [backup] = await ctx.db
      .query('projectBackups')
      .withIndex('by_storage', q => q.eq('storageId', storageId))
      .take(1);
    const [proposal] = backup
      ? []
      : await ctx.db
          .query('projectProposals')
          .withIndex('by_storage', q => q.eq('storageId', storageId))
          .take(1);
    const [original] =
      backup || proposal
        ? []
        : await ctx.db
            .query('projectBackups')
            .withIndex('by_archive_storage', q => q.eq('archiveReceipt.storageId', storageId))
            .take(1);
    const row = backup ?? proposal ?? original,
      source = original ? original.archiveReceipt : row;
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
      purged: !!source.r2ConvexPurged,
    };
  },
});
export async function archiveSource(ctx: ActionCtx, id: BlobId) {
  const user = await ctx.auth.getUserIdentity();
  // Artifact references belong to blobStore; only legacy storage IDs can be
  // aliases resolved through the query's v.id('_storage') boundary.
  const r2: { digest: string; size: number; url: string; purged: boolean } | null = id.startsWith('r2blob:')
    ? null
    : await ctx.runQuery(makeFunctionReference<'query'>('r2ArchiveSource:resolve'), {
        storageId: id,
        actor: user?.subject ?? null,
      });
  return r2
    ? { metadata: { size: r2.size, sha256: r2.digest }, getUrl: async () => r2.url, purged: r2.purged }
    : {
        metadata: await blobStore(ctx).getMetadata(id),
        getUrl: () => blobStore(ctx).getUrl(id),
        purged: false,
      };
}
