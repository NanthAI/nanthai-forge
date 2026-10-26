// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import { blobStore } from './blobStore';
import type { Id } from './_generated/dataModel';
import { removeDerived } from './derivedArtifacts';
import { invariant } from '../src/errors';

import { storageDigest, scanComplete } from './storageDigest';
export { storageDigest, scanComplete } from './storageDigest';
export type UploadBinding = { nonce: string; digest: string; size: number };
export function matchesUpload(
  file: { contentType?: string; sha256: string; size: number },
  binding: UploadBinding,
  kind: 'backup' | 'proposal',
) {
  return (
    file.contentType === `application/x-forge-${kind}-${binding.nonce}` &&
    file.size === binding.size &&
    storageDigest(file.sha256) === binding.digest
  );
}
// Check every existing file owner before removing an object. Upload receipts confer no source access.
export async function removeExclusive(ctx: MutationCtx, storageId: Id<'_storage'>, except?: string) {
  const references = await Promise.all([
    ctx.db
      .query('projectObjects')
      .withIndex('by_storage', q => q.eq('storageId', storageId))
      .take(2),
    ctx.db
      .query('projectBackups')
      .withIndex('by_storage', q => q.eq('storageId', storageId))
      .take(2),
    ctx.db
      .query('projectProposals')
      .withIndex('by_storage', q => q.eq('storageId', storageId))
      .take(2),
    ctx.db
      .query('importArtifacts')
      .withIndex('by_artifactKey', q => q.eq('artifactKey', storageId))
      .take(2),
    ctx.db
      .query('imports')
      .withIndex('by_artifactKey', q => q.eq('artifactKey', storageId))
      .take(2),
  ]);
  if (references.some(rows => rows.some(row => row._id !== except))) return false;
  if (await ctx.db.system.get(storageId)) await blobStore(ctx).delete(storageId);
  await removeDerived(ctx, storageId);
  return true;
}
export async function removeDuplicate(
  ctx: MutationCtx,
  binding: UploadBinding,
  kind: 'backup' | 'proposal',
  storageId: Id<'_storage'>,
) {
  const file = await ctx.db.system.get(storageId);
  // A repeated cleanup of an already absent file is a no-op. Existing foreign files never qualify.
  if (!file) return;
  invariant(
    matchesUpload(file, binding, kind),
    'INVALID_WORK_BACKUP',
    'Uploaded bytes differ from this original operation.',
  );
  await removeExclusive(ctx, storageId);
}
export async function duplicatePage(
  ctx: MutationCtx,
  binding: UploadBinding & { storageId?: Id<'_storage'>; _creationTime: number },
  kind: 'backup' | 'proposal',
  cursor: string | null,
) {
  const page = await ctx.db.system.query('_storage').order('desc').paginate({ cursor, numItems: 100 });
  for (const file of page.page)
    if (file._id !== binding.storageId && matchesUpload(file, binding, kind))
      await removeExclusive(ctx, file._id);
  return { cursor: page.continueCursor, isDone: scanComplete(page, binding._creationTime) };
}
