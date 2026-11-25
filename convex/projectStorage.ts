// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './_generated/server';
import { blobStore } from './blobStore';
import type { Id } from './_generated/dataModel';
import { removeDerived } from './derivedArtifacts';
import { storageDigest } from './storageDigest';
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
// Check every existing file owner (an import's artifact key) before removing a file. Upload receipts confer no source access.
export async function removeExclusive(ctx: MutationCtx, storageId: Id<'_storage'>, except?: string) {
  const references = await Promise.all([
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
