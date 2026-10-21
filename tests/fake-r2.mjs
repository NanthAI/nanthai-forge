// SPDX-License-Identifier: Apache-2.0
// A local stand-in for R2's S3 endpoint. It verifies the SigV4 query signature with the Node
// reference presigner, then enforces what R2 enforces on presigned PUTs: signed content-length,
// create-only `If-None-Match: *` (412) and `x-amz-checksum-sha256` (400). GET serves the stored
// bytes (with `Range`, 206). Objects live in memory.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { presign } from './presign-node-reference.mjs';

export const fakeR2Config = {
  accountId: 'acct0123',
  bucket: 'forge-blobs-test',
  accessKeyId: 'AKIDFAKE',
  secretAccessKey: 'fake/secret+key',
};
const b64 = bytes => createHash('sha256').update(bytes).digest('base64');
// Keep local bucket traffic on the real HTTP transport even when a preceding
// provider fixture has wrapped global fetch. Non-bucket requests still use the
// caller's current mock.
const networkFetch = globalThis.fetch;
const mustSign = ['content-length', 'if-none-match', 'x-amz-checksum-sha256'];

export async function startFakeR2(config = fakeR2Config) {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const objects = new Map(); // "bucket/key" -> Buffer
  const fake = {
    host,
    config,
    objects,
    requests: [],
    /** Respond 503 to the next n PUTs. */
    failPuts: 0,
    /** Added to the clock, in ms, to test expiry. */
    clockSkew: 0,
    putDelay: 0,
    /** Keys ("bucket/key") whose GET returns flipped bytes (corruption hook). */
    corrupt: new Set(),
    /** Respond 503 to the next n GETs. */
    failGets: 0,
    /** Respond 403 to the next n GETs (as if the signature had expired). */
    forbidGets: 0,
    getDelay: 0,
    active: 0,
    maxActive: 0,
    key: (k, bucket = config.bucket) => `${bucket}/${k}`,
    /** Send fetches for the fake's host to the local server. Returns a restore function. */
    install() {
      const native = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (url.host !== host) return native(input, init);
        return networkFetch(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`, init);
      };
      return () => {
        globalThis.fetch = native;
      };
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    fake.active++;
    fake.maxActive = Math.max(fake.maxActive, fake.active);
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const send = (status, headers = {}) => {
      fake.active--;
      fake.requests.push({ method: req.method, path: req.url, status });
      res.writeHead(status, headers);
      res.end();
    };
    try {
      const url = new URL(req.url, 'http://local'),
        q = url.searchParams,
        signed = (q.get('X-Amz-SignedHeaders') ?? '').split(';').filter(Boolean);
      const date = q.get('X-Amz-Date') ?? '',
        issued = Date.parse(date.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'));
      if (!(issued + Number(q.get('X-Amz-Expires')) * 1000 > Date.now() + fake.clockSkew)) return send(403);
      const headers = Object.fromEntries(
        signed.filter(name => name !== 'host').map(n => [n, req.headers[n]]),
      );
      if (Object.values(headers).some(value => value === undefined)) return send(403);
      const extra = Object.fromEntries([...q].filter(([name]) => !name.startsWith('X-Amz-')));
      const expected = presign({
        method: req.method,
        host,
        path: decodeURIComponent(url.pathname),
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        expires: Number(q.get('X-Amz-Expires')),
        now: new Date(issued),
        headers,
        query: extra,
      });
      const signature = new URL(expected).searchParams.get('X-Amz-Signature');
      if (
        q.get('X-Amz-Signature') !== signature ||
        !q.get('X-Amz-Credential')?.startsWith(config.accessKeyId + '/')
      )
        return send(403);
      const [, bucket, ...rest] = decodeURIComponent(url.pathname).split('/'),
        id = fake.key(rest.join('/'), bucket);
      if (bucket !== config.bucket) return send(404);
      if (req.method === 'PUT') {
        if (!mustSign.every(name => signed.includes(name))) return send(403);
        if (fake.putDelay) await new Promise(resolve => setTimeout(resolve, fake.putDelay));
        if (fake.failPuts > 0) {
          fake.failPuts--;
          return send(503);
        }
        if (Number(headers['content-length']) !== body.length) return send(400);
        if (headers['x-amz-checksum-sha256'] !== b64(body)) return send(400);
        if (headers['if-none-match'] === '*' && objects.has(id)) return send(412);
        objects.set(id, body);
        return send(200);
      }
      if (req.method === 'HEAD') {
        const object = objects.get(id);
        if (!object) return send(404);
        return send(200, { 'content-length': String(object.length), 'x-amz-checksum-sha256': b64(object) });
      }
      if (req.method === 'DELETE') {
        objects.delete(id);
        return send(204);
      }
      if (req.method === 'GET') {
        if (fake.getDelay) await new Promise(resolve => setTimeout(resolve, fake.getDelay));
        const object = objects.get(id);
        if (fake.forbidGets > 0) {
          fake.forbidGets--;
          return send(403);
        }
        if (fake.failGets > 0) {
          fake.failGets--;
          return send(503);
        }
        if (!object) return send(404);
        const stored = fake.corrupt.has(id) ? Buffer.from(object).map(byte => byte ^ 0xff) : object;
        const range = /^bytes=(\d+)-(\d+)?$/.exec(req.headers.range ?? '');
        fake.active--;
        if (range) {
          const from = Number(range[1]),
            to = Math.min(stored.length - 1, range[2] === undefined ? Infinity : Number(range[2]));
          if (from >= stored.length) {
            fake.requests.push({ method: 'GET', path: req.url, status: 416 });
            res.writeHead(416, { 'content-range': `bytes */${stored.length}` });
            return res.end();
          }
          fake.requests.push({ method: 'GET', path: req.url, status: 206 });
          res.writeHead(206, {
            'content-range': `bytes ${from}-${to}/${stored.length}`,
            'content-length': String(to - from + 1),
          });
          return res.end(stored.subarray(from, to + 1));
        }
        fake.requests.push({ method: 'GET', path: req.url, status: 200 });
        res.writeHead(200, { 'content-length': String(stored.length) });
        return res.end(stored);
      }
      return send(405);
    } catch {
      return send(500);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return fake;
}
