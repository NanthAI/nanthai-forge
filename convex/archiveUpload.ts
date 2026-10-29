// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import { reserveArtifact } from './artifactStorage';
import { v } from 'convex/values';
import { r2Config, presignPut, headObject, checksumOf } from './r2';
import { invariant } from '../src/errors';
export const archivePut = v.object({
  kind: v.literal('r2'),
  url: v.string(),
  headers: v.record(v.string(), v.string()),
});
export const archiveTarget = (row: { digest: string; size: number; r2Key: string }) =>
  presignPut(r2Config(), row.r2Key, row);
/** HEAD proves the create-only checksum-bound PUT. No body enters Convex. */
export async function verifyArchiveUpload(row: { r2Key?: string; size: number; digest: string }) {
  invariant(row.r2Key, 'INVALID_WORK_BACKUP', 'Original R2 archive reservation is unavailable.');
  const head = await headObject(r2Config(), row.r2Key);
  if (head.status === 'missing') return false;
  invariant(head.status === 'ok', 'R2_VERIFY_FAILED', 'Object storage could not confirm the archive.');
  invariant(head.size === row.size, 'R2_OBJECT_SIZE_MISMATCH', 'Uploaded archive size differs.');
  invariant(
    !head.checksum || head.checksum === checksumOf(row.digest),
    'R2_OBJECT_CHECKSUM_MISMATCH',
    'Uploaded archive checksum differs.',
  );
  return true;
}

export async function reserveArchive(
  ctx: MutationCtx,
  row: { _id: string; projectId: string; size: number; digest: string },
) {
  return reserveArtifact(ctx, {
    namespace: `v1/p/${row.projectId}/archives/${row._id}`,
    size: row.size,
    digest: row.digest,
    contentType: 'application/gzip',
  });
}
export async function commitArchive(
  ctx: MutationCtx,
  row: { _id: string; projectId: string; size: number; digest: string; r2Key?: string },
) {
  const artifact = await reserveArchive(ctx, row);
  invariant(artifact.r2Key === row.r2Key, 'INVALID_WORK_BACKUP', 'Original archive reservation changed.');
  if (!artifact.committed) await ctx.db.patch(artifact._id, { committed: true });
}
