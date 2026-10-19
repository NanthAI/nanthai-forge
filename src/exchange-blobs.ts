// SPDX-License-Identifier: Apache-2.0
import type { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import type { ContentPin } from './native-exchange.js';
import { ForgeError, invariant } from './errors.js';
import { readSigned, type SignedObject } from './exchange-r2-read.js';

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
  const response = await fetch(target.uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': target.contentType },
    body: new Uint8Array(bytes),
  });
  invariant(
    response.ok,
    'EXCHANGE_UPLOAD_UNKNOWN',
    'Upload did not return success. Retry this same exchange to reconcile its original objects.',
  );
  return (await response.json()) as { storageId: string };
}

const retryDelay = (attempt: number) => 100 * 2 ** attempt * (0.5 + Math.random());
/** Presigned R2 PUT. The signed headers go out exactly as given (content-length comes from the
 * body). Retries 5xx, 429 and network errors with backoff. 412 means the create-only PUT found the
 * object already there, which is success; the server's HEAD check then confirms it. */
export async function putR2(
  target: { url: string; headers: Record<string, string> },
  bytes: Buffer,
  attempts = 4,
): Promise<Record<string, never>> {
  const headers = Object.fromEntries(
    Object.entries(target.headers).filter(([name]) => name.toLowerCase() !== 'content-length'),
  );
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    try {
      status = (await fetch(target.url, { method: 'PUT', headers, body: new Uint8Array(bytes) })).status;
    } catch {
      // Network failure: retry below.
    }
    if ((status >= 200 && status < 300) || status === 412) return {};
    const retryable = status === 0 || status === 429 || status >= 500;
    if (!retryable || attempt + 1 >= attempts)
      throw new ForgeError(
        'EXCHANGE_UPLOAD_UNKNOWN',
        `Object upload ${status ? `returned HTTP ${status}` : 'did not complete'}. Retry this same exchange to reconcile its original objects.`,
      );
    await new Promise(resolve => setTimeout(resolve, retryDelay(attempt)));
  }
}
export function putTarget(target: PutTarget, bytes: Buffer): Promise<{ storageId?: string }> {
  return 'kind' in target ? putR2(target, bytes) : putConvexUpload(target, bytes);
}

export class ConvexExchangeBlobs implements ExchangeBlobs {
  constructor(private readonly client: Pick<ConvexHttpClient, 'action' | 'mutation'>) {}
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
    );
  }
  getGroup(projectId: string, pins: ContentPin[]): Promise<BlobRow[]> {
    return this.client.action(action('projectExchangeActions:downloadBatch'), {
      projectId,
      digests: pins.map(pin => pin.sha256),
    });
  }
  getPart(projectId: string, pin: ContentPin, offset: number): Promise<BlobRow> {
    return this.client.action(action('projectExchangeActions:downloadPart'), {
      projectId,
      digest: pin.sha256,
      offset,
    });
  }
}
