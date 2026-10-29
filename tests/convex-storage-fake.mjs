// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
/** Real Convex `ctx.storage.store` in the Node runtime sends `blob.type` as the
 * upload content-type and rejects an empty one (live dev, 2026-10-28). It also
 * verifies an optional hex `sha256`. Fakes call this before accepting a blob. */
export async function convexStoreBlob(blob, options = {}) {
  if (!(blob instanceof Blob)) throw Error('Error uploading file: expected a Blob');
  if (!blob.type)
    throw Error(
      'Error uploading file: {"code":"BadHeader","message":"Bad header for content-type: invalid HTTP header"}',
    );
  const bytes = Buffer.from(await blob.arrayBuffer());
  if (options.sha256 !== undefined && createHash('sha256').update(bytes).digest('hex') !== options.sha256)
    throw Error('Error uploading file: sha256 mismatch');
  return bytes;
}
