// SPDX-License-Identifier: Apache-2.0
import type { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import type { ContentPin } from './native-exchange.js';
import { exchangeFetch } from './exchange-request.js';
import { ForgeError, invariant } from './errors.js';
import { ObjectDownloadReader } from './blob-download.js';
import type { DownloadRow } from './blob-download-format.js';
import { readSigned, SignedDownloadCache, type SignedObject } from './exchange-r2-read.js';

/** The one place the CLI moves exchange object bytes. Callers verify sizes and
 * digests; this seam only transports. Today the only implementation is Convex
 * file storage (upload URLs, download actions); a direct object-store
 * transport can replace it without touching exchange logic. */
export type BlobRow = { digest: string; size: number; data: ArrayBuffer };
/** The destination `projectObjects:prepareBatch` returned: a Convex upload URL, or a presigned R2 PUT. */
export type PutTarget =
  { uploadUrl: string; contentType: string } | { kind: 'r2'; url: string; headers: Record<string, string> };
export interface ExchangeBlobs {
  /** Send one object to its prepared destination. Convex uploads return the storage id; R2 uploads return `{}`. */
  put(target: PutTarget, bytes: Buffer): Promise<{ storageId?: string }>;
  /** Read several small objects (callers keep groups within the 2 MiB / 8 object limits). */
  getGroup(projectId: string, pins: ContentPin[]): Promise<BlobRow[]>;
  /** Read the 2 MiB range of one object at `offset`. */
  getPart(projectId: string, pin: ContentPin, offset: number): Promise<BlobRow>;
  /** Read the pins that are committed R2 objects directly from R2, sha256-verified. Pins stored
   * elsewhere (Convex storage, recipes) are absent from the result: use getGroup / getPart for them. */
  getSigned(projectId: string, pins: ContentPin[]): Promise<Map<string, Buffer>>;
}

const action = (name: string) => makeFunctionReference<'action'>(name);

/** Convex file storage upload: POST the bytes to the one-time upload URL. */
export async function putConvexUpload(target: { uploadUrl: string; contentType: string }, bytes: Buffer) {
  const response = await exchangeFetch(
    'Convex object upload',
    target.uploadUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': target.contentType },
      body: new Uint8Array(bytes),
    },
    { retries: 0 },
  );
  invariant(
    response.ok,
    'EXCHANGE_UPLOAD_UNKNOWN',
    'Upload did not return success. Retry this same exchange to reconcile its original objects.',
  );
  return (await response.json()) as { storageId: string };
}

/** Create-only R2 PUTs can safely replay their exact signed destination and bytes. */
export async function putR2(
  target: { url: string; headers: Record<string, string> },
  bytes: Buffer,
  attempts = 4,
): Promise<Record<string, never>> {
  const headers = Object.fromEntries(
    Object.entries(target.headers).filter(([name]) => name.toLowerCase() !== 'content-length'),
  );
  const response = await exchangeFetch(
    'R2 object upload',
    target.url,
    { method: 'PUT', headers, body: new Uint8Array(bytes) },
    { retries: attempts - 1 },
  );
  if (response.ok || response.status === 412) return {};
  throw new ForgeError(
    'EXCHANGE_UPLOAD_UNKNOWN',
    `R2 object upload returned HTTP ${response.status}. Retry this same exchange to reconcile its original objects.`,
  );
}
export function putTarget(target: PutTarget, bytes: Buffer): Promise<{ storageId?: string }> {
  return 'kind' in target ? putR2(target, bytes) : putConvexUpload(target, bytes);
}

export class ConvexExchangeBlobs implements ExchangeBlobs {
  constructor(
    private readonly client: Pick<ConvexHttpClient, 'action' | 'mutation'>,
    private readonly signedDownloads = new SignedDownloadCache(),
    private readonly onBytes?: (pin: ContentPin, done: number) => void,
    private readonly onCall?: (name: string, pending: boolean) => void,
  ) {}
  private directReader(projectId: string) {
    return new ObjectDownloadReader({
      fetch: (url, init) =>
        fetch(url, { ...init, headers: { ...init?.headers, 'accept-encoding': 'identity' } }),
      describe: digests =>
        this.client.mutation(makeFunctionReference<'mutation'>('projectObjectDownloads:describe'), {
          projectId,
          digests,
        }) as Promise<DownloadRow[]>,
      sign: digests =>
        this.client.mutation(makeFunctionReference<'mutation'>('projectObjectDownloads:signDownloads'), {
          projectId,
          digests,
        }) as Promise<SignedObject[]>,
    });
  }
  put = putTarget;
  getSigned(projectId: string, pins: ContentPin[]): Promise<Map<string, Buffer>> {
    return readSigned(
      (id, digests) =>
        this.client.mutation(makeFunctionReference<'mutation'>('projectObjectDownloads:signDownloads'), {
          projectId: id,
          digests,
        }) as Promise<SignedObject[]>,
      projectId,
      pins,
      this.signedDownloads,
      this.onBytes,
      this.onCall,
    );
  }
  async getGroup(projectId: string, pins: ContentPin[]): Promise<BlobRow[]> {
    const rows: (BlobRow | { direct: true; digest: string; size: number })[] = await this.client.action(
      action('projectExchangeActions:downloadBatch'),
      {
        projectId,
        digests: pins.map(pin => pin.sha256),
      },
    );
    const reader = this.directReader(projectId);
    return Promise.all(
      rows.map(async (row, index) =>
        'direct' in row
          ? {
              digest: row.digest,
              size: row.size,
              data: new Uint8Array((await reader.read([pins[index]!]))[0]!).buffer,
            }
          : row,
      ),
    );
  }
  async getPart(projectId: string, pin: ContentPin, offset: number): Promise<BlobRow> {
    const row: BlobRow | { direct: true; digest: string; size: number } = await this.client.action(
      action('projectExchangeActions:downloadPart'),
      {
        projectId,
        digest: pin.sha256,
        offset,
      },
    );
    if (!('direct' in row)) return row;
    const bytes = await this.directReader(projectId).range(
      pin,
      offset,
      Math.min(2 * 1024 * 1024, pin.size - offset),
    );
    return { digest: row.digest, size: row.size, data: new Uint8Array(bytes).buffer };
  }
}
