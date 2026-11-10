// SPDX-License-Identifier: Apache-2.0
import { transferArchiveFixture } from './native-archive-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { modules } from './project-exchange-fixture.mjs';
import { fakeR2Config } from './fake-r2.mjs';
import { setup, client, pinOf, legacyObject } from './r2-harness.mjs';
import { digest } from '../dist/hash.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { pullNativeExchange } from '../dist/native-exchange.js';
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

/** Legacy Convex-stored rows next to R2 rows in one project. */
async function mixed(t) {
  const harness = await setup(t),
    { s } = harness,
    exchange = client(s);
  for (const text of ['legacy-a', 'legacy-b']) await legacyObject(s, Buffer.from(text));
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
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
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
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await assert.rejects(
    reader.downloadToFile(pins(['pristine bytes'])[0], join(dir, 'x')),
    code('BLOB_DIGEST_MISMATCH'),
  );
  assert.throws(() => readFileSync(join(dir, 'x')), /ENOENT/);
  // Public download actions return metadata only, even for a corrupt R2 object.
  const before = fake.requests.length;
  const redirected = await actions.downloadBatch._handler(s.ctx, {
    projectId: 'project',
    digests: [pinOf('pristine bytes').digest],
  });
  assert.deepEqual(redirected, [{ direct: true, ...pinOf('pristine bytes') }]);
  assert.equal(fake.requests.length, before);
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

test('committed r2 rows stay readable directly from the CLI', async t => {
  const { s } = await setup(t),
    writer = client(s);
  await writer.uploadBatch(content(['stays readable']));
  assert.equal((await sign(s, ['stays readable'])).length, 1);
  assert.equal((await client(s).downloadBatch(pins(['stays readable'])))[0].toString(), 'stays readable');
  const rowsNow = await objects.resolve._handler(s.ctx, {
    projectId: 'project',
    actor: 'owner',
    digests: [pinOf('stays readable').digest],
  });
  assert.equal(rowsNow[0].location, 'r2');
  // Public endpoints redirect to direct reads instead of proxying file bytes.
  const served = await actions.downloadBatch._handler(s.ctx, {
    projectId: 'project',
    digests: [pinOf('stays readable').digest],
  });
  assert.deepEqual(served, [{ direct: true, ...pinOf('stays readable') }]);
  const part = await actions.downloadPart._handler(s.ctx, {
    projectId: 'project',
    digest: pinOf('stays readable').digest,
    offset: 0,
  });
  assert.deepEqual(part, { direct: true, ...pinOf('stays readable') });
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

test('legacy Convex rows: signDownloads signs nothing and the bytes still read', async t => {
  const { s } = await setup(t, { optIn: false });
  await legacyObject(s, Buffer.from('plain'));
  assert.deepEqual(await sign(s, ['plain']), []);
  assert.equal((await client(s).downloadBatch(pins(['plain'])))[0].toString(), 'plain');
});

test('exported archive objects round trip through opted-in storage with verification', async t => {
  const { s, fake } = await setup(t),
    dir = mkdtempSync(join(tmpdir(), 'forge-r2-roundtrip-')),
    root = join(dir, 'owner');
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  mkdirSync(root);
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'b.txt'), 'second file\n');
  initNative(root);
  const store = new WorkStore(root),
    sender = client(s),
    published = await transferArchiveFixture(store, sender);
  assert.ok(published.backupId);
  const stored = rows(s).filter(r => !r.removed);
  assert.ok(stored.length >= 3);
  assert.ok(stored.filter(r => r.location === 'r2').length >= 3, 'source objects live in R2');
  assert.ok(fake.objects.size >= 3);
  const before = fake.requests.filter(r => r.method === 'GET').length,
    receiver = client(s);
  receiver.manifest = async () => ({
    json: published.json,
    digest: published.digest,
    size: Buffer.byteLength(published.json),
  });
  await pullNativeExchange(published.backupId, join(dir, 'pulled'), receiver);
  assert.equal(readFileSync(join(dir, 'pulled', 'a.ts'), 'utf8'), 'export const a = 1;\n');
  assert.equal(readFileSync(join(dir, 'pulled', 'b.txt'), 'utf8'), 'second file\n');
  assert.ok(fake.requests.filter(r => r.method === 'GET').length > before, 'the pull read R2 directly');
  // Corruption anywhere in the closure stops the pull before anything is written.
  const [victim] = [...fake.objects.keys()].filter(
    key => fake.objects.get(key).toString() === 'second file\n',
  );
  assert.ok(victim, 'the corruption hook targets the source blob');
  fake.corrupt.add(victim);
  // Start a new transfer: the previous client correctly retains verified bytes.
  const corruptReceiver = client(s);
  corruptReceiver.manifest = receiver.manifest;
  await assert.rejects(
    pullNativeExchange(published.backupId, join(dir, 'corrupt'), corruptReceiver),
    code('BLOB_DIGEST_MISMATCH'),
  );
});

test('a large chunked file in an opted-in project round trips through R2 leaves', async t => {
  const { s, fake } = await setup(t),
    dir = mkdtempSync(join(tmpdir(), 'forge-r2-large-')),
    root = join(dir, 'owner'),
    big = Buffer.alloc(5 * 1024 * 1024 + 123);
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 11)) & 255;
  mkdirSync(root);
  writeFileSync(join(root, 'big.bin'), big);
  writeFileSync(join(root, 'small.txt'), 'small\n');
  initNative(root);
  const store = new WorkStore(root),
    published = await transferArchiveFixture(store, client(s));
  assert.ok(
    rows(s).some(r => r.recipe),
    'the large file is stored as a recipe',
  );
  assert.ok(rows(s).filter(r => r.location === 'r2').length > 3);
  assert.ok(fake.objects.size > 3);
  const receiver = client(s);
  receiver.manifest = async () => ({
    json: published.json,
    digest: published.digest,
    size: Buffer.byteLength(published.json),
  });
  await pullNativeExchange(published.backupId, join(dir, 'pulled'), receiver);
  assert.ok(readFileSync(join(dir, 'pulled', 'big.bin')).equals(big));
  assert.equal(readFileSync(join(dir, 'pulled', 'small.txt'), 'utf8'), 'small\n');
});

test('mixed history: import packs, raw rows and upload packs read back exact in one clone, one GET per run (98ee14e8)', async t => {
  const { moduleUrl } = await import('./convex-module.mjs');
  const { ImportUpload } = await import(moduleUrl('../convex/projectGithubImportUpload.ts'));
  const { catalogPages } = await import(moduleUrl('../convex/projectObjectFind.ts'));
  const { HostedCheckoutDownloads } = await import('../dist/hosted-checkout-downloads.js');
  const { s, fake } = await setup(t),
    writer = client(s);
  // An import window (catalog rows in one server-built pack), raw rows, and a client upload pack.
  const imported = ['import a', 'import b', 'import c'],
    raw = ['raw a', 'raw b'],
    packed = ['save a', 'save b', 'save c'];
  const stored = new Map(),
    upload = new ImportUpload(s.ctx, 'project', 'owner', 8, { stored, record: async () => {} });
  for (const value of imported) upload.put(Buffer.from(value));
  await upload.drain(true);
  for (const page of catalogPages([...stored.values()]))
    s.tables.projectObjectCatalog.set(`catalog-${page.first}`, {
      _id: `catalog-${page.first}`,
      projectId: 'project',
      origin: 'github-import:synthetic',
      ...page,
    });
  await writer.uploadBatch(content(raw));
  await writer.uploadLazyBatch(
    content(packed).map(({ pin, bytes }) => ({ pin, read: () => bytes })),
    { batchSize: 100, pack: true },
  );
  const all = [...imported, ...raw, ...packed],
    wanted = pins(all);
  const exchange = {
    projectId: 'project',
    client: { mutation: (_ref, args) => downloads.describe._handler(s.ctx, args) },
  };
  const transfer = new HostedCheckoutDownloads(exchange);
  await transfer.objects(wanted.map(pin => pin.sha256));
  const directory = mkdtempSync(join(tmpdir(), 'forge-mixed-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const before = fake.requests.filter(r => r.method === 'GET').length;
  await transfer.downloadFiles(wanted.map(pin => ({ pin, path: join(directory, pin.sha256) })));
  for (const [i, pin] of wanted.entries())
    assert.equal(readFileSync(join(directory, pin.sha256), 'utf8'), all[i]);
  // One run for the import window, one for the upload pack, one GET for each raw row.
  assert.equal(fake.requests.filter(r => r.method === 'GET').length - before, 4);
});

test('trusted recipe closure stages exact project leaves and signs them in the existing logical read', async t => {
  const { s } = await setup(t),
    exchange = client(s);
  const { storeSourceOutputs } = await import(
    (await import('./convex-module.mjs')).moduleUrl('../convex/projectConvexSourceOutput.ts')
  );
  const leaves = ['first leaf', 'second leaf'];
  for (const leaf of leaves) await exchange.uploadBatch(content([leaf]));
  const body = JSON.stringify({ synthetic: 'trusted action verified recipe' });
  await exchange.uploadBatch(content([body]));
  const pin = { sha256: digest(leaves.join('')), size: Buffer.byteLength(leaves.join('')) };
  const closure = pins(leaves);
  await storeSourceOutputs(s.ctx, 'project', 'trusted-worker', [
    { ...pin, recipe: pins([body])[0], recipeClosure: closure },
  ]);
  const [row] = await downloads.describe._handler(s.ctx, {
    projectId: 'project',
    digests: [pin.sha256],
    signed: true,
  });
  assert.equal(row.location, 'recipe');
  assert.deepEqual(
    row.closure.map(({ digest, size }) => ({ sha256: digest, size })),
    closure,
  );
  assert(row.closure.every(leaf => new URL(leaf.url).pathname.endsWith(`/p/project/o/${leaf.digest}`)));
  assert.equal(
    (await downloads.describe._handler(s.ctx, { projectId: 'project', digests: [pin.sha256] }))[0].closure,
    undefined,
  );
  s.caller('stranger');
  await assert.rejects(
    downloads.describe._handler(s.ctx, { projectId: 'project', digests: [pin.sha256], signed: true }),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('trusted closure refuses unstaged, packed, wrong-size and oversized projections before publication', async t => {
  const { s } = await setup(t),
    exchange = client(s);
  const { storeSourceOutputs } = await import(
    (await import('./convex-module.mjs')).moduleUrl('../convex/projectConvexSourceOutput.ts')
  );
  await exchange.uploadBatch(content(['leaf', 'recipe']));
  const pin = { sha256: digest('logical'), size: 4 },
    recipe = pins(['recipe'])[0];
  for (const closure of [
    [{ sha256: 'a'.repeat(64), size: 4 }],
    [{ ...pins(['leaf'])[0], size: 3 }],
    Array.from({ length: 101 }, () => ({ ...pins(['leaf'])[0], size: 0 })),
  ])
    await assert.rejects(
      storeSourceOutputs(s.ctx, 'project', 'trusted-worker', [{ ...pin, recipe, recipeClosure: closure }]),
      code('SOURCE_HASH_MISMATCH'),
    );
  assert(!rows(s).some(row => row.digest === pin.sha256));
});

async function trustedClosureFixture(t, count = 12, packed = false) {
  const { s, fake } = await setup(t),
    exchange = client(s);
  const parts = Array.from({ length: count }, (_, i) => {
    const bytes = Buffer.alloc(128 * 1024, 65 + i);
    bytes.writeUInt32LE(i);
    return bytes;
  });
  if (packed)
    await exchange.uploadLazyBatch(
      [Buffer.from('pack-prefix'), ...parts, Buffer.from('pack-suffix')].map(bytes => ({
        pin: { sha256: digest(bytes), size: bytes.length },
        read: () => bytes,
      })),
      { batchSize: 100, pack: true },
    );
  else for (const bytes of parts) await exchange.uploadBatch(content([bytes]));
  const bytes = Buffer.concat(parts),
    pin = { sha256: digest(bytes), size: bytes.length },
    leaves = pins(parts);
  const index = Buffer.from(
    JSON.stringify({
      kind: 'forge-byte-tree',
      schema: 1,
      children: leaves.map(leaf => ({ ...leaf, height: 0, length: leaf.size })),
    }),
  );
  await exchange.uploadBatch(content([index]));
  const recipe = Buffer.from(
    JSON.stringify({
      kind: 'forge-object-recipe',
      schema: 1,
      object: pin,
      tree: { ...pins([index])[0], height: 1, length: pin.size },
    }),
  );
  await exchange.uploadBatch(content([recipe]));
  const { moduleUrl } = await import('./convex-module.mjs');
  const { storeSourceOutputs } = await import(moduleUrl('../convex/projectConvexSourceOutput.ts'));
  await storeSourceOutputs(s.ctx, 'project', 'trusted-worker', [
    { ...pin, recipe: pins([recipe])[0], recipeClosure: leaves },
  ]);
  assert(rows(s).find(row => row.digest === pin.sha256).recipe, 'fixture logical content uses its recipe');
  return { s, fake, pin, bytes, leaves, moduleUrl };
}

for (const packed of [false, true])
  test(`trusted ${packed ? 'packed' : 'raw'} closures read through CLI, browser, server and both checkout transports with flat-object call counts`, async t => {
    const { s, pin, bytes, moduleUrl } = await trustedClosureFixture(t, 25, packed);
    const { getFunctionName } = await import('convex/server');
    const exchange = client(s),
      calls = [];
    const original = exchange.client.mutation;
    exchange.client.mutation = (ref, args) => {
      calls.push(getFunctionName(ref));
      return original(ref, args);
    };
    assert.deepEqual(await exchange.download(pin), bytes);
    assert.deepEqual(
      calls,
      ['projectObjectDownloads:signDownloads'],
      'CLI obtains the entire closure in the existing signing call',
    );
    const { ObjectDownloadReader } = await import('../dist/blob-download.js');
    let described = 0;
    const browser = new ObjectDownloadReader({
      describe: (digests, signed) => {
        described++;
        return downloads.describe._handler(s.ctx, { projectId: 'project', digests, signed });
      },
      sign: () => assert.fail('closure incurred a second signing call'),
    });
    assert.deepEqual(Buffer.from((await browser.read([pin]))[0]), bytes);
    assert.equal(described, 2, 'browser retains the flat before/after access reads');
    const { exchangeObjectReader } = await import(moduleUrl('../convex/projectExchangeReader.ts'));
    let resolved = 0;
    const query = s.ctx.runQuery;
    s.ctx.runQuery = (ref, args) => {
      if (getFunctionName(ref) === 'projectObjects:resolve') resolved++;
      return query(ref, args);
    };
    assert.deepEqual(await exchangeObjectReader(s.ctx, false, 0).read('project', 'owner', [pin]), [bytes]);
    assert.equal(resolved, 2, 'server retains the flat before/after access reads');
    const directory = mkdtempSync(join(tmpdir(), 'forge-r2-closure-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const [index, name] of ['HostedCheckoutDownloads', 'ConvexLaneTransport'].entries()) {
      const module = await import(
        name === 'HostedCheckoutDownloads'
          ? '../dist/hosted-checkout-downloads.js'
          : '../dist/hosted-lane-transport.js'
      );
      const checkout = new module[name](exchange),
        path = join(directory, String(index));
      calls.length = 0;
      await checkout.objects([pin.sha256]);
      await checkout.downloadFiles([{ pin, path }]);
      assert.deepEqual(readFileSync(path), bytes);
      assert.equal(
        calls.length,
        name === 'HostedCheckoutDownloads' ? 1 : 2,
        'checkout uses the existing signed page and ordinary final authority read',
      );
    }
  });

test('trusted closure corruption, whole-digest disagreement and mid-read revocation never expose reconstructed bytes', async t => {
  const { s, fake, pin, leaves, moduleUrl } = await trustedClosureFixture(t, 3);
  const { ObjectDownloadReader } = await import('../dist/blob-download.js');
  const reader = () =>
    new ObjectDownloadReader({
      describe: (digests, signed) =>
        downloads.describe._handler(s.ctx, { projectId: 'project', digests, signed }),
      sign: () => assert.fail('unexpected sign'),
    });
  fake.corrupt.add(fake.key(`v1/p/project/o/${leaves[0].sha256}`));
  await assert.rejects(reader().read([pin]), code('BLOB_DIGEST_MISMATCH'));
  fake.corrupt.clear();
  const row = rows(s).find(row => row.digest === pin.sha256);
  row.recipeClosure.reverse();
  await assert.rejects(reader().read([pin]), code('BLOB_DIGEST_MISMATCH'));
  row.recipeClosure.reverse();
  const { exchangeObjectReader } = await import(moduleUrl('../convex/projectExchangeReader.ts'));
  const read = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await read(...args);
    s.tables.hostedProjects.get('project').owner = 'another';
    return response;
  };
  try {
    await assert.rejects(
      exchangeObjectReader(s.ctx, false, 0).read('project', 'owner', [pin]),
      code('PROJECT_UNAVAILABLE'),
    );
  } finally {
    globalThis.fetch = read;
    s.tables.hostedProjects.get('project').owner = 'owner';
  }
});

test('trusted closure source transport fills the existing destination without another descriptor call', async t => {
  const { s, pin, bytes, moduleUrl } = await trustedClosureFixture(t, 3);
  const [row] = await downloads.describe._handler(s.ctx, {
    projectId: 'project',
    digests: [pin.sha256],
    signed: true,
  });
  const { convexSourceTransport } = await import(moduleUrl('../convex/projectConvexSourceTransport.ts'));
  const io = convexSourceTransport(
    { storage: {}, runMutation: () => assert.fail('extra source descriptor call') },
    { projectId: 'project', jobId: 'trusted', step: 0 },
    [
      {
        descriptor: { object: pin, recipe: { sha256: row.recipe.digest, size: row.recipe.size } },
        storageId: null,
        url: null,
        closure: row.closure,
      },
    ],
  ).io;
  const { readSourceExact } = await import('../dist/hosted-source-exact.js');
  assert.deepEqual(Buffer.from(await readSourceExact(io, pin)), bytes);
  assert.equal(io.recipeLeaves(pin.sha256).length, 3);
});

test('expired closure signatures renew the logical grant once for all leaves', async t => {
  const { s, fake, pin, bytes } = await trustedClosureFixture(t, 3);
  const { getFunctionName } = await import('convex/server');
  const exchange = client(s),
    original = exchange.client.mutation;
  let signatures = 0;
  exchange.client.mutation = (ref, args) => {
    if (getFunctionName(ref) === 'projectObjectDownloads:signDownloads') signatures++;
    return original(ref, args);
  };
  fake.forbidGets = 3;
  assert.deepEqual(await exchange.download(pin), bytes);
  assert.equal(signatures, 2, 'one initial logical signature call and one renewal for every expired leaf');
});

test('prepared closure grants are reused and browser/checkouts share one renewal across expired leaves', async t => {
  const { s, fake, pin, bytes } = await trustedClosureFixture(t, 3);
  const { getFunctionName } = await import('convex/server');
  const exchange = client(s),
    original = exchange.client.mutation,
    calls = [];
  exchange.client.mutation = (ref, args) => {
    calls.push(getFunctionName(ref));
    return original(ref, args);
  };
  await exchange.prepareDownloads([pin]);
  assert.deepEqual(await exchange.download(pin), bytes);
  assert.deepEqual(calls, ['projectObjectDownloads:signDownloads']);
  const { ObjectDownloadReader } = await import('../dist/blob-download.js');
  let describes = 0;
  const browser = new ObjectDownloadReader({
    describe: (digests, signed) => {
      describes++;
      return downloads.describe._handler(s.ctx, { projectId: 'project', digests, signed });
    },
    sign: () => assert.fail('unexpected leaf signing'),
  });
  fake.forbidGets = 3;
  assert.deepEqual(Buffer.from((await browser.read([pin]))[0]), bytes);
  assert.equal(describes, 3, 'initial page, one closure renewal, and final current-access check');
  const { HostedCheckoutDownloads } = await import('../dist/hosted-checkout-downloads.js');
  const dir = mkdtempSync(join(tmpdir(), 'forge-r2-renewed-closure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = new HostedCheckoutDownloads(exchange),
    path = join(dir, 'file');
  calls.length = 0;
  await checkout.objects([pin.sha256]);
  fake.forbidGets = 3;
  await checkout.downloadFiles([{ pin, path }]);
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(calls.length, 2, 'one initial page and one shared closure renewal');
});

test('destination reads keep verified bytes in the existing action cache across quanta', async t => {
  const { s, fake, pin, bytes, moduleUrl } = await trustedClosureFixture(t, 24);
  const [row] = await downloads.describe._handler(s.ctx, {
    projectId: 'project',
    digests: [pin.sha256],
    signed: true,
  });
  const { convexSourceTransport } = await import(moduleUrl('../convex/projectConvexSourceTransport.ts'));
  const { readSourceExact } = await import('../dist/hosted-source-exact.js');
  const { cachedReads } = await import('../dist/hosted-source-read-cache.js');
  const original = convexSourceTransport(
    { storage: {}, runMutation: () => assert.fail('extra descriptor read') },
    { projectId: 'project', jobId: 'trusted', step: 0 },
    [
      {
        descriptor: { object: pin, recipe: { sha256: row.recipe.digest, size: row.recipe.size } },
        storageId: null,
        url: null,
        closure: row.closure,
      },
    ],
  );
  const io = cachedReads(original.io, { bytes: new Map(), held: 0 }, 8 * 1024 * 1024);
  const first = await readSourceExact(io, pin),
    requests = fake.requests.length;
  assert.deepEqual(Buffer.from(first), bytes);
  first.fill(0);
  assert.deepEqual(Buffer.from(await readSourceExact(io, pin)), bytes);
  assert.equal(fake.requests.length, requests, 'a later quantum never refetches the same projected State');
  assert.equal(original.reads.bytes, pin.size);
});

test('older signature endpoints are negotiated once and current authorization errors never select a fallback', async () => {
  const { signDownloadObjects } = await import('../dist/exchange-r2-read.js');
  const calls = [];
  const older = {
    mutation: async (_ref, args) => {
      calls.push(args.recipes ?? false);
      if (args.recipes) throw Error('Object contains extra field `recipes`');
      return [];
    },
  };
  await signDownloadObjects(older, 'project', []);
  await signDownloadObjects(older, 'project', []);
  assert.deepEqual(calls, [true, false, false]);
  let refused = 0;
  const denied = {
    mutation: async () => {
      refused++;
      throw Error('AUTH_REVOKED');
    },
  };
  await assert.rejects(signDownloadObjects(denied, 'project', []), /AUTH_REVOKED/);
  assert.equal(refused, 1);
});

test('cost 298f9675: packed closures reject changed range replies and cross-project source pack bindings', async t => {
  const { s, pin, bytes, moduleUrl } = await trustedClosureFixture(t, 3, true);
  const row = rows(s).find(row => row.digest === pin.sha256);
  assert(row.recipeClosure.every(leaf => leaf.pack));
  const { storeSourceOutputs } = await import(moduleUrl('../convex/projectConvexSourceOutput.ts'));
  const pack = row.recipeClosure[0].pack;
  await assert.rejects(
    storeSourceOutputs(s.ctx, 'other', 'bad', [
      {
        sha256: digest(bytes.subarray(0, 1)),
        size: 1,
        pack,
        r2Key: `v1/p/other/o/${pack.digest}`,
      },
    ]),
    code('SOURCE_HASH_MISMATCH'),
  );
  const read = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const reply = await read(url, init);
    if (new Headers(init?.headers).has('range'))
      return new Response(await reply.arrayBuffer(), {
        status: 206,
        headers: { 'content-range': `bytes 0-0/${pack.size}` },
      });
    return reply;
  };
  try {
    await assert.rejects(client(s).download(pin), code('INVALID_WORK_BACKUP'));
  } finally {
    globalThis.fetch = read;
  }
});

test('cost 298f9675: V8 saves publish and consume native State recipes inside their existing byte window', async t => {
  const { s, fake } = await setup(t),
    exchange = client(s),
    { buildSavePages, saveBytes } = await import('../dist/hosted-save.js'),
    { runSmallSourceSave } = await import('../dist/hosted-source-small-save.js'),
    { moduleUrl } = await import('./convex-module.mjs'),
    { convexSourceTransport } = await import(moduleUrl('../convex/projectConvexSourceTransport.ts')),
    { storeSourceOutputs } = await import(moduleUrl('../convex/projectConvexSourceOutput.ts'));
  const original = Buffer.from('original\n');
  await exchange.uploadBatch(content([original]));
  const files = Array.from({ length: 29000 }, (_, i) => ({
    path: `src/${String(i).padStart(6, '0')}.txt`,
    blob: digest(original),
    mode: 'file',
  }));
  const initial = Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files,
      message: 'base',
      at: '2026-01-01T00:00:00Z',
    }),
  );
  let baseline = pins([initial])[0];
  const key = `v1/p/project/o/${baseline.sha256}`;
  fake.objects.set(fake.key(key), initial);
  s.tables.projectObjects.set('native-state', {
    _id: 'native-state',
    _creationTime: Date.now(),
    projectId: 'project',
    digest: baseline.sha256,
    size: baseline.size,
    nonce: 'synthetic',
    removed: false,
    location: 'r2',
    r2Committed: true,
    r2Key: key,
  });
  for (let n = 0; n < 2; n++) {
    const before = files[n].blob,
      changed = Buffer.from(`changed-${n}\n`),
      next = pins([changed])[0];
    const pages = buildSavePages([
      {
        path: files[n].path,
        before: { blob: before, mode: 'file' },
        after: { blob: next.sha256, mode: 'file', content: { object: next, recipe: null } },
      },
    ]);
    const baselineRow = rows(s).find(row => row.digest === baseline.sha256),
      recipe = baselineRow.recipe;
    const plan = Buffer.from(
      saveBytes({
        schema: 1,
        kind: 'forge-hosted-save-input',
        baseline: { object: baseline, recipe: recipe ? { sha256: recipe.digest, size: recipe.size } : null },
        pages: pages.root,
        pageCount: pages.pages.length,
        changeCount: 1,
        message: 'save',
        at: '2026-01-01T00:00:00Z',
      }),
    );
    const upload = [changed, ...pages.pages.map(page => Buffer.from(saveBytes(page.value))), plan];
    await exchange.uploadBatch(content(upload));
    const selected = [baseline, ...pins(upload)],
      described = await downloads.describe._handler(s.ctx, {
        projectId: 'project',
        digests: selected.map(pin => pin.sha256),
        signed: true,
      });
    const locations = described.map((row, i) => ({
      descriptor: {
        object: selected[i],
        recipe: row.location === 'recipe' ? { sha256: row.recipe.digest, size: row.recipe.size } : null,
      },
      storageId: null,
      url: row.location === 'r2' ? row.url : null,
      ...(row.closure ? { closure: row.closure } : {}),
    }));
    const worker = convexSourceTransport(
      { storage: {}, runMutation: () => assert.fail('V8 closure incurred another descriptor call') },
      { projectId: 'project', jobId: 'synthetic-v8', step: 0 },
      locations,
    );
    const offset = fake.requests.length;
    const output = await runSmallSourceSave(pins([plan])[0], worker.io);
    assert(output, 'projected baseline stays in V8');
    await worker.settle();
    await storeSourceOutputs(s.ctx, 'project', 'synthetic-v8', worker.outputs);
    const result = JSON.parse(await client(s).download(output)),
      bytes = await client(s).download(result.state),
      state = JSON.parse(bytes);
    files[n] = { ...files[n], blob: next.sha256 };
    assert.deepEqual(state.files, files);
    assert.deepEqual(state.parents, [baseline.sha256]);
    assert.equal(digest(bytes), result.state.sha256);
    const stored = rows(s).find(row => row.digest === result.state.sha256);
    assert(stored.recipeClosure.some(leaf => leaf.pack));
    const put = fake.requests.slice(offset).filter(request => request.method === 'PUT');
    assert(put.length <= 6, 'changed chunk, header, suffix, recipe metadata and result only');
    assert(worker.putMetrics.snapshot(output).state < 750000);
    baseline = result.state;
  }
});
