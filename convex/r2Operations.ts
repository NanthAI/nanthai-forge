// SPDX-License-Identifier: Apache-2.0
import { convexFetch } from './networkFetch';
import { presign } from './presign';
import { r2Endpoint, type R2Config } from './r2';
import { invariant } from '../src/errors';

export const projectPrefix = (id: string) => `v1/p/${id}/`;
const endpoint = (config: R2Config, key = '') => ({
  ...r2Endpoint(config),
  path: `/${config.bucket}/${key}`,
  accessKeyId: config.accessKeyId,
  secretAccessKey: config.secretAccessKey,
  expires: 60,
});
/** Idempotent, signed delete; never reports the URL or provider body. */
export async function deleteR2Object(config: R2Config, key: string, signal?: AbortSignal) {
  let ok = false;
  try {
    const response = await convexFetch(await presign({ method: 'DELETE', ...endpoint(config, key) }), {
      method: 'DELETE',
      signal,
    });
    ok = response.ok || response.status === 404;
    await response.body?.cancel();
  } catch {
    /* Report a source-free structured error below. */
  }
  invariant(ok, 'R2_DELETE_FAILED', 'Object storage deletion failed; retry the same page.');
}
const xml = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
/** Bounded S3 ListObjectsV2; encoding-type=url keeps object keys unambiguous. */
export async function listR2Prefix(
  config: R2Config,
  prefix: string,
  cursor: string | null,
  startAfter?: string,
) {
  let body = '';
  try {
    const url = await presign({
      method: 'GET',
      ...endpoint(config),
      query: {
        'list-type': '2',
        'max-keys': '100',
        'encoding-type': 'url',
        prefix,
        ...(cursor ? { 'continuation-token': cursor } : {}),
        ...(startAfter ? { 'start-after': startAfter } : {}),
      },
    });
    const response = await convexFetch(url);
    if (response.ok) body = await response.text();
    else await response.body?.cancel();
  } catch {
    /* No provider details leave this boundary. */
  }
  invariant(body.includes('<ListBucketResult'), 'R2_LIST_FAILED', 'Object storage listing failed.');
  let keys: string[];
  try {
    keys = [...body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map(match => decodeURIComponent(xml(match[1]!)));
  } catch {
    keys = [''];
  }
  invariant(
    keys.length <= 100 && keys.every(key => key.startsWith(prefix)),
    'R2_LIST_FAILED',
    'Object storage returned an invalid project-prefix page.',
  );
  // Size appears only inside each listed object's Contents; the purge reports bytes freed.
  const sizes = [...body.matchAll(/<Size>(\d+)<\/Size>/g)].map(match => Number(match[1]));
  const bytes = sizes.reduce((sum, size) => sum + size, 0);
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(body);
  const next = body.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
  invariant(!truncated || !!next, 'R2_LIST_FAILED', 'Object storage omitted a continuation cursor.');
  // Last-modified time per key (ms); NaN when the page does not pair one with every key.
  const times = [...body.matchAll(/<LastModified>([\s\S]*?)<\/LastModified>/g)].map(match =>
    Date.parse(match[1]!),
  );
  const modified = keys.map((_, index) => (times.length === keys.length ? times[index]! : NaN));
  return { keys, bytes, sizes, modified, cursor: next ? xml(next) : null, isDone: !truncated };
}
/** Owner save purge (Item 9d3c407d): a signed GET of a whole object, bounded, with its ETag; never
 * reports the URL or provider body. Null when it is gone. */
export async function readR2Object(config: R2Config, key: string, maxBytes: number) {
  let read: { bytes: Uint8Array<ArrayBuffer>; etag: string | null } | null | undefined;
  try {
    const response = await convexFetch(await presign({ method: 'GET', ...endpoint(config, key) }));
    if (response.status === 404) read = (await response.body?.cancel(), null);
    else if (response.ok && Number(response.headers.get('content-length') ?? maxBytes + 1) <= maxBytes) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength <= maxBytes) read = { bytes, etag: response.headers.get('etag') };
    } else await response.body?.cancel();
  } catch {
    /* Report a source-free structured error below. */
  }
  invariant(read !== undefined, 'R2_READ_FAILED', 'Object storage read failed; retry the purge.');
  return read;
}
/** Owner save purge: replaces an upload pack in place with a purged member's range zeroed. The only
 * overwrite in Forge; members are read by range and each is verified by its own digest, so the
 * others still verify. Signs the length and, when known, If-Match on the ETag just read, so a
 * concurrent rewrite fails instead of being undone. */
export async function overwriteR2Object(
  config: R2Config,
  key: string,
  body: Uint8Array<ArrayBuffer>,
  etag?: string | null,
) {
  let ok = false;
  try {
    const headers: Record<string, string> = {
      'content-length': String(body.byteLength),
      ...(etag ? { 'if-match': etag } : {}),
    };
    const response = await convexFetch(await presign({ method: 'PUT', ...endpoint(config, key), headers }), {
      method: 'PUT',
      headers,
      body,
    });
    ok = response.ok;
    await response.body?.cancel();
  } catch {
    /* Report a source-free structured error below. */
  }
  invariant(ok, 'R2_UPLOAD_FAILED', 'Object storage write failed; retry the purge.');
}
/** Upload packs are at most 8 MiB; read a little more so a larger object is refused, not cut. */
const packReadLimit = 16 * 1024 * 1024;
/** The R2 step of an owner save purge, idempotent: delete whole objects, then zero each purged
 * member's range inside its upload pack (one read and at most one write per pack; a pack already
 * zeroed, or gone, is not written). */
export async function purgeR2Bytes(
  config: R2Config,
  work: { deletes: readonly string[]; zero: readonly { key: string; offset: number; size: number }[] },
) {
  for (const key of work.deletes) await deleteR2Object(config, key);
  const packs = new Map<string, { offset: number; size: number }[]>();
  for (const range of work.zero) packs.set(range.key, [...(packs.get(range.key) ?? []), range]);
  let writes = 0;
  for (const [key, ranges] of packs) {
    const read = await readR2Object(config, key, packReadLimit);
    if (!read) continue;
    const { bytes, etag } = read;
    invariant(
      ranges.every(({ offset, size }) => offset >= 0 && size > 0 && offset + size <= bytes.byteLength),
      'R2_READ_FAILED',
      'A stored pack is shorter than its recorded members; retry the purge.',
    );
    if (ranges.every(({ offset, size }) => bytes.subarray(offset, offset + size).every(byte => !byte)))
      continue;
    for (const { offset, size } of ranges) bytes.fill(0, offset, offset + size);
    await overwriteR2Object(config, key, bytes, etag);
    writes++;
  }
  return { deletes: work.deletes.length, writes };
}
