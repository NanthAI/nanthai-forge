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
    hooks = { mismatch: false, lostPut: false };
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
      return new Response(null, { status: prior ? 412 : 200 });
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
    return new Response(bytes);
  };
  t.after(() => (globalThis.fetch = original));
  return { objects, requests, hooks };
}
