// SPDX-License-Identifier: Apache-2.0
import type { ContentPin } from './native-exchange.js';
import { mapExchange } from './exchange-parallel.js';
import { ForgeError, invariant } from './errors.js';
import { digest } from './hash.js';

/** A signed GET the server returned for one committed R2 object of the project. */
export type SignedObject = { digest: string; size: number; url: string };
export type SignDownloads = (projectId: string, digests: string[]) => Promise<SignedObject[]>;

/** GETs run in parallel; small objects are latency-bound, so at least eight at once. */
export const readConcurrency = 8;
const retryDelay = (attempt: number) => 100 * 2 ** attempt * (0.5 + Math.random());

/** One verified GET of a signed URL. Retries 5xx, 429 and network errors with backoff. Returns
 * `forbidden` on 403 (an expired or revoked signature) so the caller can sign again once. */
export async function getSigned(url: string, pin: ContentPin, attempts = 4): Promise<Buffer | 'forbidden'> {
  for (let attempt = 0; ; attempt++) {
    let status = 0,
      bytes: Buffer | undefined;
    try {
      const response = await fetch(url);
      status = response.status;
      if (response.ok) bytes = Buffer.from(await response.arrayBuffer());
    } catch {
      // Network failure: retry below.
    }
    if (bytes) {
      invariant(
        bytes.length === pin.size && digest(bytes) === pin.sha256,
        'BLOB_DIGEST_MISMATCH',
        'Downloaded content differs from its digest. Nothing was used or written.',
      );
      return bytes;
    }
    if (status === 403) return 'forbidden';
    if (status === 404)
      throw new ForgeError('R2_OBJECT_MISSING', 'An object is missing from object storage.');
    const retryable = status === 0 || status === 429 || status >= 500;
    if (!retryable || attempt + 1 >= attempts)
      throw new ForgeError(
        'R2_READ_FAILED',
        `Object download ${status ? `returned HTTP ${status}` : 'did not complete'}. Retry the command.`,
      );
    await new Promise(resolve => setTimeout(resolve, retryDelay(attempt)));
  }
}

/** Read the pins that are committed R2 objects straight from R2; the rest are absent from the
 * result and the caller reads them the old way. Signing is batched at 100 digests per call,
 * a 403 signs that one object again once, and every byte is sha256-verified before it is used. */
export async function readSigned(
  sign: SignDownloads,
  projectId: string,
  pins: ContentPin[],
): Promise<Map<string, Buffer>> {
  const wanted = new Map(pins.map(pin => [pin.sha256, pin]));
  const signed = new Map<string, SignedObject>();
  const digests = [...wanted.keys()];
  const pages: string[][] = [];
  for (let at = 0; at < digests.length; at += 100) pages.push(digests.slice(at, at + 100));
  for (const result of await mapExchange(pages, 4, page => sign(projectId, page)))
    for (const object of result) {
      const pin = wanted.get(object.digest);
      invariant(
        pin && pin.size === object.size,
        'INVALID_WORK_BACKUP',
        'Object storage listing differs from the selected content.',
      );
      signed.set(object.digest, object);
    }
  const found = [...signed.values()];
  const bytes = await mapExchange(
    found,
    readConcurrency,
    async object => {
      const pin = wanted.get(object.digest)!;
      let result = await getSigned(object.url, pin);
      if (result === 'forbidden') {
        const [again] = await sign(projectId, [object.digest]);
        invariant(
          again && again.size === pin.size,
          'EXCHANGE_DOWNLOAD_DENIED',
          'Object storage no longer lets this account read the selected content.',
        );
        result = await getSigned(again.url, pin);
        invariant(
          result !== 'forbidden',
          'EXCHANGE_DOWNLOAD_DENIED',
          'Object storage refused a freshly signed download. Retry the command.',
        );
      }
      return result;
    },
    { bytes: 16 * 1024 * 1024, size: object => object.size },
  );
  return new Map(found.map((object, index) => [object.digest, bytes[index]!]));
}
