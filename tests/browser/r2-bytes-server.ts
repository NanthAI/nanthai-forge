// SPDX-License-Identifier: Apache-2.0
// Local synthetic browser fixture only. Run after build:core, alongside Vite on localhost:5173.
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
const objects = new Map<string, Buffer>();
const locations = new Map<string, string>();
const calls: { method: string; range?: string }[] = [];
const pin = (bytes: Buffer) => ({
  sha256: createHash('sha256').update(bytes).digest('hex'),
  size: bytes.length,
});
function put(text: string, location = 'r2') {
  const bytes = Buffer.from(text),
    p = pin(bytes);
  objects.set(p.sha256, bytes);
  locations.set(p.sha256, location);
  return p;
}
const before = put('export const value = 1;\n'),
  after = put('export const value = 2;\n', 'convex');
const state = (blob: string) =>
  put(
    JSON.stringify({
      kind: 'forge-source-state',
      schema: 1,
      parents: [],
      files: [{ path: 'a.ts', blob, mode: 'file' }],
      message: 'Synthetic browser test',
      at: '2026-01-01T00:00:00.000Z',
    }),
  );
const base = state(before.sha256),
  head = state(after.sha256),
  work = put('{}');
const manifest = put(
  JSON.stringify({
    schema: 1,
    kind: 'forge-native-work-backup',
    id: randomUUID(),
    head: head.sha256,
    revision: 0,
    coverage: 'Synthetic browser fixture',
    unavailable: [],
    files: [
      { path: 'work.json', ...work },
      ...[before, after, base, head].map(p => ({ path: `objects/${p.sha256}`, ...p })),
    ],
  }),
);
const leaf = put('a complete ranged recipe leaf\n');
const recipe = put(
  JSON.stringify({
    kind: 'forge-object-recipe',
    schema: 1,
    object: leaf,
    tree: { ...leaf, height: 0, length: leaf.size },
  }),
);
const origin = 'http://localhost:5374';
let corrupt = false,
  expired = 0,
  revoked = false,
  signing = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, origin),
    cors = req.headers.origin === 'http://localhost:5173';
  const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, {
      ...(cors
        ? {
            'Access-Control-Allow-Origin': 'http://localhost:5173',
            'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Content-Type, If-None-Match, x-amz-checksum-sha256',
            'Access-Control-Expose-Headers': 'Content-Range, Content-Length',
          }
        : {}),
      ...headers,
    });
    res.end(Buffer.isBuffer(data) ? data : JSON.stringify(data));
  };
  if (req.method === 'OPTIONS') return send(204, '');
  if (url.pathname === '/fixture')
    return send(200, {
      before,
      after,
      base,
      head,
      leaf,
      recipe,
      input: { projectId: 'project', backupId: 'backup', base: base.sha256, head: head.sha256 },
    });
  if (url.pathname === '/control') {
    corrupt = url.searchParams.get('corrupt') === 'true';
    expired = Number(url.searchParams.get('expired') ?? 0);
    revoked = url.searchParams.get('revoked') === 'true';
    return send(200, { calls: calls.length, signing });
  }
  if (url.pathname === '/stats') return send(200, { calls, signing });
  if (url.pathname === '/rpc') {
    let body = '';
    for await (const part of req) body += part;
    const { method, args } = JSON.parse(body);
    calls.push({ method });
    if (revoked) return send(403, { code: 'PROJECT_UNAVAILABLE' });
    if (method === 'source')
      return send(200, {
        backupId: 'backup',
        backupDigest: manifest.sha256,
        manifestDigest: manifest.sha256,
        operationId: 'synthetic',
        transport: 'objects',
        format: 'native',
        root: manifest,
        pins: null,
      });
    if (method === 'describe')
      return send(
        200,
        args.digests.map((digest: string) => {
          const bytes = objects.get(digest)!;
          return {
            digest,
            size: bytes.length,
            location: locations.get(digest),
            ...(locations.get(digest) === 'convex' ? { url: `${origin}/object/${digest}` } : {}),
          };
        }),
      );
    if (method === 'signDownloads') {
      signing++;
      return send(
        200,
        args.digests.map((digest: string) => ({
          digest,
          size: objects.get(digest)!.length,
          url: `${origin}/object/${digest}`,
        })),
      );
    }
    return send(400, {});
  }
  if (url.pathname.startsWith('/object/')) {
    const id = url.pathname.split('/').at(-1)!,
      original = objects.get(id);
    calls.push({ method: req.method!, range: req.headers.range });
    if (!original) return send(404, '');
    if (expired > 0) {
      expired--;
      return send(403, '');
    }
    const bytes = corrupt && id === before.sha256 ? Buffer.from(original).fill(33) : original;
    const ranged = req.headers.range;
    return send(ranged ? 206 : 200, req.method === 'HEAD' ? Buffer.alloc(0) : bytes, {
      'Content-Length': String(bytes.length),
      ...(ranged ? { 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}` } : {}),
    });
  }
  send(404, '');
});
server.listen(5374, 'localhost', () => console.log('Synthetic R2 fixture: http://localhost:5374'));
