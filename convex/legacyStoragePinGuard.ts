// SPDX-License-Identifier: Apache-2.0
import type { Infer } from 'convex/values';
import type { QueryCtx } from './server';
import type { Id } from './_generated/dataModel';
import type { cleanupPin } from './legacyStorageCleanupFields';
import { storageDigest } from './storageDigest';

async function indexedReferences(ctx: QueryCtx, storageId: Id<'_storage'>) {
  return (
    await Promise.all([
      ctx.db
        .query('projectObjects')
        .withIndex('by_storage', q => q.eq('storageId', storageId))
        .take(3),
      ctx.db
        .query('projectBackups')
        .withIndex('by_storage', q => q.eq('storageId', storageId))
        .take(3),
      ctx.db
        .query('projectProposals')
        .withIndex('by_storage', q => q.eq('storageId', storageId))
        .take(3),
      ctx.db
        .query('projectBackups')
        .withIndex('by_archive_storage', q => q.eq('archiveReceipt.storageId', storageId))
        .take(3),
      ctx.db
        .query('imports')
        .withIndex('by_artifactKey', q => q.eq('artifactKey', storageId))
        .take(3),
      ctx.db
        .query('importArtifacts')
        .withIndex('by_artifactKey', q => q.eq('artifactKey', storageId))
        .take(3),
    ])
  ).flat();
}
type Pin = Omit<Infer<typeof cleanupPin>, 'verifiedAt' | 'recheckedAt' | 'fullDigest'>;
/** Exact physical metadata and indexed owner pins shared by both retirement paths. */
export async function checkLegacyFile(
  ctx: QueryCtx,
  pin: Pin,
  { verifiedAt, headVerified = true }: { verifiedAt: number; headVerified?: boolean },
) {
  const file = await ctx.db.system.get(pin.storageId);
  // No absent-file success without an original committed page receipt.
  let code: string | null = !file
    ? 'FILE_ABSENT'
    : file.size !== pin.size || storageDigest(file.sha256) !== pin.digest
      ? 'FILE_CHANGED'
      : null;
  // Class 4 has no R2 copy to recheck; its approved manifest pins Convex metadata only.
  if (
    !(verifiedAt >= 0 && verifiedAt <= Date.now() && Date.now() - verifiedAt <= 86400_000) ||
    (pin.class !== 4 &&
      (!pin.keys.length || pin.keys.some(k => !k.startsWith('v1/') || k.split('/').at(-1) !== pin.digest)))
  )
    code = 'FULL_DIGEST_REQUIRED';
  if (pin.class !== 1 && pin.owners.length) code = 'REFERENCE_REMAINS';
  if (!headVerified) code = 'R2_HEAD_REQUIRED';
  const refs = await indexedReferences(ctx, pin.storageId);
  if (refs.length !== pin.owners.length || refs.some(r => !pin.owners.some(o => o.id === r._id)))
    code = 'REFERENCE_CHANGED';
  const owners = [];
  let unset = false;
  for (const owner of pin.owners) {
    const id = ctx.db.normalizeId(owner.table, owner.id),
      row = id ? await ctx.db.get(id) : null;
    if (
      !row ||
      row.storageId !== pin.storageId ||
      row.digest !== pin.digest ||
      row.size !== pin.size ||
      row.location !== 'r2' ||
      !row.r2Committed ||
      row.r2ConvexPurged ||
      !pin.keys.includes(row.r2Key ?? '') ||
      row.r2Key !== `v1/p/${row.projectId}/o/${pin.digest}`
    )
      code = 'OWNER_CHANGED';
    else if (row.r2BackfilledAt === undefined) unset = true;
    else if (row.r2BackfilledAt > verifiedAt) code = 'OWNER_CHANGED';
    if (row) owners.push(row);
  }
  // R2-native rows (inserted already committed) never got a backfill time. Report
  // it apart only when nothing else fails, so the bounded owner-scoped repair
  // (projectLegacyStorageRepair) can record it after a fresh R2 digest check.
  if (unset) code ??= 'OWNER_BACKFILL_UNSET';
  return { code, owners, file };
}
