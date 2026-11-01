// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { startFakeR2, fakeR2Config } from './fake-r2.mjs';
import { ObjectDownloadReader } from '../dist/blob-download.js';
import { readSigned } from '../dist/exchange-r2-read.js';
import { packHeaders, verifyPackRange } from '../dist/object-pack-range.js';
const { ImportUpload } = await import(moduleUrl('../convex/projectGithubImportUpload.ts'));
const { findObject, objectRow, catalogPages } = await import(moduleUrl('../convex/projectObjectFind.ts'));
const { rawContent, objectRange } = await import(moduleUrl('../convex/projectObjectContent.ts'));
const downloads = await import(moduleUrl('../convex/projectObjectDownloads.ts'));
const { convexSourceTransport } = await import(moduleUrl('../convex/projectConvexSourceTransport.ts'));
const objects = await import(moduleUrl('../convex/projectObjects.ts'));
const catalog = await import(moduleUrl('../convex/projectGithubImportCatalog.ts'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const keys = {
    R2_ACCOUNT_ID: fakeR2Config.accountId,
    R2_BUCKET: fakeR2Config.bucket,
    R2_ACCESS_KEY_ID: fakeR2Config.accessKeyId,
    R2_SECRET_ACCESS_KEY: fakeR2Config.secretAccessKey,
  };
  const saved = Object.fromEntries(Object.keys(keys).map(key => [key, process.env[key]]));
  Object.assign(process.env, keys);
  const bucket = await startFakeR2();
  const restore = bucket.install();
  t.after(async () => {
    restore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await bucket.close();
  });
  const s = state([]);
  const projectId = await s.ctx.db.insert('hostedProjects', {
    owner: 'owner',
    key: randomUUID(),
    name: 'pack fixture',
    revision: 0,
    currentBackup: null,
    visibility: 'private',
  });
  const stored = new Map();
  const receipts = [];
  const upload = new ImportUpload(s.ctx, projectId, 'owner', 8, {
    stored,
    record: async objects => receipts.push(objects),
  });
  const publish = async () => {
    for (const page of catalogPages([...stored.values()]))
      await s.ctx.db.insert('projectObjectCatalog', {
        projectId,
        origin: 'github-import:synthetic',
        ...page,
      });
  };
  return { s, projectId, bucket, stored, receipts, upload, publish };
}

test('one packed window serves byte-exact backend, Node, browser and Lane downloads with current access', async t => {
  const f = await fixture(t);
  const bodies = [Buffer.from('first source'), Buffer.from('second source'), Buffer.alloc(0)];
  const pins = bodies.map(bytes => f.upload.put(bytes));
  await f.upload.drain(true);
  await f.upload.commit();
  assert.equal(f.upload.putAttempts, 2, 'one pack plus the empty object, never a PUT per nonempty object');
  await f.publish();
  const read = async digests =>
    downloads.describe._handler(f.s.ctx, { projectId: f.projectId, digests, signed: true });
  const sign = async digests =>
    downloads.signDownloads._handler(f.s.ctx, { projectId: f.projectId, digests });
  const browser = new ObjectDownloadReader({ describe: read, sign });
  f.bucket.forbidGets = 1;
  const direct = await readSigned((_project, digests) => sign(digests), f.projectId, pins);
  f.bucket.forbidGets = 1;
  assert.deepEqual(
    await browser.read(pins),
    bodies.map(bytes => new Uint8Array(bytes)),
  );
  const [grant] = await sign([pins[0].sha256]);
  assert.equal((await fetch(grant.url)).status, 403, 'a pack grant requires its signed exact Range');
  assert.equal(
    (await fetch(grant.url, { headers: { Range: `bytes=0-${grant.range.total - 1}` } })).status,
    403,
    'one logical-file grant cannot read adjacent pack bytes',
  );
  const lane = await downloads.lanePage._handler(f.s.ctx, {
    projectId: f.projectId,
    digests: pins.map(pin => pin.sha256),
    signed: true,
  });
  assert.equal(lane.filter(row => row.range).length, 2);
  const grants = await sign(pins.map(pin => pin.sha256));
  const transport = convexSourceTransport(
    f.s.ctx,
    { projectId: f.projectId, jobId: randomUUID(), step: 0 },
    grants.map((grant, index) => ({
      descriptor: { object: pins[index], recipe: null },
      storageId: null,
      url: grant.url,
      ...(grant.range ? { range: grant.range } : {}),
    })),
  );
  for (const [index, pin] of pins.entries()) {
    const parts = [];
    for await (const part of await transport.io.read(pin)) parts.push(Buffer.from(part));
    assert.deepEqual(
      Buffer.concat(parts),
      bodies[index],
      'shared V8/Node source transport reads its exact pack range',
    );
  }
  for (let i = 0; i < pins.length; i++) {
    const row = await findObject(f.s.ctx, f.projectId, pins[i].sha256);
    assert.deepEqual(await rawContent(f.s.ctx, row, pins[i]), bodies[i]);
    assert.deepEqual(direct.get(pins[i].sha256), bodies[i]);
  }
  const view = await findObject(f.s.ctx, f.projectId, pins[1].sha256);
  const row = await objectRow(f.s.ctx, view);
  assert.deepEqual(row.pack, view.pack, 'rare per-object copy preserves the pack binding');
  f.s.caller('intruder');
  await assert.rejects(sign([pins[0].sha256]));
  await assert.rejects(read([pins[0].sha256]));
  await assert.rejects(browser.read([pins[0]]), 'cached bytes still require current membership');
});

test('PUT retries and an unrecorded pack replay preserve one immutable object and count actual attempts', async t => {
  const f = await fixture(t);
  f.bucket.failPuts = 1;
  const bytes = [Buffer.from('one'), Buffer.from('two')];
  for (const body of bytes) f.upload.put(body);
  await f.upload.drain(true);
  assert.equal(f.upload.putAttempts, 2);
  assert.equal(f.bucket.objects.size, 1);
  const replay = new ImportUpload(f.s.ctx, f.projectId, 'owner', 8, {
    stored: new Map(),
    record: async () => {},
  });
  for (const body of bytes) replay.put(body);
  await replay.drain(true);
  assert.equal(replay.putAttempts, 1);
  assert.equal(f.bucket.objects.size, 1);
  assert.ok(f.bucket.requests.some(row => row.method === 'PUT' && row.status === 412));
  assert.ok(f.bucket.requests.some(row => row.method === 'HEAD'));
  const [key, original] = [...f.bucket.objects][0];
  f.bucket.objects.set(key, Buffer.alloc(original.length, 0));
  const invalid = new ImportUpload(f.s.ctx, f.projectId, 'owner', 8, {
    stored: new Map(),
    record: async () => {},
  });
  for (const body of bytes) invalid.put(body);
  await assert.rejects(invalid.drain(true), error => error.code === 'R2_VERIFY_FAILED');
});

test('pack windows round-trip through durable receipts and reject changed range responses', async t => {
  const f = await fixture(t);
  const bodies = [Buffer.from('alpha'), Buffer.from('beta')];
  const pins = bodies.map(body => f.upload.put(body));
  await f.upload.drain(true);
  await f.upload.commit();
  const objects = f.receipts.flat();
  const value = JSON.stringify({
    digests: objects.map(row => row.digest).join(''),
    sizes: objects.map(row => row.size),
    recipes: [],
    packs: objects.flatMap((row, index) => (row.pack ? [{ index, ...row.pack }] : [])),
  });
  assert.deepEqual(catalog.windowEntries(value), objects);
  await f.publish();
  const [signed] = await downloads.signDownloads._handler(f.s.ctx, {
    projectId: f.projectId,
    digests: [pins[0].sha256],
  });
  assert.throws(() => verifyPackRange(new Response(bodies[0]), signed.range, pins[0].size));
  assert.throws(() =>
    verifyPackRange(
      new Response(bodies[0], { status: 206, headers: { 'content-range': 'bytes 1-5/9' } }),
      signed.range,
      pins[0].size,
    ),
  );
  assert.throws(() => packHeaders({ offset: Number.MAX_SAFE_INTEGER, total: 10 }, 1));
  assert.equal(hash(bodies[0]), pins[0].sha256);
  const key = f.bucket.key((await findObject(f.s.ctx, f.projectId, pins[0].sha256)).r2Key);
  f.bucket.corrupt.add(key);
  await assert.rejects(
    rawContent(f.s.ctx, await findObject(f.s.ctx, f.projectId, pins[0].sha256), pins[0]),
    error => error.code === 'BLOB_DIGEST_MISMATCH',
  );
});

test('large streaming windows keep source buffers bounded and PUTs proportional to windows', async t => {
  const f = await fixture(t);
  const mib = 1024 * 1024;
  for (let index = 0; index < 24; index++) {
    f.upload.put(Buffer.alloc(mib, index));
    if (await f.upload.drain()) await f.upload.commit();
  }
  await f.upload.drain(true);
  await f.upload.commit();
  assert.equal(f.stored.size, 27, '24 logical chunks and three protected physical packs');
  assert.equal(f.upload.putAttempts, 3, '24 MiB streams through three physical windows');
  assert.equal(f.receipts.length, 3, 'no Convex operation per object');
  assert.equal(f.upload.peakBufferedBytes, 16 * mib, 'one source window plus its pack copy');
  await f.publish();
  const physical = [...f.stored.values()].find(row => !row.pack && row.size === 8 * mib);
  const view = await findObject(f.s.ctx, f.projectId, physical.digest);
  assert.equal(view.sourceReferenced, true, 'physical packs cannot become disposable cleanup objects');
  const reused = await objects.prepare._handler(f.s.ctx, {
    projectId: f.projectId,
    digest: physical.digest,
    size: physical.size,
  });
  assert.equal(reused.stored, true, 'a later identical upload reuses the physical source binding');
  assert.equal((await findObject(f.s.ctx, f.projectId, physical.digest)).sourceReferenced, true);
  const range = Buffer.from(await objectRange(f.s.ctx, view, 'owner', mib - 1, 2));
  assert.deepEqual(range, Buffer.from([0, 1]), 'raw physical packs also obey exact object-range offsets');
  t.diagnostic(
    JSON.stringify({
      objects: 24,
      bytes: 24 * mib,
      puts: f.upload.putAttempts,
      receiptCalls: f.receipts.length,
      peakOwnedBufferBytes: f.upload.peakBufferedBytes,
      rss: process.memoryUsage().rss,
    }),
  );
});
