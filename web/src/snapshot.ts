// SPDX-License-Identifier: Apache-2.0
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ConvexError } from 'convex/values';
export const hostedError = (e: unknown) =>
  e instanceof ConvexError && typeof e.data === 'object' && e.data && 'message' in e.data
    ? String(e.data.message)
    : (e as Error).message;
export function hostedRetryAt(error: unknown): number | undefined {
  const data = error instanceof ConvexError ? error.data : error;
  if (
    data &&
    typeof data === 'object' &&
    'retryAt' in data &&
    typeof data.retryAt === 'number' &&
    Number.isSafeInteger(data.retryAt) &&
    data.retryAt > 0
  )
    return data.retryAt;
  return undefined;
}
export const hostedFailure = (error: unknown) =>
  Object.assign(new Error(hostedError(error)), { retryAt: hostedRetryAt(error) });
export interface SnapshotPart {
  direct?: boolean;
  url?: string;
  data: ArrayBuffer;
  size: number;
  digest: string;
  contentType: string;
  repository: string;
  head: string;
  filename?: string;
}

export async function snapshotDownload(read: (offset: number, digest?: string) => Promise<SnapshotPart>) {
  const chunks: Uint8Array<ArrayBuffer>[] = [],
    hash = sha256.create();
  let first: SnapshotPart | undefined,
    offset = 0;
  do {
    const part = await read(offset, first?.digest);
    first ??= part;
    if (part.direct) {
      if (offset !== 0 || !part.url) throw new Error('Invalid direct snapshot binding.');
      const response = await fetch(part.url, { headers: { 'accept-encoding': 'identity' } });
      if (!response.ok || !response.body) throw new Error('Stored snapshot is unavailable.');
      const reader = response.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          offset += chunk.value.length;
          if (offset > first.size) throw new Error('Snapshot exceeds its exact size.');
          hash.update(chunk.value);
          chunks.push(new Uint8Array(chunk.value));
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      if (offset !== first.size) throw new Error('Snapshot transfer is incomplete.');
      break;
    }
    if (
      part.digest !== first.digest ||
      part.size !== first.size ||
      part.head !== first.head ||
      part.repository !== first.repository ||
      part.contentType !== first.contentType ||
      part.filename !== first.filename ||
      part.data.byteLength === 0 ||
      offset + part.data.byteLength > first.size
    )
      throw new Error('The snapshot changed or the transfer was incomplete. Download again.');
    const bytes = new Uint8Array(part.data);
    hash.update(bytes);
    chunks.push(bytes);
    offset += part.data.byteLength;
  } while (offset < first.size);
  const blob = new Blob(chunks, { type: first.contentType });
  const digest = hash.digest(),
    hex = bytesToHex(digest);
  // Convex deployments return base64; documented system metadata can also use hex.
  if (hex !== first.digest && btoa(String.fromCharCode(...digest)) !== first.digest)
    throw new Error('The downloaded snapshot failed its integrity check. Download again.');
  return {
    blob,
    filename:
      first.filename ??
      `${first.repository.replace(/[^\w.-]+/g, '-')}-${first.head.slice(0, 12)}.forge.json${first.contentType === 'application/gzip' ? '.gz' : ''}`,
  };
}
