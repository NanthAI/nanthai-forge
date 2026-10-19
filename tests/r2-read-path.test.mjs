// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { modules } from './project-exchange-fixture.mjs';
import { fakeR2Config } from './fake-r2.mjs';
import { setup, client, pinOf } from './r2-harness.mjs';
import { digest } from '../dist/hash.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { pushNativeExchange, pullNativeExchange } from '../dist/native-exchange.js';
import { getSigned } from '../dist/exchange-r2-read.js';

const objects = modules.projectObjects,
  downloads = modules.projectObjectDownloads,
  actions = modules.projectExchangeActions;
const rows = s => [...s.tables.projectObjects.values()];
const pins = values => values.map(pinOf).map(p => ({ sha256: p.digest, size: p.size }));
const content = values =>
  values.map(value => ({ pin: { sha256: digest(value), size: value.length }, bytes: Buffer.from(value) }));
const sign = (s, values, projectId = 'project') =>
  downloads.signDownloads._handler(s.ctx, { projectId, digests: values.map(v => pinOf(v).digest) });
const code = expected => error => error.data?.code === expected || error.code === expected;
const keyOf = (fake, text) => fake.key(`v1/p/project/o/${pinOf(text).digest}`);

/** Convex-stored rows next to R2 rows in one project: some uploaded with R2 off, the rest with it on. */
async function mixed(t) {
  const harness = await setup(t, { flag: '' }),
    { s } = harness,
    exchange = client(s);
  await exchange.uploadBatch(content(['legacy-a', 'legacy-b']));
  process.env.FORGE_BLOBS = 'r2';
  s.tables.hostedProjects.get('project').r2Writes = true;
  await exchange.uploadBatch(content(['modern-a', 'modern-b', 'modern-c']));
  return { ...harness, exchange };
}

test('signDownloads signs only committed r2 rows of this project, with a 5 minute path-style URL', async t => {
  const { s, fake } = await setup(t),
    exchange = client(s);
  await exchange.uploadBatch(content(['committed']));
  const [pending] = await objects.prepareBatch._handler(s.ctx, {
    projectId: 'project',
    objects: [pinOf('pending')],
  });
  assert.equal(pending.stored, false);
  s.tables.hostedProjects.set('other', { ...s.tables.hostedProjects.get('project'), _id: 'other' });
  const result = await sign(s, ['committed', 'pending', 'never-uploaded']);
  assert.deepEqual(
    result.map(r => r.digest),
    [pinOf('committed').digest],
  );
  const url = new URL(result[0].url);
  assert.equal(result[0].size, 9);
  assert.equal(url.host, `${fakeR2Config.accountId}.r2.cloudflarestorage.com`);
  assert.equal(url.pathname, `/${fakeR2Config.bucket}/v1/p/project/o/${pinOf('committed').digest}`);
  assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.ok(!result[0].url.includes(fakeR2Config.secretAccessKey));
  assert.equal((await fetch(result[0].url)).status, 200);
  // Another project's digest is invisible even though the object exists in the bucket.
  assert.deepEqual(await sign(s, ['committed'], 'other'), []);
  assert.deepEqual(await sign(s, []), []);
  await assert.rejects(
    downloads.signDownloads._handler(s.ctx, {
      projectId: 'project',
      digests: Array.from({ length: 101 }, (_, i) => String(i).padStart(64, '0')),
    }),
    code('BAD_ARGUMENT'),
  );
  // Removed rows and malformed digests are not signed either.
  rows(s).find(r => r.digest === pinOf('committed').digest).removed = true;
  assert.deepEqual(await sign(s, ['committed']), []);
  assert.deepEqual(
    await downloads.signDownloads._handler(s.ctx, { projectId: 'project', digests: ['../x', ''] }),
    [],
  );
});

test('signing re-checks current access on every call: strangers, removed members and revoked credentials get nothing', async t => {
  const { s } = await setup(t);
  await client(s).uploadBatch(content(['guarded']));
  s.caller('stranger');
  await assert.rejects(sign(s, ['guarded']), code('PROJECT_UNAVAILABLE'));
  s.tables.projectContributors.set('grant', { _id: 'grant', projectId: 'project', contributor: 'member' });
  s.caller('member');
  assert.equal((await sign(s, ['guarded'])).length, 1);
  s.tables.projectContributors.delete('grant');
  await assert.rejects(sign(s, ['guarded']), code('PROJECT_UNAVAILABLE'));
  s.tables.projectReaders.set('reader', { _id: 'reader', projectId: 'project', reader: 'member' });
  assert.equal((await sign(s, ['guarded'])).length, 1);
  s.tables.projectReaders.delete('reader');
  await assert.rejects(sign(s, ['guarded']), code('PROJECT_UNAVAILABLE'));
  // Anonymous callers are refused on a private project.
  s.caller(undefined);
  await assert.rejects(sign(s, ['guarded']), code('PROJECT_UNAVAILABLE'));
  // A device credential works until it is revoked.
  s.caller('owner');
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'device' });
  s.tables.cliCredentials.set('device', {
    _id: 'device',
    credentialId: 'device',
    owner: 'owner',
    scope: 'cli',
    revoked: false,
    expiresAt: Date.now() + 60_000,
  });
  assert.equal((await sign(s, ['guarded'])).length, 1);
  s.tables.cliCredentials.get('device').revoked = true;
  await assert.rejects(sign(s, ['guarded']), code('AUTH_REVOKED'));
  // Deleting the project ends signing for the owner as well.
  s.tables.cliCredentials.get('device').revoked = false;
  s.tables.hostedProjects.get('project').removal = 'deleting';
  await assert.rejects(sign(s, ['guarded']), code('PROJECT_UNAVAILABLE'));
});

test('public projects sign without sign-in; private ones do not', async t => {
  const { s } = await setup(t);
  await client(s).uploadBatch(content(['open source']));
  s.caller(undefined);
  await assert.rejects(sign(s, ['open source']), code('PROJECT_UNAVAILABLE'));
  s.tables.hostedProjects.get('project').visibility = 'public';
  assert.equal((await sign(s, ['open source'])).length, 1);
  s.tables.hostedProjects.get('project').removal = 'deleting';
  await assert.rejects(sign(s, ['open source']), code('PROJECT_UNAVAILABLE'));
});

test('missing R2 settings fail closed only when an R2 row has to be signed', async t => {
  const { s } = await setup(t);
  await client(s).uploadBatch(content(['needs settings']));
  const saved = process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_SECRET_ACCESS_KEY;
  t.after(() => {
    process.env.R2_SECRET_ACCESS_KEY = saved;
  });
  await assert.rejects(sign(s, ['needs settings']), code('R2_NOT_CONFIGURED'));
  // Nothing to sign for this digest, so no settings are needed.
  assert.deepEqual(await sign(s, ['not an r2 object']), []);
});

test('mixed-location pull: convex and r2 rows come back verified, r2 bytes straight from R2', async t => {
  const { s, fake, exchange } = await mixed(t),
    all = ['legacy-a', 'modern-a', 'legacy-b', 'modern-b', 'modern-c'],
    before = fake.requests.length;
  assert.deepEqual(
    rows(s).map(r => r.location ?? 'convex'),
    ['convex', 'convex', 'r2', 'r2', 'r2'],
  );
  const reader = client(s),
    result = await reader.downloadBatch(pins(all));
  assert.deepEqual(
    result.map(b => b.toString()),
    all,
  );
  const gets = fake.requests.slice(before).filter(r => r.method === 'GET');
  assert.equal(gets.length, 3, 'only the r2 rows touch the bucket');
  // A single large-ish read also dispatches per row.
  assert.equal((await reader.download(pins(['modern-b'])[0])).toString(), 'modern-b');
  assert.equal((await exchange.download(pins(['legacy-a'])[0])).toString(), 'legacy-a');
  // downloadToFile reads r2 content too.
  const dir = mkdtempSync(join(tmpdir(), 'forge-r2-read-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await client(s).downloadToFile(pins(['modern-c'])[0], join(dir, 'c.txt'));
  assert.equal(readFileSync(join(dir, 'c.txt'), 'utf8'), 'modern-c');
});

test('GETs run at least eight at a time and signing is batched at 100 digests', async t => {
  const { s, fake } = await setup(t),
    values = Array.from({ length: 130 }, (_, i) => `object number ${i}`),
    exchange = client(s);
  await exchange.uploadBatch(content(values));
  const signCalls = [],
    run = exchange.client.mutation;
  exchange.client.mutation = (ref, args) => {
    if (args.digests) signCalls.push(args.digests.length);
    return run(ref, args);
  };
  fake.getDelay = 30;
  const reader = client(s);
  reader.client.mutation = exchange.client.mutation;
  const result = await reader.downloadBatch(pins(values));
  assert.deepEqual(
    result.map(b => b.toString()),
    values,
  );
  assert.deepEqual(
    signCalls.sort((a, b) => b - a),
    [100, 30],
  );
  assert.ok(fake.maxActive >= 8, `saw ${fake.maxActive} concurrent GETs`);
  assert.ok(fake.maxActive <= 20, `saw ${fake.maxActive} concurrent GETs`);
});

test('GET retries 5xx, then reports a typed error after the budget', async t => {
  const { s, fake } = await setup(t);
  await client(s).uploadBatch(content(['flaky']));
  fake.failGets = 2;
  assert.equal((await client(s).downloadBatch(pins(['flaky'])))[0].toString(), 'flaky');
  assert.equal(fake.requests.filter(r => r.method === 'GET' && r.status === 503).length, 2);
  fake.failGets = 99;
  await assert.rejects(client(s).downloadBatch(pins(['flaky'])), code('R2_READ_FAILED'));
  fake.failGets = 0;
  fake.objects.delete(keyOf(fake, 'flaky'));
  await assert.rejects(client(s).downloadBatch(pins(['flaky'])), code('R2_OBJECT_MISSING'));
});

test('an expired URL is signed again once, then the read fails cleanly', async t => {
  const { s, fake } = await setup(t);
  await client(s).uploadBatch(content(['expiring']));
  let signs = 0;
  const reader = () => {
    const fresh = client(s),
      run = fresh.client.mutation;
    fresh.client.mutation = (ref, args) => {
      signs++;
      return run(ref, args);
    };
    return fresh;
  };
  fake.forbidGets = 1;
  assert.equal((await reader().downloadBatch(pins(['expiring'])))[0].toString(), 'expiring');
  assert.equal(signs, 2, 'one batch signature plus one fresh signature');
  signs = 0;
  fake.forbidGets = 5;
  await assert.rejects(reader().downloadBatch(pins(['expiring'])), code('EXCHANGE_DOWNLOAD_DENIED'));
  assert.equal(signs, 2, 'never signs a third time');
  fake.forbidGets = 0;
  // A genuinely expired signature (clock moved past the TTL) behaves the same way.
  const { url } = (await sign(s, ['expiring']))[0];
  fake.clockSkew = 400_000;
  assert.equal(await getSigned(url, pins(['expiring'])[0]), 'forbidden');
});

test('a corrupt object is rejected with BLOB_DIGEST_MISMATCH and never written to disk', async t => {
  const { s, fake } = await setup(t);
  await client(s).uploadBatch(content(['pristine bytes']));
  fake.corrupt.add(keyOf(fake, 'pristine bytes'));
  const reader = client(s);
  await assert.rejects(reader.downloadBatch(pins(['pristine bytes'])), code('BLOB_DIGEST_MISMATCH'));
  const dir = mkdtempSync(join(tmpdir(), 'forge-r2-corrupt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    reader.downloadToFile(pins(['pristine bytes'])[0], join(dir, 'x')),
    code('BLOB_DIGEST_MISMATCH'),
  );
  assert.throws(() => readFileSync(join(dir, 'x')), /ENOENT/);
  // The server-side reader (publication and views) verifies too.
  await assert.rejects(
    actions.downloadBatch._handler(s.ctx, {
      projectId: 'project',
      digests: [pinOf('pristine bytes').digest],
    }),
    code('BLOB_DIGEST_MISMATCH'),
  );
  fake.corrupt.clear();
  assert.equal((await reader.downloadBatch(pins(['pristine bytes'])))[0].toString(), 'pristine bytes');
});

test('the fake serves Range reads with 206 and rejects an unsatisfiable range', async t => {
  const { s } = await setup(t);
  await client(s).uploadBatch(content(['0123456789']));
  const { url } = (await sign(s, ['0123456789']))[0],
    ranged = await fetch(url, { headers: { Range: 'bytes=2-5' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await ranged.text(), '2345');
  assert.equal((await fetch(url, { headers: { Range: 'bytes=40-' } })).status, 416);
});

test('committed r2 rows stay readable with FORGE_BLOBS unset, server side and from the CLI', async t => {
  const { s } = await setup(t),
    writer = client(s);
  await writer.uploadBatch(content(['stays readable']));
  delete process.env.FORGE_BLOBS;
  assert.equal((await sign(s, ['stays readable'])).length, 1);
  assert.equal((await client(s).downloadBatch(pins(['stays readable'])))[0].toString(), 'stays readable');
  const rowsNow = await objects.resolve._handler(s.ctx, {
    projectId: 'project',
    actor: 'owner',
    digests: [pinOf('stays readable').digest],
  });
  assert.equal(rowsNow[0].location, 'r2');
  // The Convex-side reader (publication, views) still serves it through a signed GET.
  const served = await actions.downloadBatch._handler(s.ctx, {
    projectId: 'project',
    digests: [pinOf('stays readable').digest],
  });
  assert.equal(Buffer.from(served[0].data).toString(), 'stays readable');
  const part = await actions.downloadPart._handler(s.ctx, {
    projectId: 'project',
    digest: pinOf('stays readable').digest,
    offset: 0,
  });
  assert.equal(Buffer.from(part.data).toString(), 'stays readable');
});

test('pending r2 rows are not readable until committed', async t => {
  const { s } = await setup(t);
  await objects.prepareBatch._handler(s.ctx, { projectId: 'project', objects: [pinOf('half done')] });
  await assert.rejects(
    objects.resolve._handler(s.ctx, {
      projectId: 'project',
      actor: 'owner',
      digests: [pinOf('half done').digest],
    }),
    code('INVALID_WORK_BACKUP'),
  );
});

test('flag off: signDownloads reads nothing for convex rows and needs no R2 settings', async t => {
  const { s } = await setup(t, { flag: '', optIn: false, credentials: false }),
    exchange = client(s);
  await exchange.uploadBatch(content(['plain']));
  assert.deepEqual(await sign(s, ['plain']), []);
  assert.equal((await client(s).downloadBatch(pins(['plain'])))[0].toString(), 'plain');
});

test('full round trip on an opted-in project: push, publish, pull back with verification', async t => {
  const { s, fake } = await setup(t),
    dir = mkdtempSync(join(tmpdir(), 'forge-r2-roundtrip-')),
    root = join(dir, 'owner');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(root);
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'b.txt'), 'second file\n');
  initNative(root);
  const store = new WorkStore(root),
    sender = client(s),
    published = await pushNativeExchange(store, store.revision(), randomUUID(), sender);
  assert.ok(published.backupId);
  const stored = rows(s).filter(r => !r.removed);
  assert.ok(stored.length >= 3);
  assert.ok(stored.filter(r => r.location === 'r2').length >= 3, 'source objects live in R2');
  assert.ok(fake.objects.size >= 3);
  const backup = s.tables.projectBackups.get(published.backupId);
  assert.equal(backup.transport, 'objects');
  assert.equal(backup.storageId, undefined);
  const before = fake.requests.filter(r => r.method === 'GET').length,
    receiver = client(s);
  await pullNativeExchange(published.backupId, join(dir, 'pulled'), receiver);
  assert.equal(readFileSync(join(dir, 'pulled', 'a.ts'), 'utf8'), 'export const a = 1;\n');
  assert.equal(readFileSync(join(dir, 'pulled', 'b.txt'), 'utf8'), 'second file\n');
  assert.ok(fake.requests.filter(r => r.method === 'GET').length > before, 'the pull read R2 directly');
  // Corruption anywhere in the closure stops the pull before anything is written.
  const [victim] = [...fake.objects.keys()].filter(
    key => fake.objects.get(key).toString() === 'second file\n',
  );
  fake.corrupt.add(victim);
  await assert.rejects(
    pullNativeExchange(published.backupId, join(dir, 'corrupt'), client(s)),
    code('BLOB_DIGEST_MISMATCH'),
  );
});

test('a large chunked file in an opted-in project round trips through R2 leaves', async t => {
  const { s, fake } = await setup(t),
    dir = mkdtempSync(join(tmpdir(), 'forge-r2-large-')),
    root = join(dir, 'owner'),
    big = Buffer.alloc(5 * 1024 * 1024 + 123);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 11)) & 255;
  mkdirSync(root);
  writeFileSync(join(root, 'big.bin'), big);
  writeFileSync(join(root, 'small.txt'), 'small\n');
  initNative(root);
  const store = new WorkStore(root),
    published = await pushNativeExchange(store, store.revision(), randomUUID(), client(s));
  assert.ok(
    rows(s).some(r => r.recipe),
    'the large file is stored as a recipe',
  );
  assert.ok(rows(s).filter(r => r.location === 'r2').length > 3);
  assert.ok(fake.objects.size > 3);
  await pullNativeExchange(published.backupId, join(dir, 'pulled'), client(s));
  assert.ok(readFileSync(join(dir, 'pulled', 'big.bin')).equals(big));
  assert.equal(readFileSync(join(dir, 'pulled', 'small.txt'), 'utf8'), 'small\n');
});
