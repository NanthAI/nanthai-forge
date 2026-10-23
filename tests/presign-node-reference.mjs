// SPDX-License-Identifier: Apache-2.0
// Zero-dependency SigV4 query presigner for R2 (S3 API). Same code shape would run
// in a Convex V8 action/mutation (swap node:crypto for crypto.subtle).
import { createHash, createHmac } from 'node:crypto';

const enc = s =>
  encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const sha256hex = b => createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();

/**
 * presign({ method, host, path, accessKeyId, secretAccessKey, region, expires, now, headers, query })
 * headers: extra headers the client MUST send with exactly these values (signed).
 */
export function presign({
  method,
  host,
  path,
  accessKeyId,
  secretAccessKey,
  region = 'auto',
  service = 's3',
  expires = 300,
  now = new Date(),
  headers = {},
  query = {},
}) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const hdrs = {
    host,
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
  };
  const signedHeaders = Object.keys(hdrs).sort().join(';');
  const q = {
    ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonicalQuery = Object.keys(q)
    .sort()
    .map(k => `${enc(k)}=${enc(q[k])}`)
    .join('&');
  const canonicalPath = path.split('/').map(enc).join('/');
  const canonicalHeaders = Object.keys(hdrs)
    .sort()
    .map(k => `${k}:${hdrs[k]}\n`)
    .join('');
  const canonical = [
    method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  let key = hmac('AWS4' + secretAccessKey, day);
  for (const part of [region, service, 'aws4_request']) key = hmac(key, part);
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return `https://${host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
