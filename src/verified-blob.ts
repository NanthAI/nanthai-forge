// SPDX-License-Identifier: Apache-2.0
/** Browser-safe check that downloaded bytes match their sha256 digest (hex). Browser readers of
 * object storage (code view, diff) call this before using any byte; a mismatch is a typed error. */
export class BlobDigestMismatch extends Error {
  readonly code = 'BLOB_DIGEST_MISMATCH';
  constructor() {
    super('Downloaded content differs from its digest. Nothing was used.');
  }
}
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = bytes.buffer instanceof ArrayBuffer ? bytes : new Uint8Array(bytes);
  const hash = await crypto.subtle.digest('SHA-256', view as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Returns the bytes unchanged when they match `digest`, or throws `BlobDigestMismatch`. */
export async function verifiedBytes(bytes: Uint8Array, digest: string): Promise<Uint8Array> {
  if ((await sha256Hex(bytes)) !== digest.toLowerCase()) throw new BlobDigestMismatch();
  return bytes;
}
