// SPDX-License-Identifier: Apache-2.0
import { copyRecipeClosure } from './object-pack-range.js';
import type { SignedDownload } from './blob-download-format.js';
import type { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import type { ContentPin } from './native-exchange.js';
import { mapExchange } from './exchange-parallel.js';
import { ForgeError, invariant } from './errors.js';
import { exchangeFetch } from './exchange-request.js';
import { digest } from './hash.js';
import { packHeaders, verifyPackRange, type PackRange } from './object-pack-range.js';

/** A signed GET the server returned for one committed R2 object of the project. */
export type SignedObject = { digest: string; size: number } & (
  | { url: string; range?: PackRange; closure?: never }
  | { closure: SignedDownload[]; url?: never; range?: never }
);
export type SignDownloads = (projectId: string, digests: string[]) => Promise<SignedObject[]>;

// Only older servers need one compatibility retry; current servers sign both encodings in one call.
const closureSupport = new WeakMap<object, boolean>();
export async function signDownloadObjects(
  client: Pick<ConvexHttpClient, 'mutation'>,
  projectId: string,
  digests: string[],
): Promise<SignedObject[]> {
  const recipes = closureSupport.get(client) !== false;
  const request = (closures: boolean) =>
    client.mutation(makeFunctionReference<'mutation'>('projectObjectDownloads:signDownloads'), {
      projectId,
      digests,
      ...(closures ? { recipes: true } : {}),
    }) as Promise<SignedObject[]>;
  try {
    return await request(recipes);
  } catch (error) {
    if (!recipes || !/extra field [`'"]?recipes/.test(String((error as Error)?.message))) throw error;
    closureSupport.set(client, false);
    return request(false);
  }
}

/** Disposable process memory, scoped to one exchange client. Never persisted or logged. */
export class SignedDownloadCache {
  private readonly entries = new Map<string, { object: SignedObject; reuseUntil: number }>();
  private key(projectId: string, digest: string) {
    return JSON.stringify([projectId, digest]);
  }
  get(projectId: string, pin: ContentPin) {
    const key = this.key(projectId, pin.sha256),
      entry = this.entries.get(key);
    if (entry && entry.object.size === pin.size && Date.now() < entry.reuseUntil) return entry.object;
    this.entries.delete(key);
    return undefined;
  }
  put(projectId: string, object: SignedObject) {
    this.delete(projectId, object.digest);
    // Derive the lifetime from the actual signature, including time spent getting it.
    // Unknown/malformed lifetimes can be used for this fetch but are never cached.
    try {
      const lifetimes = (object.closure ? object.closure.map(leaf => leaf.url) : [object.url]).map(url => {
        const query = new URL(url).searchParams,
          date = query.get('X-Amz-Date') ?? '',
          issued = Date.parse(
            date.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'),
          ),
          ttl = Number(query.get('X-Amz-Expires'));
        return ttl > 0 ? issued + ttl * 1000 - 60_000 : NaN;
      });
      const reuseUntil = Math.min(...lifetimes);
      if (Number.isFinite(reuseUntil) && reuseUntil > Date.now())
        this.entries.set(this.key(projectId, object.digest), { object, reuseUntil });
    } catch {
      // A URL without a parseable expiry is not reusable.
    }
  }
  delete(projectId: string, digest: string) {
    this.entries.delete(this.key(projectId, digest));
  }
}

/** GETs run in parallel; small objects are latency-bound, so at least eight at once. */
export const readConcurrency = 8;
/** A 403 refreshes the signed URL once; all other retries retain the original URL. */
export async function getSigned(
  url: string,
  pin: ContentPin,
  attempts = 4,
  onBytes?: (done: number, total?: number) => void,
  onCall?: (name: string, pending: boolean) => void,
  range?: PackRange,
  destination?: Uint8Array,
): Promise<Buffer | 'forbidden'> {
  onCall?.('R2 object download', true);
  try {
    const response = await exchangeFetch(
      'R2 object download',
      url,
      { headers: { 'accept-encoding': 'identity', ...packHeaders(range, pin.size) } },
      { retries: attempts - 1, onBytes },
    );
    if (response.status === 403) return 'forbidden';
    if (response.status === 404)
      throw new ForgeError('R2_OBJECT_MISSING', 'An object is missing from object storage.');
    if (!response.ok)
      throw new ForgeError(
        'R2_READ_FAILED',
        `R2 object download returned HTTP ${response.status}. Retry the command.`,
      );
    let bytes: Buffer;
    if (destination && response.body) {
      let at = 0;
      for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
        invariant(
          at + part.length <= destination.length,
          'BLOB_DIGEST_MISMATCH',
          'Recipe leaf exceeds its exact size.',
        );
        destination.set(part, at);
        at += part.length;
      }
      invariant(at === destination.length, 'BLOB_DIGEST_MISMATCH', 'Recipe leaf is truncated.');
      bytes = Buffer.from(destination.buffer, destination.byteOffset, destination.byteLength);
    } else bytes = Buffer.from(await response.arrayBuffer());
    verifyPackRange(response, range, pin.size);
    invariant(
      bytes.length === pin.size && digest(bytes) === pin.sha256,
      'BLOB_DIGEST_MISMATCH',
      'Downloaded content differs from its digest. Nothing was used or written.',
    );
    return bytes;
  } finally {
    onCall?.('R2 object download', false);
  }
}

/** Read the pins that are committed R2 objects straight from R2; the rest are absent from the
 * result and the caller reads them the old way. Uncached signing is batched at 100 digests per call,
 * a 403 signs that one object again once, and every byte is sha256-verified before it is used. */
export async function readSigned(
  sign: SignDownloads,
  projectId: string,
  pins: ContentPin[],
  cache = new SignedDownloadCache(),
  onBytes?: (pin: ContentPin, done: number) => void,
  onCall?: (name: string, pending: boolean) => void,
): Promise<Map<string, Buffer>> {
  const wanted = new Map(pins.map(pin => [pin.sha256, pin]));
  const signed = new Map<string, SignedObject>();
  const digests = [...wanted.values()].flatMap(pin => {
    const cached = cache.get(projectId, pin);
    if (cached) signed.set(pin.sha256, cached);
    return cached ? [] : [pin.sha256];
  });
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
      cache.put(projectId, object);
    }
  const found = [...signed.values()];
  const bytes = await mapExchange(
    found,
    readConcurrency,
    async object => {
      const pin = wanted.get(object.digest)!;
      if (object.closure) {
        let refreshed: Promise<SignedObject> | undefined;
        const result = await copyRecipeClosure(pin, object.closure, async (leaf, destination) => {
          const physical = { sha256: leaf.digest, size: leaf.size };
          let value = await getSigned(leaf.url, physical, 4, undefined, onCall, leaf.range, destination);
          if (value === 'forbidden') {
            refreshed ??= sign(projectId, [object.digest]).then(rows => {
              const next = rows.find(row => row.digest === object.digest && row.size === object.size);
              invariant(
                next?.closure,
                'EXCHANGE_DOWNLOAD_DENIED',
                'The selected recipe is no longer readable.',
              );
              return next;
            });
            const next = (await refreshed).closure!.find(
              row => row.digest === leaf.digest && row.size === leaf.size,
            );
            invariant(next, 'EXCHANGE_DOWNLOAD_DENIED', 'Recipe leaf is no longer readable.');
            value = await getSigned(next.url, physical, 4, undefined, onCall, next.range, destination);
            invariant(
              value !== 'forbidden',
              'EXCHANGE_DOWNLOAD_DENIED',
              'Fresh recipe signature was refused.',
            );
          }
          return value;
        });
        invariant(
          digest(result) === pin.sha256,
          'BLOB_DIGEST_MISMATCH',
          'Recipe differs from the selected whole-object digest.',
        );
        onBytes?.(pin, pin.size);
        return Buffer.from(result.buffer, result.byteOffset, result.byteLength);
      }
      let result = await getSigned(object.url, pin, 4, done => onBytes?.(pin, done), onCall, object.range);
      if (result === 'forbidden') {
        cache.delete(projectId, object.digest);
        const [again] = await sign(projectId, [object.digest]);
        invariant(
          again && !again.closure && again.digest === pin.sha256 && again.size === pin.size,
          'EXCHANGE_DOWNLOAD_DENIED',
          'Object storage no longer lets this account read the selected content.',
        );
        result = await getSigned(again.url, pin, 4, done => onBytes?.(pin, done), onCall, again.range);
        invariant(
          result !== 'forbidden',
          'EXCHANGE_DOWNLOAD_DENIED',
          'Object storage refused a freshly signed download. Retry the command.',
        );
        cache.put(projectId, again);
      }
      return result;
    },
    { bytes: 16 * 1024 * 1024, size: object => object.size },
  );
  return new Map(found.map((object, index) => [object.digest, bytes[index]!]));
}
