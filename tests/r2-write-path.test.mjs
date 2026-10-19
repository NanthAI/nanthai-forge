// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { modules } from './project-exchange-fixture.mjs';
import { fakeR2Config } from './fake-r2.mjs';
import { digest } from '../dist/hash.js';
import { putR2 } from '../dist/exchange-blobs.js';

import { setup, client, pinOf } from './r2-harness.mjs';
const objects = modules.projectObjects,
  commit = modules.projectObjectCommit;
const content = values =>
  values.map(value => ({ pin: { sha256: digest(value), size: value.length }, bytes: Buffer.from(value) }));
const prepare = (s, values) =>
  objects.prepareBatch._handler(s.ctx, { projectId: 'project', objects: values.map(pinOf) });
const rows = s => [...s.tables.projectObjects.values()];

test('with the flag off, or without the project opt-in, prepareBatch is unchanged', async t => {
  for (const options of [{ flag: '' }, { optIn: false }, { flag: 'other' }]) {
    const { s } = await setup(t, options),
      [row] = await prepare(s, ['plain']);
    assert.equal(row.uploadUrl, 'https://fixture.invalid/upload');
    assert.equal(row.target, undefined);
    const stored = rows(s)[0];
    assert.equal(stored.location, undefined);
    assert.equal(stored.r2Key, undefined);
  }
});

test('flag plus opt-in returns a presigned create-only PUT and a pending r2 row', async t => {
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

test('missing configuration with the flag on fails closed with a typed error and inserts nothing', async t => {
  const { s } = await setup(t, { credentials: false });
  await assert.rejects(prepare(s, ['x']), e => e.data?.code === 'R2_NOT_CONFIGURED');
  assert.equal(rows(s).length, 0);
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

test('a pending Convex row keeps its Convex path when the flag turns on', async t => {
  const { s, fake } = await setup(t, { flag: '' }),
    [first] = await prepare(s, ['old-a']);
  assert.ok(first.uploadUrl);
  process.env.FORGE_BLOBS = 'r2';
  const [again] = await prepare(s, ['old-a']);
  assert.equal(again.target, undefined);
  assert.equal(again.uploadUrl, 'https://fixture.invalid/upload');
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
  const convexRow = (await objects.prepare._handler(s.ctx, { projectId: 'project', ...pinOf('legacy') })).id;
  await assert.rejects(
    commit.commitBatch._handler(s.ctx, { objects: [{ id: convexRow }] }),
    e => e.data?.code === 'BAD_ARGUMENT',
  );
});

test('only the owner can change the project opt-in', async t => {
  const { s } = await setup(t, { optIn: false }),
    project = () => s.tables.hostedProjects.get('project');
  s.caller('stranger');
  await assert.rejects(commit.setR2Writes._handler(s.ctx, { projectId: 'project', enabled: true }));
  assert.equal(project().r2Writes, undefined);
  s.caller('owner');
  await commit.setR2Writes._handler(s.ctx, { projectId: 'project', enabled: true });
  assert.equal(project().r2Writes, true);
  await commit.setR2Writes._handler(s.ctx, { projectId: 'project', enabled: false });
  assert.equal(project().r2Writes, false);
});

test('a pending r2 row returns to the Convex path when the opt-in is turned off', async t => {
  const { s } = await setup(t),
    [first] = await prepare(s, ['flip']);
  assert.ok(first.target);
  s.tables.hostedProjects.get('project').r2Writes = false;
  const [second] = await prepare(s, ['flip']);
  assert.equal(second.uploadUrl, 'https://fixture.invalid/upload');
  assert.equal(second.target, undefined);
  assert.equal(rows(s)[0].location, 'convex');
  assert.equal(rows(s)[0].r2Key, undefined);
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
