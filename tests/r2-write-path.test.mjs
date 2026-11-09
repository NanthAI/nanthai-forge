// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { modules } from './project-exchange-fixture.mjs';
import { fakeR2Config } from './fake-r2.mjs';
import { digest } from '../dist/hash.js';
import { putR2 } from '../dist/exchange-blobs.js';
import { buildUploadPack, uploadPackMembers } from '../dist/object-pack-upload.js';

import { setup, client, pinOf, pendingConvexRow } from './r2-harness.mjs';
const objects = modules.projectObjects,
  commit = modules.projectObjectCommit;
const content = values =>
  values.map(value => ({ pin: { sha256: digest(value), size: value.length }, bytes: Buffer.from(value) }));
const prepare = (s, values) =>
  objects.prepareBatch._handler(s.ctx, { projectId: 'project', objects: values.map(pinOf) });
const rows = s => [...s.tables.projectObjects.values()];

test('a new project with no opt-in writes R2', async t => {
  const { s } = await setup(t, { optIn: false }),
    [row] = await prepare(s, ['plain']);
  assert.equal(s.tables.hostedProjects.get('project').r2Writes, undefined);
  assert.equal(row.uploadUrl, undefined);
  assert.equal(row.target.kind, 'r2');
  assert.equal(rows(s)[0].location, 'r2');
});

test('deployment R2 mode returns a presigned create-only PUT and pending R2 row', async t => {
  const { s } = await setup(t),
    pin = pinOf('hello r2'),
    [row] = await prepare(s, ['hello r2']);
  assert.equal(row.uploadUrl, undefined);
  assert.equal(row.stored, false);
  const url = new URL(row.target.url);
  assert.equal(row.target.kind, 'r2');
  assert.equal(url.host, `${fakeR2Config.accountId}.r2.cloudflarestorage.com`);
  assert.equal(url.pathname, `/${fakeR2Config.bucket}/v1/p/project/o/${pin.digest}`);
  assert.equal(url.searchParams.get('X-Amz-Expires'), '900');
  assert.equal(
    url.searchParams.get('X-Amz-SignedHeaders'),
    'content-length;host;if-none-match;x-amz-checksum-sha256',
  );
  assert.equal(row.target.headers['if-none-match'], '*');
  assert.equal(row.target.headers['content-length'], String(pin.size));
  assert.equal(row.target.headers['x-amz-checksum-sha256'].length, 44);
  assert.ok(!JSON.stringify(row).includes(fakeR2Config.secretAccessKey));
  const stored = rows(s)[0];
  assert.equal(stored.location, 'r2');
  assert.equal(stored.r2Key, `v1/p/project/o/${pin.digest}`);
  assert.equal(stored.r2Committed, undefined);
  assert.deepEqual(await objects.missing._handler(s.ctx, { projectId: 'project', objects: [pin] }), [
    pin.digest,
  ]);
});

test('missing R2 configuration on a cloud deployment fails closed with a typed error and inserts nothing', async t => {
  const { s } = await setup(t, { credentials: false });
  await assert.rejects(prepare(s, ['x']), e => e.data?.code === 'R2_NOT_CONFIGURED');
  assert.equal(rows(s).length, 0);
});

test('single-object prepare writes R2 like batches', async t => {
  for (const options of [{}, { optIn: false }])
    await t.test(JSON.stringify(options), async t => {
      const { s } = await setup(t, options);
      const pin = pinOf('single object'),
        prepared = await objects.prepare._handler(s.ctx, { projectId: 'project', ...pin }),
        [batch] = await prepare(s, ['single object']);
      assert.equal(prepared.id, batch.id);
      assert.equal(prepared.stored, false);
      assert.deepEqual(prepared.target.headers, batch.target.headers);
      assert.equal(prepared.target.kind, 'r2');
      assert.equal(rows(s)[0].location, 'r2');
      assert.equal(prepared.uploadUrl, undefined);
    });
});

test('single-object prepare with missing R2 configuration inserts nothing', async t => {
  const { s } = await setup(t, { credentials: false });
  await assert.rejects(
    objects.prepare._handler(s.ctx, { projectId: 'project', ...pinOf('single object') }),
    e => e.data?.code === 'R2_NOT_CONFIGURED',
  );
  assert.equal(rows(s).length, 0);
});

test('single-object prepare refuses foreign, anonymous, reader and revoked callers before signing', async t => {
  const { s, fake } = await setup(t),
    args = { projectId: 'project', ...pinOf('guarded single object') };
  s.tables.projectReaders.set('reader-grant', { projectId: 'project', reader: 'reader' });
  for (const actor of ['stranger', null, 'reader']) {
    s.caller(actor);
    await assert.rejects(objects.prepare._handler(s.ctx, args), e => e.data?.code === 'PROJECT_UNAVAILABLE');
    assert.equal(rows(s).length, 0);
  }
  s.tables.projectContributors.set('grant', { projectId: 'project', contributor: 'contributor' });
  s.caller('contributor');
  const prepared = await objects.prepare._handler(s.ctx, args);
  assert.equal(prepared.target.kind, 'r2');
  s.tables.projectContributors.clear();
  await assert.rejects(objects.prepare._handler(s.ctx, args), e => e.data?.code === 'PROJECT_UNAVAILABLE');
  assert.equal(rows(s).length, 1);
  assert.equal(rows(s)[0].r2Committed, undefined);
  assert.equal(fake.requests.length, 0);
});

test('CLI uploads go straight to R2, commit after a HEAD check, and dedupe afterwards', async t => {
  const { s, fake } = await setup(t),
    exchange = client(s),
    batch = content(['one', 'two', 'three']);
  assert.deepEqual(await exchange.uploadBatch(batch), { uploadedObjects: 3, uploadedBytes: 11 });
  assert.equal(fake.objects.size, 3);
  for (const { pin, bytes } of batch)
    assert.deepEqual(fake.objects.get(fake.key(`v1/p/project/o/${pin.sha256}`)), bytes);
  assert.ok(rows(s).every(row => row.location === 'r2' && row.r2Committed === true && !row.storageId));
  assert.equal(fake.requests.filter(r => r.method === 'HEAD').length, 3);
  const puts = fake.requests.filter(r => r.method === 'PUT').length;
  assert.deepEqual(await exchange.uploadBatch(batch), { uploadedObjects: 0, uploadedBytes: 0 });
  assert.equal(fake.requests.filter(r => r.method === 'PUT').length, puts);
  assert.deepEqual(
    await objects.missing._handler(s.ctx, {
      projectId: 'project',
      objects: batch.map(b => ({ digest: b.pin.sha256, size: b.pin.size })),
    }),
    [],
  );
});

test('a pending Convex reservation switches new upload targets to deployment R2 mode', async t => {
  const { s, fake } = await setup(t);
  pendingConvexRow(s, 'old-a');
  const [again] = await prepare(s, ['old-a']);
  assert.equal(again.target.kind, 'r2');
  assert.equal(again.uploadUrl, undefined);
  assert.equal(fake.objects.size, 0);
});

test('PUT retries 5xx, treats 412 as already stored, and fails typed on other errors', async t => {
  const { s, fake } = await setup(t),
    exchange = client(s);
  fake.failPuts = 2;
  assert.equal((await exchange.uploadBatch(content(['retry me']))).uploadedObjects, 1);
  assert.equal(fake.requests.filter(r => r.method === 'PUT' && r.status === 503).length, 2);
  // The object exists but the row was never committed: PUT returns 412, HEAD confirms.
  const pin = pinOf('already there'),
    id = fake.key(`v1/p/project/o/${pin.digest}`);
  fake.objects.set(id, Buffer.from('already there'));
  assert.equal((await exchange.uploadBatch(content(['already there']))).uploadedObjects, 1);
  assert.equal(fake.requests.at(-2).status, 412);
  assert.equal(rows(s).find(r => r.digest === pin.digest).r2Committed, true);
  // A rejected checksum (wrong bytes for the signed digest) is a typed 400, not retried.
  const [target] = await prepare(s, ['signed for this']);
  const before = fake.requests.length;
  await assert.rejects(
    putR2(target.target, Buffer.from('other bytes!!!')),
    e => e.code === 'EXCHANGE_UPLOAD_UNKNOWN',
  );
  assert.equal(fake.requests.length - before, 1);
  // An expired signature is a 403 and also not retried.
  fake.clockSkew = 3600_000;
  await assert.rejects(putR2(target.target, Buffer.from('signed for this')), /HTTP 403/);
});

test('exhausted retries fail with a typed error and leave the row pending', async t => {
  const { s, fake } = await setup(t),
    exchange = client(s);
  fake.failPuts = 99;
  await assert.rejects(
    exchange.uploadBatch(content(['never lands'])),
    e => e.code === 'EXCHANGE_UPLOAD_UNKNOWN',
  );
  assert.equal(rows(s)[0].r2Committed, undefined);
  fake.failPuts = 0;
  assert.equal((await exchange.uploadBatch(content(['never lands']))).uploadedObjects, 1);
  assert.equal(rows(s)[0].r2Committed, true);
});

test('PUTs run with bounded concurrency of at least eight', async t => {
  const { s, fake } = await setup(t),
    exchange = client(s);
  fake.putDelay = 40;
  await exchange.uploadBatch(content(Array.from({ length: 24 }, (_, i) => `object ${i}`)));
  assert.ok(fake.maxActive >= 8, `saw ${fake.maxActive} concurrent PUTs`);
  assert.ok(fake.maxActive <= 20, `saw ${fake.maxActive} concurrent PUTs`);
});

test('commitBatch leaves rows pending on a missing or wrong object, and is idempotent', async t => {
  const { s, fake } = await setup(t),
    values = ['present', 'absent', 'wrong size', 'wrong sum'],
    prepared = await prepare(s, values),
    ids = prepared.map(row => ({ id: row.id })),
    key = text => fake.key(`v1/p/project/o/${pinOf(text).digest}`);
  fake.objects.set(key('present'), Buffer.from('present'));
  fake.objects.set(key('wrong size'), Buffer.from('wrong size!'));
  fake.objects.set(key('wrong sum'), Buffer.from('wrong SUM'));
  const committed = text => rows(s).find(r => r.digest === pinOf(text).digest).r2Committed === true;
  for (const [text, code] of [
    ['absent', 'R2_OBJECT_MISSING'],
    ['wrong size', 'R2_OBJECT_SIZE_MISMATCH'],
    ['wrong sum', 'R2_OBJECT_CHECKSUM_MISMATCH'],
  ])
    await assert.rejects(
      commit.commitBatch._handler(s.ctx, { objects: [ids[values.indexOf(text)]] }),
      e => e.data?.code === code,
    );
  assert.equal(committed('present'), false);
  // Verified members commit even when another member fails; the failure is still reported.
  await assert.rejects(commit.commitBatch._handler(s.ctx, { objects: ids }), e =>
    e.data?.code?.startsWith('R2_OBJECT_'),
  );
  assert.deepEqual(values.map(committed), [true, false, false, false]);
  fake.objects.set(key('absent'), Buffer.from('absent'));
  await commit.commitBatch._handler(s.ctx, { objects: [ids[1]] });
  await commit.commitBatch._handler(s.ctx, { objects: [ids[1]] });
  assert.equal(committed('absent'), true);
});

test('commitBatch needs current project access and an r2 row', async t => {
  const { s, fake } = await setup(t),
    [row] = await prepare(s, ['guarded']);
  fake.objects.set(fake.key(`v1/p/project/o/${pinOf('guarded').digest}`), Buffer.from('guarded'));
  s.caller('stranger');
  await assert.rejects(commit.commitBatch._handler(s.ctx, { objects: [{ id: row.id }] }));
  assert.equal(rows(s)[0].r2Committed, undefined);
  s.caller('owner');
  const convexRow = pendingConvexRow(s, 'legacy');
  await assert.rejects(
    commit.commitBatch._handler(s.ctx, { objects: [{ id: convexRow }] }),
    e => e.data?.code === 'BAD_ARGUMENT',
  );
});

test('the per-project R2 opt-in no longer exists', () => {
  assert.equal(commit.setR2Writes, undefined);
  assert.equal(commit.setR2WritesAdmin, undefined);
});

test('deployment R2 mode keeps new and pending objects in R2 without the legacy opt-in', async t => {
  const { s } = await setup(t),
    [first] = await prepare(s, ['flip']);
  assert.ok(first.target);
  s.tables.hostedProjects.get('project').r2Writes = false;
  const [second] = await prepare(s, ['flip']);
  assert.equal(second.uploadUrl, undefined);
  assert.equal(second.target.kind, 'r2');
  assert.equal(rows(s)[0].location, 'r2');
  const [fresh] = await prepare(s, ['fresh without opt-in']);
  assert.equal(fresh.target.kind, 'r2');
});

test('the fake rejects bad signatures, other keys and existing objects like R2 does', async t => {
  const { s, fake } = await setup(t),
    [row] = await prepare(s, ['sig check']),
    body = Buffer.from('sig check'),
    headers = Object.fromEntries(Object.entries(row.target.headers).filter(([n]) => n !== 'content-length'));
  const put = (url, extra = {}) =>
    fetch(url, { method: 'PUT', headers: { ...headers, ...extra }, body: new Uint8Array(body) });
  const other = new URL(row.target.url);
  other.pathname = other.pathname.replace(/.$/, c => (c === '0' ? '1' : '0'));
  assert.equal((await put(other.href)).status, 403);
  assert.equal((await put(row.target.url, { 'if-none-match': 'x' })).status, 403);
  assert.equal((await put(row.target.url)).status, 200);
  assert.equal((await put(row.target.url)).status, 412);
  assert.equal(fake.objects.size, 1);
});

// Upload packs (feature upload-packs, Issue 98ee14e8).
const lazy = values => content(values).map(({ pin, bytes }) => ({ pin, read: () => bytes }));
const methods = (fake, method) => fake.requests.filter(r => r.method === method).length;
const charged = s =>
  [...(s.tables.projectStorageUsage?.values() ?? [])].reduce((sum, row) => sum + row.bytes, 0);

test('an upload pack goes up in one PUT; its commit reads it once and binds every member to its range', async t => {
  const { s, fake } = await setup(t),
    exchange = client(s),
    values = ['packed one', 'packed two', 'packed three', ''];
  const sent = await exchange.uploadLazyBatch(lazy(values), { batchSize: 100, pack: true });
  assert.deepEqual(sent, { uploadedObjects: 4, uploadedBytes: 32 });
  // The three non-empty objects share one PUT; the empty one keeps its own.
  assert.equal(methods(fake, 'PUT'), 2);
  assert.equal(methods(fake, 'GET'), 1, 'the commit read the pack once');
  assert.equal(methods(fake, 'HEAD'), 1, 'only the raw object needed a HEAD');
  const pack = rows(s).find(row => row.digest === digest('packed onepacked twopacked three'));
  assert.equal(pack.r2Committed, true);
  assert.equal(pack.packMembers, undefined);
  let offset = 0;
  for (const value of values.slice(0, 3)) {
    const row = rows(s).find(row => row.digest === digest(value));
    assert.deepEqual(row.pack, { digest: pack.digest, size: 32, offset });
    assert.equal(row.r2Key, pack.r2Key);
    assert.equal(row.r2Committed, true);
    offset += value.length;
  }
  assert.deepEqual(
    await objects.missing._handler(s.ctx, { projectId: 'project', objects: values.map(pinOf) }),
    [],
  );
  // Members read back exactly through their signed ranges.
  const bytes = await exchange.downloadBatch(
    values.map(value => ({ sha256: digest(value), size: value.length })),
  );
  assert.deepEqual(
    bytes.map(value => value.toString()),
    values,
  );
  // Stored members dedupe: a second upload sends nothing.
  const puts = methods(fake, 'PUT');
  assert.equal(
    (await exchange.uploadLazyBatch(lazy(values), { batchSize: 100, pack: true })).uploadedObjects,
    0,
  );
  assert.equal(methods(fake, 'PUT'), puts);
});

test('a planted bad pack member fails closed and binds nothing; a later honest upload of that digest succeeds', async t => {
  const { s, fake } = await setup(t),
    exchange = client(s),
    honest = ['first member', 'second member'],
    planted = Buffer.from('first memberSECOND MEMBER'),
    pins = honest.map(pinOf);
  // The pack's checksum is right for its bytes, so R2 takes it; the second member's bytes are not
  // the declared digest's.
  const [row] = await objects.prepareBatch._handler(s.ctx, {
    projectId: 'project',
    objects: pins,
    pack: { digest: digest(planted), size: planted.length, members: [0, 1] },
  });
  assert.equal(rows(s).length, 1, 'only the pending pack row exists before its commit');
  await putR2(row.target, planted);
  await assert.rejects(
    commit.commitBatch._handler(s.ctx, { objects: [{ id: row.id }] }),
    e => e.data?.code === 'R2_OBJECT_CHECKSUM_MISMATCH',
  );
  assert.deepEqual(
    rows(s).map(row => [row.digest, row.r2Committed]),
    [[digest(planted), undefined]],
    'no member row, and the pack stays pending for the sweep',
  );
  assert.deepEqual(
    await objects.missing._handler(s.ctx, { projectId: 'project', objects: pins }),
    pins.map(pin => pin.digest),
  );
  // Readers never see the planted bytes: the digests are not stored.
  await assert.rejects(exchange.downloadBatch([{ sha256: pins[1].digest, size: pins[1].size }]));
  // An honest pack of the same digests, and an honest raw upload, both store and read back.
  await exchange.uploadLazyBatch(lazy(honest), { batchSize: 100, pack: true });
  assert.deepEqual(
    (await exchange.downloadBatch(pins.map(pin => ({ sha256: pin.digest, size: pin.size })))).map(String),
    honest,
  );
  const raw = await objects.prepareBatch._handler(s.ctx, {
    projectId: 'project',
    objects: [pinOf('third member'), pinOf('fourth member')],
    pack: { digest: digest('third memberFOURTH MEMBER'), size: 25, members: [0, 1] },
  });
  await putR2(raw[0].target, Buffer.from('third memberFOURTH MEMBER'));
  await assert.rejects(commit.commitBatch._handler(s.ctx, { objects: [{ id: raw[0].id }] }));
  assert.equal((await exchange.uploadBatch(content(['fourth member']))).uploadedObjects, 1);
  assert.deepEqual(
    String((await exchange.downloadBatch([{ sha256: digest('fourth member'), size: 13 }]))[0]),
    'fourth member',
  );
  assert.ok(fake.requests.some(r => r.method === 'GET'));
});

test('a pending pack row is never re-laid out by a second client with other member boundaries', async t => {
  const { s } = await setup(t),
    exchange = client(s),
    first = await buildUploadPack(lazy(['abc', 'def']), [0, 1]),
    second = await buildUploadPack(lazy(['ab', 'cdef']), [0, 1]);
  assert.equal(first.proposal.digest, second.proposal.digest, 'same pack bytes, other member boundaries');
  const prepared = await objects.prepareBatch._handler(s.ctx, {
    projectId: 'project',
    objects: ['abc', 'def'].map(pinOf),
    pack: first.proposal,
  });
  assert.ok(prepared[0].target && prepared[0].pack);
  const pending = rows(s).map(row => structuredClone(row));
  // The second client gets single uploads and the pending pack row is untouched.
  const singles = await objects.prepareBatch._handler(s.ctx, {
    projectId: 'project',
    objects: ['ab', 'cdef'].map(pinOf),
    pack: second.proposal,
  });
  assert.ok(singles.every(row => row.target && !row.pack));
  assert.deepEqual(
    rows(s).find(row => row.digest === first.proposal.digest),
    pending.find(row => row.digest === first.proposal.digest),
  );
  // The first client's own commit still binds its members from the pack it uploaded.
  await putR2(prepared[0].target, Buffer.from(first.bytes));
  await commit.commitBatch._handler(s.ctx, { objects: [{ id: prepared[0].id }] });
  const bytes = await exchange.downloadBatch(
    ['abc', 'def'].map(value => ({ sha256: digest(value), size: 3 })),
  );
  assert.deepEqual(bytes.map(String), ['abc', 'def']);
});

test('a pack with a stored member falls back to per-object uploads, and a retried pack is charged once', async t => {
  const { s, fake } = await setup(t),
    exchange = client(s);
  await exchange.uploadBatch(content(['already kept']));
  const puts = methods(fake, 'PUT');
  await exchange.uploadLazyBatch(lazy(['already kept', 'new alpha', 'new beta']), {
    batchSize: 100,
    pack: true,
  });
  // The stored member would be kept twice inside a pack: the two new objects go up one by one.
  assert.equal(methods(fake, 'PUT') - puts, 2);
  assert.ok(rows(s).every(row => !row.pack && !row.packMembers));
  // A retried prepare of the same pack reuses its pending row and charges its members once.
  const values = ['retry alpha', 'retry beta'],
    built = await buildUploadPack(lazy(values), [0, 1]),
    args = { projectId: 'project', objects: values.map(pinOf), pack: built.proposal },
    before = charged(s),
    first = await objects.prepareBatch._handler(s.ctx, args),
    again = await objects.prepareBatch._handler(s.ctx, args);
  assert.equal(charged(s) - before, built.bytes.length);
  assert.equal(first[0].id, again[0].id);
  assert.ok(first[0].target && !first[1].target, 'one PUT target, on the first member');
  assert.deepEqual(
    first.map(row => row.pack.offset),
    [0, values[0].length],
  );
  // Clients pack only distinct, non-empty, source-sized members within the pack bound.
  const pin = size => ({ sha256: digest(String(size)), size });
  assert.deepEqual(uploadPackMembers([pin(10), pin(0), pin(300 * 1024), pin(10), pin(20)]), [0, 4]);
  assert.deepEqual(uploadPackMembers([pin(10), pin(300 * 1024)]), []);
  // A malformed proposal is refused before anything is prepared.
  await assert.rejects(
    objects.prepareBatch._handler(s.ctx, {
      ...args,
      pack: { ...built.proposal, size: built.proposal.size + 1 },
    }),
    e => e.data?.code === 'BAD_ARGUMENT',
  );
});
