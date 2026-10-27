// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { removeExclusive, storageDigest, scanComplete } from './projectStorage';

// Invoked by the existing owner-authorized deleted-project reconciliation. The
// original nonce binding identifies uploads whose completion response was lost.
export async function reconcileRemovedObjectUploads(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  cursor: string | null,
) {
  const project = await ctx.db.get(projectId),
    page = await ctx.db.system.query('_storage').order('desc').paginate({ cursor, numItems: 100 });
  for (const file of page.page) {
    const prefix = 'application/x-forge-object-';
    if (!file.contentType?.startsWith(prefix)) continue;
    const row = await ctx.db
      .query('projectObjects')
      .withIndex('by_nonce', q => q.eq('nonce', file.contentType!.slice(prefix.length)))
      .unique();
    if (
      row?.projectId === projectId &&
      row.removed &&
      row.size === file.size &&
      row.digest === storageDigest(file.sha256)
    )
      await removeExclusive(ctx, file._id);
  }
  return {
    cursor: `forge-object-after:${page.continueCursor}`,
    isDone: scanComplete(page, project?._creationTime),
  };
}
