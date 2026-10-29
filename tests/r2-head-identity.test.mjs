// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { moduleUrl } from './convex-module.mjs';
import { fakeR2Config } from './fake-r2.mjs';
import { setup } from './r2-harness.mjs';
import { digest } from '../dist/hash.js';
import { getSigned } from '../dist/exchange-r2-read.js';
import { spoolBackfill, sampleBackfill } from '../dist/r2-backfill-transfer.js';
import { ConvexExchangeBlobs } from '../dist/exchange-blobs.js';
import { ObjectDownloadReader } from '../dist/blob-download.js';
import { getFunctionName } from 'convex/server';
import { modules } from './project-exchange-fixture.mjs';
const { headObject, presignPut } = await import(moduleUrl('../convex/r2.ts'));
const { blobStore } = await import(moduleUrl('../convex/blobStore.ts'));
const { rawContent } = await import(moduleUrl('../convex/projectObjectContent.ts'));
const { projectArchivePart } = await import(moduleUrl('../convex/projectArchivePart.ts'));
const identity = init => assert.equal(new Headers(init.headers).get('accept-encoding'), 'identity');

test('gzip HEAD without content length is an error even when its checksum matches', async t => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    identity(init);
    assert.equal(init.method, 'HEAD');
    assert.equal(new URL(url).searchParams.get('X-Amz-SignedHeaders'), 'host');
    return new Response(null, {
      headers: { 'content-encoding': 'gzip', 'x-amz-checksum-sha256': 'matching-checksum' },
    });
  });
  assert.deepEqual(await headObject(fakeR2Config, 'synthetic'), {
    status: 'error',
    detail: 'R2 HEAD returned no content length',
  });
});

test('identity HEAD returns the stored length and checksum, including empty content', async t => {
  let size = 164700;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    identity(init);
    return new Response(null, {
      headers: { 'content-length': String(size), 'x-amz-checksum-sha256': 'checksum' },
    });
  });
  for (size of [164700, 0]) {
    assert.deepEqual(await headObject(fakeR2Config, 'synthetic'), {
      status: 'ok',
      size,
      checksum: 'checksum',
    });
  }
});

test('CLI direct download and backfill spool/sample request identity and verify actual bytes', async t => {
  const bytes = Buffer.from('synthetic compressible font/text '.repeat(100)),
    pin = { digest: digest(bytes), size: bytes.length },
    directory = mkdtempSync(join(tmpdir(), 'forge-identity-')),
    file = join(directory, 'spool');
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    identity(init);
    calls++;
    return new Response(bytes);
  });
  assert.deepEqual(
    await getSigned('https://synthetic.invalid/object', { sha256: pin.digest, size: pin.size }),
    bytes,
  );
  await spoolBackfill('https://synthetic.invalid/object', file, pin);
  assert.deepEqual(readFileSync(file), bytes);
  await sampleBackfill('https://synthetic.invalid/object', pin);
  assert.equal(calls, 3);
  const wrong = { ...pin, digest: '0'.repeat(64) };
  await assert.rejects(
    sampleBackfill('https://synthetic.invalid/object', wrong),
    e => e.code === 'BLOB_DIGEST_MISMATCH',
  );
  await assert.rejects(
    getSigned('https://synthetic.invalid/object', { sha256: wrong.digest, size: pin.size }),
    e => e.code === 'BLOB_DIGEST_MISMATCH',
  );
});

test('server objects, artifacts, archive ranges and CLI recipe fallback request identity', async t => {
  const { s } = await setup(t),
    bytes = Buffer.from('synthetic artifact text'),
    pin = { sha256: digest(bytes), size: bytes.length },
    previous = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = (url, init) => {
    if (init?.method === 'HEAD' || !init?.method || init.method === 'GET') {
      identity(init);
      reads++;
    }
    return previous(url, init);
  };
  try {
    const ref = await blobStore(s.ctx).store(new Blob([bytes], { type: 'text/plain' }), {
      r2Namespace: 'v1/p/project/artifacts',
    });
    assert.deepEqual(Buffer.from(await (await blobStore(s.ctx).get(ref)).arrayBuffer()), bytes);
    const artifact = s.tables.artifactBlobs.get(ref.slice(7));
    assert.deepEqual(
      await rawContent(s.ctx, { location: 'r2', r2Committed: true, r2Key: artifact.r2Key }, pin),
      bytes,
    );
    assert.deepEqual(
      Buffer.from(await projectArchivePart(s.ctx, ref, pin.size, pin.sha256, 4, async () => {})),
      bytes.subarray(4),
    );
    const target = await modules.projectObjects.prepareBatch._handler(s.ctx, {
      projectId: 'project',
      objects: [{ digest: pin.sha256, size: pin.size }],
    });
    const transport = new ConvexExchangeBlobs({
      mutation: (fn, args) => {
        const [name, method] = getFunctionName(fn).split(':');
        return modules[name][method]._handler(s.ctx, args);
      },
      action: async () => ({ direct: true, digest: pin.sha256, size: pin.size }),
    });
    await transport.put(target[0].target, bytes);
    await modules.projectObjectCommit.commitBatch._handler(s.ctx, { objects: [{ id: target[0].id }] });
    assert.deepEqual(Buffer.from((await transport.getPart('project', pin, 2)).data), bytes.subarray(2));
    assert.equal(reads, 6);
  } finally {
    globalThis.fetch = previous;
  }
});

test('browser recipe leaves use full GET and verify decoded gzip before slicing', async t => {
  const bytes = Buffer.from('synthetic font bytes '.repeat(400)),
    pin = { sha256: digest(bytes), size: bytes.length },
    compressed = gzipSync(bytes),
    server = createServer((request, response) => {
      response.writeHead(200, {
        'content-type': 'font/ttf',
        'content-encoding': 'gzip',
        'content-length': compressed.length,
      });
      response.end(compressed);
    });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/synthetic`,
    reader = new ObjectDownloadReader({
      describe: async () => [{ digest: pin.sha256, size: pin.size, location: 'r2' }],
      sign: async () => [{ digest: pin.sha256, size: pin.size, url }],
      fetch: (url, init) => {
        assert.equal(new Headers(init.headers).get('range'), null);
        assert.equal(new Headers(init.headers).get('accept-encoding'), null);
        return fetch(url, init);
      },
    });
  assert.deepEqual(
    Buffer.from(await reader.tree(pin, { ...pin, height: 0, length: pin.size }, new Set(), 10, 30)),
    bytes.subarray(10, 40),
  );
});

test('presigned PUT allows unsigned content type while Forge supplies none', async () => {
  const target = await presignPut(fakeR2Config, 'synthetic', { digest: 'a'.repeat(64), size: 1 });
  assert.equal(target.headers['content-type'], undefined);
  assert.equal(new URL(target.url).searchParams.get('X-Amz-SignedHeaders').includes('content-type'), false);
});
