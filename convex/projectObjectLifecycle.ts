// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { removeExclusive, storageDigest, scanComplete } from './projectStorage';
// Called only by the existing explicit project deletion owner. Source history has
// no automatic expiry. Nonce receipts remain to reconcile attributable late uploads.
export async function purgeExchangeObjects(ctx: MutationCtx, project: Doc<'hostedProjects'>) {
  const rows = await ctx.db
    .query('projectObjects')
    .withIndex('by_project_and_removed', q => q.eq('projectId', project._id).eq('removed', false))
    .take(50);
  if (rows.some(row => row.r2Key) && !project.r2StorageUsed)
    await ctx.db.patch(project._id, { r2StorageUsed: true });
  for (const row of rows) {
    if (row.storageId) await removeExclusive(ctx, row.storageId, row._id);
    await ctx.db.patch(row._id, { removed: true, storageId: undefined, recipe: undefined });
  }
  if (rows.length) return false;
  if (project.exchangeCleanupDone) return true;
  const page = await ctx.db.system
    .query('_storage')
    .order('desc')
    .paginate({ cursor: project.exchangeCleanupCursor ?? null, numItems: 100 });
  for (const file of page.page) {
    const prefix = 'application/x-forge-object-';
    if (!file.contentType?.startsWith(prefix)) continue;
    const row = await ctx.db
      .query('projectObjects')
      .withIndex('by_nonce', q => q.eq('nonce', file.contentType!.slice(prefix.length)))
      .unique();
    if (
      row?.projectId === project._id &&
      row.removed &&
      row.size === file.size &&
      row.digest === storageDigest(file.sha256)
    )
      await removeExclusive(ctx, file._id);
  }
  const done = scanComplete(page, project._creationTime);
  await ctx.db.patch(project._id, {
    exchangeCleanupCursor: done ? undefined : page.continueCursor,
    exchangeCleanupDone: done,
  });
  return done;
}
