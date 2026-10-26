// SPDX-License-Identifier: Apache-2.0
// SigV4 query-string presigner for R2 (S3 API). Web Crypto only (no Node APIs),
// so it runs in Convex's V8 runtime. Ported from the design spike's presign.mjs.
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const bytes = (s: string) => new TextEncoder().encode(s);
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (s: string) => hex(await crypto.subtle.digest('SHA-256', bytes(s)));
async function hmac(key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? bytes(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', k, bytes(data));
}

export type PresignInput = {
  method: 'GET' | 'PUT' | 'POST' | 'HEAD' | 'DELETE';
  host: string;
  path: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  service?: string;
  /** Seconds the URL stays valid. */
  expires?: number;
  now?: Date;
  /** Extra headers the client must send with exactly these values (signed). */
  headers?: Record<string, string>;
  query?: Record<string, string>;
};

export async function presign({
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
}: PresignInput): Promise<string> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const hdrs: Record<string, string> = {
    host,
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
  };
  const names = Object.keys(hdrs).sort();
  const signedHeaders = names.join(';');
  const q: Record<string, string> = {
    ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonicalQuery = Object.keys(q)
    .sort()
    .map(k => `${enc(k)}=${enc(q[k]!)}`)
    .join('&');
  const canonicalPath = path.split('/').map(enc).join('/');
  const canonicalHeaders = names.map(k => `${k}:${hdrs[k]}\n`).join('');
  const canonical = [
    method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonical)].join('\n');
  let key = await hmac('AWS4' + secretAccessKey, day);
  for (const part of [region, service, 'aws4_request']) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  return `https://${host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
