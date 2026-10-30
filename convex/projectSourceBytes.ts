// SPDX-License-Identifier: Apache-2.0
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { r2Enabled, r2Config, r2Key, presignPut, headObject, checksumOf } from './r2';
import { invariant } from '../src/errors';

/** One byte-write seam for trusted source producers in either Convex runtime.
 * The caller supplies hash-pinned bytes. R2 enforces the signed checksum, then
 * HEAD confirms the exact binding before the owning transaction publishes it. */
export async function storeSourceBytes(
  ctx: Pick<ActionCtx, 'storage'>,
  projectId: Id<'hostedProjects'> | null,
  bytes: Uint8Array,
  pin: { sha256: string; size: number },
  reuse = false,
  contentType = 'application/octet-stream',
): Promise<{ storageId: Id<'_storage'> } | { r2Key: string }> {
  invariant(bytes.length === pin.size, 'SOURCE_HASH_MISMATCH', 'Source output size changed.');
  if (!r2Enabled())
    return { storageId: await ctx.storage.store(new Blob([new Uint8Array(bytes)], { type: contentType })) };
  invariant(projectId, 'SOURCE_JOB_INVALID', 'R2 source needs its exact project binding.');
  const config = r2Config(),
    key = r2Key(projectId, pin.sha256);
  const matches = (head: Awaited<ReturnType<typeof headObject>>) =>
    head.status === 'ok' && head.size === pin.size && head.checksum === checksumOf(pin.sha256);
  if (reuse) {
    const existing = await headObject(config, key);
    if (matches(existing)) return { r2Key: key };
    invariant(existing.status === 'missing', 'R2_VERIFY_FAILED', 'Existing source binding differs.');
  }
  const target = await presignPut(config, key, { digest: pin.sha256, size: pin.size });
  const response = await fetch(target.url, {
    method: 'PUT',
    headers: target.headers,
    body: new Uint8Array(bytes),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  invariant(response.ok || response.status === 412, 'R2_UPLOAD_FAILED', 'Source upload failed.');
  invariant(
    matches(await headObject(config, key)),
    'R2_VERIFY_FAILED',
    'Exact source size and checksum were not confirmed.',
  );
  return { r2Key: key };
}
