// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workArchiveMetadata } from '../dist/work-archive-metadata.js';
import { digest } from '../dist/hash.js';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
const actions = await import(moduleUrl('../convex/projectWorkActions.ts'));
const backups = await import(moduleUrl('../convex/projectBackups.ts'));
const { projectArchiveMetadata } = await import(moduleUrl('../convex/projectArchiveMetadata.ts'));
function header(name, size, type = 48) {
  const h = Buffer.alloc(512);
  h.write(name);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h[156] = type;
  h.fill(32, 148, 156);
  h.write(
    h
      .reduce((a, b) => a + b, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148,
  );
  return h;
}
const entry = (name, bytes) =>
  Buffer.concat([header(name, bytes.length), bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
function archive(manifest = Buffer.from('{}'), work = Buffer.from('{}')) {
  return gzipSync(
    Buffer.concat([
      entry('manifest.json', manifest),
      entry('work.json', work),
      entry('objects/tail', randomBytes(2 * 1024 * 1024)),
      Buffer.alloc(1024),
    ]),
  );
}
function fragment(bytes, sizes) {
  let offset = 0,
    index = 0,
    canceled = false;
  return {
    stream: new ReadableStream(
      {
        pull(c) {
          const end = Math.min(offset + sizes[index++ % sizes.length], bytes.length);
          if (offset === end) {
            c.close();
            return;
          }
          c.enqueue(new Uint8Array(bytes.subarray(offset, end)));
          offset = end;
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    stats: () => ({ offset, canceled }),
  };
}
test('metadata is exact across nonlinear and single huge chunks; early cancellation leaves source/evidence unread', async () => {
  const manifest = Buffer.from('{"source":"exact"}'),
    work = randomBytes(100007),
    bytes = archive(manifest, work);
  for (const sizes of [[1, 7, 503, 8191, 65537], [bytes.length]]) {
    const input = fragment(bytes, sizes),
      output = await workArchiveMetadata(input.stream);
    assert.deepEqual(Buffer.from(output.manifest), manifest);
    assert.deepEqual(Buffer.from(output.work), work);
    assert.equal(input.stats().canceled, true);
    if (sizes.length > 1) assert.ok(input.stats().offset < bytes.length / 2);
  }
  class SlicedBlob extends Blob {
    stream() {
      throw Error('Whole Blob stream must not be read');
    }
  }
  const output = await workArchiveMetadata(new SlicedBlob([bytes]));
  assert.deepEqual(Buffer.from(output.work), work);
});
test('existing metadata bound, exact entry order/path/type/checksum and truncated gzip checks remain enforced', async () => {
  const badChecksum = header('manifest.json', 0);
  badChecksum[0] ^= 1;
  for (const bytes of [
    badChecksum,
    header('../manifest.json', 0),
    header('manifest.json', 0, 50),
    header('manifest.json', 4 * 1024 * 1024 + 1),
    Buffer.concat([entry('manifest.json', Buffer.from('{}')), entry('manifest.json', Buffer.from('{}'))]),
    Buffer.concat([entry('manifest.json', Buffer.from('{}')), header('work.json', 80), Buffer.from('{}')]),
    Buffer.concat([entry('manifest.json', Buffer.from('{}')), header('work.json', 4 * 1024 * 1024 + 1)]),
  ]) {
    await assert.rejects(workArchiveMetadata(new Blob([gzipSync(bytes)])));
  }
  const bytes = archive();
  await assert.rejects(workArchiveMetadata(new Blob([bytes.subarray(0, 10)])));
});
test('demand-driven decoding propagates source errors and cancels invalid metadata before reading source artifacts', async () => {
  const broken = new ReadableStream(
    {
      pull() {
        throw Error('source disconnected');
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(workArchiveMetadata(broken), /source disconnected/);
  const bytes = archive();
  bytes[0] = 0;
  const input = fragment(bytes, [3, 65536]);
  await assert.rejects(workArchiveMetadata(input.stream));
  assert.equal(input.stats().canceled, true);
  assert.ok(input.stats().offset < bytes.length / 2);
});
test('provider metadata checks original size/digest before URL access, cancels invalid responses and propagates transport failure', async t => {
  const bytes = archive(),
    sha = digest(bytes);
  let metadata = { size: bytes.length, sha256: sha },
    urls = 0,
    fetched = 0,
    canceled = 0;
  const storageState = state([]),
    ctx = storageState.ctx;
  ctx.storage.getMetadata = async () => metadata;
  ctx.storage.getUrl = async () => {
    urls++;
    return 'https://storage.invalid/private';
  };
  const prior = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = prior;
  });
  globalThis.fetch = async () => {
    fetched++;
    throw Error('offline');
  };
  for (const change of [{ size: bytes.length + 1 }, { sha256: 'a'.repeat(64) }]) {
    const saved = metadata;
    metadata = { ...metadata, ...change };
    await assert.rejects(projectArchiveMetadata(ctx, 'id', bytes.length, sha, async () => undefined));
    metadata = saved;
  }
  assert.equal(urls, 0);
  assert.equal(fetched, 0);
  await assert.rejects(
    projectArchiveMetadata(ctx, 'id', bytes.length, sha, async () => undefined),
    error => error.code === 'EXCHANGE_REQUEST_FAILED',
  );
  for (const response of [
    { status: 503, headers: {} },
    { status: 200, headers: { 'content-length': String(bytes.length - 1) } },
  ]) {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            canceled++;
          },
        }),
        response,
      );
    await assert.rejects(projectArchiveMetadata(ctx, 'id', bytes.length, sha, async () => undefined));
  }
  assert.equal(canceled, 3);
  globalThis.fetch = async () =>
    new Response(fragment(bytes, [1, 65536, 3]).stream, {
      headers: { 'content-length': String(bytes.length) },
    });
  metadata.sha256 = Buffer.from(sha, 'hex').toString('base64');
  const good = await projectArchiveMetadata(ctx, 'id', bytes.length, sha, async () => undefined);
  assert.equal(Buffer.from(good.work).toString(), '{}');
  globalThis.fetch = async () => new Response(fragment(bytes.subarray(0, 10), [2]).stream);
  await assert.rejects(projectArchiveMetadata(ctx, 'id', bytes.length, sha, async () => undefined));
});
async function nativeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-streamed-metadata-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(dir, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'a.ts'), 'export const a=1;\n');
  initNative(root);
  const w = new WorkService(root),
    exported = (await w.dispatch({ action: 'export-work', archive: true }, w.status().revision)).result,
    bytes = readFileSync(exported.archive.path);
  const md = await workArchiveMetadata(new Blob([bytes])),
    manifest = JSON.parse(Buffer.from(md.manifest)),
    data = JSON.parse(Buffer.from(md.work));
  const s = state([]);
  s.tables.projectContributors = new Map();
  s.tables.hostedProjects = new Map([
    [
      'project',
      {
        _id: 'project',
        owner: 'owner',
        key: randomUUID(),
        name: 'Streamed fixture',
        revision: 1,
        currentBackup: 'backup',
      },
    ],
  ]);
  s.tables.projectBackups = new Map([
    [
      'backup',
      {
        _id: 'backup',
        projectId: 'project',
        digest: digest(bytes),
        size: bytes.length,
        status: 'stored',
        storageId: 'storage',
        preview: { manifestDigest: digest(md.manifest) },
      },
    ],
  ]);
  const previous = s.ctx.runQuery;
  s.ctx.runQuery = (ref, args) =>
    getFunctionName(ref) === 'projectBackups:get' ? backups.get._handler(s.ctx, args) : previous(ref, args);
  s.files.set('storage', { blob: new Blob([bytes]) });
  s.ctx.storage.get = () => {
    throw Error('Hosted metadata must not buffer the complete archive');
  };
  return { s, bytes, manifest, data };
}
test('registered source validates exact pins and final access after streamed read; failures preserve project/source pointers', async t => {
  const f = await nativeFixture(t),
    project = f.s.tables.hostedProjects.get('project'),
    before = structuredClone(project);
  const snapshot = await actions.source(f.s.ctx, 'backup', 'owner');
  assert.deepEqual(snapshot.manifest, f.manifest);
  assert.deepEqual(snapshot.data, f.data);
  const prior = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = prior;
  });
  globalThis.fetch = async () => {
    throw Error('provider failure');
  };
  await assert.rejects(
    actions.source(f.s.ctx, 'backup', 'owner'),
    error => error.code === 'EXCHANGE_REQUEST_FAILED',
  );
  assert.deepEqual(project, before);
  globalThis.fetch = prior;
  const getUrl = f.s.ctx.storage.getUrl;
  f.s.ctx.storage.getUrl = async id => {
    const url = await getUrl(id);
    project.owner = 'other';
    return url;
  };
  await assert.rejects(
    actions.source(f.s.ctx, 'backup', 'owner'),
    e => e.data?.code === 'PROJECT_UNAVAILABLE',
  );
  assert.equal(project.currentBackup, 'backup');
  project.owner = 'owner';
  f.s.ctx.storage.getUrl = getUrl;
  globalThis.fetch = async (input, init) => {
    const response = await prior(input, init);
    project.owner = 'other';
    return response;
  };
  await assert.rejects(
    actions.source(f.s.ctx, 'backup', 'owner'),
    e => e.data?.code === 'PROJECT_UNAVAILABLE',
  );
  assert.equal(project.currentBackup, 'backup');
  globalThis.fetch = prior;
  project.owner = 'owner';
  const expanded = gunzipSync(f.bytes),
    manifestSize = parseInt(expanded.toString('utf8', 124, 136).replace(/\0.*$/, ''), 8),
    workStart = 512 + Math.ceil(manifestSize / 512) * 512 + 512;
  expanded[workStart] = expanded[workStart] === 32 ? 9 : 32;
  globalThis.fetch = async () => new Response(new Blob([gzipSync(expanded)]));
  await assert.rejects(actions.source(f.s.ctx, 'backup', 'owner'), e => e.code === 'INVALID_WORK_BACKUP');
  assert.equal(project.currentBackup, 'backup');
  globalThis.fetch = prior;
  const backup = f.s.tables.projectBackups.get('backup');
  backup.preview.manifestDigest = 'a'.repeat(64);
  f.s.ctx.storage.getUrl = getUrl;
  await assert.rejects(actions.source(f.s.ctx, 'backup', 'owner'), e => e.code === 'INVALID_WORK_BACKUP');
  assert.equal(project.currentBackup, 'backup');
});

test('legacy archive metadata bounds silent headers and partial compressed bodies then recovers exact metadata', async t => {
  const { createServer } = await import('node:http');
  const bytes = archive(),
    sha = digest(bytes),
    ctx = state([]).ctx;
  const realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) =>
    realTimeout(fn, ms === 30_000 ? 150 : ms === 120_000 ? 2000 : ms, ...args),
  );
  for (const halfBody of [false, true]) {
    let requests = 0;
    const sockets = new Set();
    const server = createServer((_req, res) => {
      requests++;
      if (requests <= 2) {
        if (halfBody) {
          res.writeHead(200, { 'Content-Length': bytes.length });
          res.write(bytes.subarray(0, 10));
        }
        return;
      }
      res.end(bytes);
    });
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    });
    ctx.storage.getMetadata = async () => ({ size: bytes.length, sha256: sha });
    ctx.storage.getUrl = async () => `http://127.0.0.1:${server.address().port}`;
    const read = () => projectArchiveMetadata(ctx, 'id', bytes.length, sha, async () => {}, false);
    await assert.rejects(read(), error => error.code === 'EXCHANGE_REQUEST_TIMEOUT');
    assert.equal(requests, 2);
    const output = await read();
    assert.equal(Buffer.from(output.work).toString(), '{}');
    assert.equal(requests, 3);
  }
});

test('optional legacy ancestry also yields on silent headers/body and rechecks access after timeout', async t => {
  const { sourceParents } = await import(moduleUrl('../convex/projectWorkAncestry.ts'));
  const { createServer } = await import('node:http');
  const f = await nativeFixture(t),
    backup = f.s.tables.projectBackups.get('backup');
  // Ancestry is only requested when there is retained View/check history.
  const data = { ...f.data, views: [{ id: 'synthetic-view' }] };
  const realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) =>
    realTimeout(fn, ms === 30_000 ? 150 : ms === 120_000 ? 2000 : ms, ...args),
  );
  for (const halfBody of [false, true]) {
    let requests = 0,
      revoked = false;
    const sockets = new Set();
    const server = createServer((_req, res) => {
      requests++;
      if (requests <= 2 || revoked) {
        if (revoked) f.s.tables.hostedProjects.get('project').owner = 'other';
        if (halfBody) {
          res.writeHead(200);
          res.write(f.bytes.subarray(0, 10));
        }
        return;
      }
      res.end(f.bytes);
    });
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    });
    f.s.ctx.storage.getUrl = async () => `http://127.0.0.1:${server.address().port}`;
    const read = () => sourceParents(f.s.ctx, backup, f.manifest, data, 'owner');
    assert.equal((await read()).size, 0);
    assert.equal(requests, 2);
    assert.ok((await read()).has(f.manifest.head));
    assert.equal(requests, 3);
    revoked = true;
    await assert.rejects(read(), error => error.data?.code === 'PROJECT_UNAVAILABLE');
    f.s.tables.hostedProjects.get('project').owner = 'owner';
  }
});
