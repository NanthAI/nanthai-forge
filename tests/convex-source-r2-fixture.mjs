// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { digest } from '../dist/hash.js';
export function fakeSourceR2(t) {
  const keys = {
    CONVEX_CLOUD_URL: 'https://example.convex.cloud',
    R2_ACCOUNT_ID: 'synthetic',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
  };
  for (const [key, value] of Object.entries(keys)) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => (old === undefined ? delete process.env[key] : (process.env[key] = old)));
  }
  const objects = new Map(),
    requests = [],
    // `echo`: a 200 PUT echoes the signed checksum, as R2 does; off, the reply has no echo
    // (the HEAD-confirmed fallback).
    hooks = { mismatch: false, lostPut: false, echo: false };
  const original = globalThis.fetch;
  globalThis.fetch = async (target, init = {}) => {
    const url = new URL(target),
      method = init.method ?? 'GET';
    assert.equal(url.hostname, 'synthetic.r2.cloudflarestorage.com', 'no live network');
    requests.push(method);
    if (method === 'PUT') {
      const bytes = Buffer.from(init.body);
      assert.equal(
        init.headers['x-amz-checksum-sha256'],
        Buffer.from(digest(bytes), 'hex').toString('base64'),
      );
      const prior = objects.has(url.pathname);
      if (!prior) objects.set(url.pathname, bytes);
      if (hooks.lostPut) {
        hooks.lostPut = false;
        throw Error('lost PUT reply');
      }
      return new Response(null, {
        status: prior ? 412 : 200,
        ...(hooks.echo && !prior
          ? { headers: { 'x-amz-checksum-sha256': init.headers['x-amz-checksum-sha256'] } }
          : {}),
      });
    }
    if (method === 'DELETE') {
      objects.delete(url.pathname);
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      const bucket = url.pathname.replace(/\/$/, ''),
        prefix = url.searchParams.get('prefix') ?? '';
      const listed = [...objects.entries()]
        .map(([path, value]) => [path.slice(bucket.length + 1), value])
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1));
      const page = listed.slice(0, 100),
        more = listed.length > page.length;
      return new Response(
        `<ListBucketResult>${page.map(([key, value]) => `<Contents><Key>${encodeURIComponent(key)}</Key><Size>${value.length}</Size></Contents>`).join('')}<IsTruncated>${more}</IsTruncated>${more ? '<NextContinuationToken>next</NextContinuationToken>' : ''}</ListBucketResult>`,
      );
    }
    const bytes = objects.get(url.pathname);
    if (!bytes) return new Response(null, { status: 404 });
    if (method === 'HEAD')
      return new Response(null, {
        headers: {
          'content-length': String(bytes.length),
          'x-amz-checksum-sha256': hooks.mismatch
            ? 'invalid'
            : Buffer.from(digest(bytes), 'hex').toString('base64'),
        },
      });
    const range = new Headers(init.headers).get('range');
    if (range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      assert(match, 'one exact range');
      const start = Number(match[1]),
        end = Number(match[2]);
      assert(start <= end && end < bytes.length, 'range stays inside physical object');
      return new Response(bytes.subarray(start, end + 1), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` },
      });
    }
    return new Response(bytes);
  };
  t.after(() => (globalThis.fetch = original));
  return { objects, requests, hooks };
}
