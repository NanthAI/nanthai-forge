// SPDX-License-Identifier: Apache-2.0
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
export async function deleteR2Object(config: R2Config, key: string) {
  let ok = false;
  try {
    const response = await fetch(await presign({ method: 'DELETE', ...endpoint(config, key) }), {
      method: 'DELETE',
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
export async function listR2Prefix(config: R2Config, prefix: string, cursor: string | null) {
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
      },
    });
    const response = await fetch(url);
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
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(body);
  const next = body.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
  invariant(!truncated || !!next, 'R2_LIST_FAILED', 'Object storage omitted a continuation cursor.');
  return { keys, cursor: next ? xml(next) : null, isDone: !truncated };
}
