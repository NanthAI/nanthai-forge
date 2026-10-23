// SPDX-License-Identifier: Apache-2.0
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
  data: ArrayBuffer;
  size: number;
  digest: string;
  contentType: string;
  repository: string;
  head: string;
  filename?: string;
}

export async function snapshotDownload(read: (offset: number, digest?: string) => Promise<SnapshotPart>) {
  const chunks: ArrayBuffer[] = [];
  let first: SnapshotPart | undefined,
    offset = 0;
  do {
    const part = await read(offset, first?.digest);
    first ??= part;
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
    chunks.push(part.data);
    offset += part.data.byteLength;
  } while (offset < first.size);
  const blob = new Blob(chunks, { type: first.contentType });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  const hex = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
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
