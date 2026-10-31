// SPDX-License-Identifier: Apache-2.0
// R2 object access for Convex functions (V8 runtime): config from the Convex
// environment, presigned PUT targets, and signed HEAD checks. Secrets never leave Convex.
import { exchangeFetch } from '../src/exchange-request';
import { ForgeError } from '../src/errors';
import { presign } from './presign';

export type R2Endpoint = { scheme: 'https' | 'http'; host: string };
export type R2Config = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Operator override (R2_ENDPOINT) for an S3-compatible store, e.g. a self-hosted bucket. */
  endpoint?: R2Endpoint;
};
export type R2PutTarget = { kind: 'r2'; url: string; headers: Record<string, string> };
/** Upload URLs live 15 minutes. */
export const putExpiry = 900;
const headExpiry = 60;
/** Download URLs live 5 minutes; revocation reaches new URLs at once and issued ones within this window. */
export const getExpiry = 300;

/** Bytes go to R2 on every deployment, self-host included, for every project; there is no
 * opt-in, flag or Convex byte mode. Fails closed: a missing setting is a typed error. */
export function r2Config(): R2Config {
  const env = process.env,
    accountId = env.R2_ACCOUNT_ID,
    bucket = env.R2_BUCKET,
    accessKeyId = env.R2_ACCESS_KEY_ID,
    secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey)
    throw new ForgeError(
      'R2_NOT_CONFIGURED',
      'Object storage needs R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY on the backend; Forge never falls back to Convex file storage.',
    );
  const endpoint = endpointOf(env.R2_ENDPOINT);
  return { accountId, bucket, accessKeyId, secretAccessKey, ...(endpoint ? { endpoint } : {}) };
}
/** An https origin, or http on loopback only; never a path, query or credentials. */
function endpointOf(value: string | undefined): R2Endpoint | undefined {
  if (!value) return undefined;
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {}
  const loopback = !!url && /^(?:127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname);
  if (
    !url ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new ForgeError(
      'R2_NOT_CONFIGURED',
      'R2_ENDPOINT must be an https origin, or an http origin on loopback.',
    );
  return { scheme: url.protocol === 'http:' ? 'http' : 'https', host: url.host };
}
/** R2's account host by default. Path-style: virtual-host style fails the TLS handshake. */
export const r2Endpoint = (config: R2Config): R2Endpoint =>
  config.endpoint ?? { scheme: 'https', host: `${config.accountId}.r2.cloudflarestorage.com` };
export const r2Key = (projectId: string, digest: string) => `v1/p/${projectId}/o/${digest}`;
const target = (config: R2Config, key: string) => ({
  ...r2Endpoint(config),
  path: `/${config.bucket}/${key}`,
});
const base64 = (hex: string) =>
  btoa(String.fromCharCode(...hex.match(/../g)!.map(pair => parseInt(pair, 16))));

/** Create-only PUT: signs length, `If-None-Match: *` and the sha256 R2 enforces.
 * No content-type is signed or supplied; clients can still add one. */
export async function presignPut(
  config: R2Config,
  key: string,
  object: { digest: string; size: number },
): Promise<R2PutTarget> {
  const headers = {
    'content-length': String(object.size),
    'if-none-match': '*',
    'x-amz-checksum-sha256': base64(object.digest),
  };
  const url = await presign({
    method: 'PUT',
    ...target(config, key),
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    expires: putExpiry,
    headers,
  });
  return { kind: 'r2', url, headers };
}

/** Presigned GET for one object. Ranged reads send an HTTP `Range` header on the same URL. */
export const presignGet = (config: R2Config, key: string) =>
  presign({
    method: 'GET',
    ...target(config, key),
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    expires: getExpiry,
  });

export type HeadResult =
  | { status: 'ok'; size: number; checksum: string | null }
  | { status: 'missing' }
  | { status: 'error'; detail: string };
export async function headObject(config: R2Config, key: string): Promise<HeadResult> {
  try {
    const url = await presign({
      method: 'HEAD',
      ...target(config, key),
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expires: headExpiry,
    });
    const response = await exchangeFetch(
      'R2 object HEAD verification',
      url,
      { method: 'HEAD', headers: { 'accept-encoding': 'identity' } },
      { retries: 1 },
    );
    if (response.status === 404) return { status: 'missing' };
    if (!response.ok) return { status: 'error', detail: `HTTP ${response.status}` };
    const length = response.headers.get('content-length');
    if (length === null) return { status: 'error', detail: 'R2 HEAD returned no content length' };
    return {
      status: 'ok',
      size: Number(length),
      checksum: response.headers.get('x-amz-checksum-sha256'),
    };
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    return { status: 'error', detail: 'R2 object HEAD verification network failure' };
  }
}
export const checksumOf = base64;

/** Used only by explicit resource cleanup, after its durable artifact tombstone. */
export const presignDelete = (config: R2Config, key: string) =>
  presign({
    method: 'DELETE',
    ...target(config, key),
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    expires: headExpiry,
  });
