// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { digest } from '../dist/hash.js';
import { moduleUrl } from './convex-module.mjs';
import { setup, client, pinOf } from './r2-harness.mjs';
import { modules } from './project-exchange-fixture.mjs';

const { uploadArchiveObjects } = await import(moduleUrl('../web/src/archive-object-upload.ts'));
const rows = s => [...s.tables.projectObjects.values()];
function entry(name, bytes) {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
  header[156] = 48;
  header.fill(32, 148, 156);
  header.write(
    header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148,
  );
  return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
}
function archive() {
  const object = Buffer.from('synthetic source bytes\n'),
    work = Buffer.from('{}'),
    files = [
      { path: 'work.json', bytes: work },
      { path: `objects/${digest(object)}`, bytes: object },
      { path: `objects/${digest(Buffer.alloc(0))}`, bytes: Buffer.alloc(0) },
    ],
    manifest = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-native-work-backup',
        id: randomUUID(),
        head: digest(object),
        revision: 0,
        files: files.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: digest(bytes) })),
        unavailable: [],
        coverage: 'Synthetic upload fixture',
      }),
    );
  return {
    file: new File(
      [
        gzipSync(
          Buffer.concat([
            entry('manifest.json', manifest),
            ...files.map(({ path, bytes }) => entry(path, bytes)),
            Buffer.alloc(1024),
          ]),
        ),
      ],
      'synthetic.tar.gz',
    ),
    manifest,
    object,
  };
}
function noConvexBytes(s) {
  s.ctx.storage.generateUploadUrl = () => assert.fail('R2 must not issue a Convex upload URL');
  s.ctx.storage.store = () => assert.fail('R2 must not store bytes in Convex');
}

test('browser logical objects PUT directly to R2, verify checksums and reuse committed rows', async t => {
  const { s, fake } = await setup(t),
    input = archive(),
    browser = client(s).client;
  noConvexBytes(s);
  const fetcher = globalThis.fetch;
  let puts = 0;
  globalThis.fetch = (url, init) => {
    if (init.method === 'PUT') {
      puts++;
      assert.equal(init.headers['content-length'], undefined, 'the browser sets the signed length');
      assert.equal(init.headers['Content-Type'], undefined);
      assert.equal(init.headers['if-none-match'], '*');
      assert.equal(init.headers['x-amz-checksum-sha256'].length, 44);
      assert.ok(init.body instanceof Blob);
    }
    return fetcher(url, init);
  };
  assert.deepEqual(await uploadArchiveObjects(browser, 'project', input.file), pinOf(input.manifest));
  assert.equal(puts, 4);
  assert.equal(fake.objects.size, 4);
  assert.equal(fake.requests.filter(r => r.method === 'HEAD').length, 4);
  assert.ok(rows(s).every(row => row.location === 'r2' && row.r2Committed && !row.storageId));
  assert.deepEqual(await uploadArchiveObjects(browser, 'project', input.file), pinOf(input.manifest));
  assert.equal(puts, 4);
  assert.equal(fake.requests.filter(r => r.method === 'HEAD').length, 4);
});

test('browser upload preserves Convex POST/complete without opt-in or deployment flag', async t => {
  for (const options of [{ optIn: false }, { flag: '' }])
    await t.test(JSON.stringify(options), async t => {
      const { s, fake } = await setup(t, options),
        input = archive(),
        browser = client(s).client;
      browser.action = () => assert.fail('Convex fallback does not call R2 commit');
      assert.deepEqual(await uploadArchiveObjects(browser, 'project', input.file), pinOf(input.manifest));
      assert.ok(rows(s).every(row => row.storageId && !row.location && !row.r2Committed));
      assert.equal(s.files.size, 4);
      assert.equal(fake.requests.length, 0);
    });
});

test('failed, aborted and checksum-rejected browser PUTs leave pending rows and can retry', async t => {
  for (const failure of ['http', 'abort', 'network', 'checksum'])
    await t.test(failure, async t => {
      const { s, fake } = await setup(t),
        input = archive(),
        browser = client(s).client,
        fetcher = globalThis.fetch;
      noConvexBytes(s);
      globalThis.fetch = (url, init) => {
        assert.equal(init.method, 'PUT');
        if (failure === 'http') return Promise.resolve(new Response(null, { status: 503 }));
        if (failure === 'abort') throw new DOMException('Upload aborted', 'AbortError');
        if (failure === 'network') throw new TypeError('Network error');
        return fetcher(url, { ...init, body: new Blob([Buffer.alloc(init.body.size, 1)]) });
      };
      await assert.rejects(uploadArchiveObjects(browser, 'project', input.file));
      assert.equal(rows(s).length, 1);
      assert.equal(rows(s)[0].r2Committed, undefined);
      assert.equal(rows(s)[0].storageId, undefined);
      assert.equal(fake.objects.size, 0);
      const id = rows(s)[0]._id;
      globalThis.fetch = fetcher;
      await uploadArchiveObjects(browser, 'project', input.file);
      assert.equal(rows(s)[0]._id, id);
      assert.ok(rows(s).every(row => row.r2Committed));
    });
});

test('browser create-only retries commit an existing matching object after 412', async t => {
  const { s, fake } = await setup(t),
    input = archive();
  noConvexBytes(s);
  fake.objects.set(fake.key(`v1/p/project/o/${digest(input.object)}`), input.object);
  await uploadArchiveObjects(client(s).client, 'project', input.file);
  assert.equal(fake.requests.filter(r => r.method === 'PUT' && r.status === 412).length, 1);
  assert.ok(rows(s).every(row => row.r2Committed));
});

test('browser 412 does not commit existing bytes with a different checksum', async t => {
  const { s, fake } = await setup(t),
    input = archive();
  noConvexBytes(s);
  fake.objects.set(fake.key(`v1/p/project/o/${digest(input.object)}`), Buffer.alloc(input.object.length, 1));
  await assert.rejects(
    uploadArchiveObjects(client(s).client, 'project', input.file),
    e => e.data?.code === 'R2_OBJECT_CHECKSUM_MISMATCH',
  );
  assert.equal(rows(s).length, 1);
  assert.equal(rows(s)[0].r2Committed, undefined);
  assert.equal(rows(s)[0].storageId, undefined);
  assert.equal(s.files.size, 0);
});

test('revoked browser callers cannot get another PUT target for a pending upload', async t => {
  const { s } = await setup(t),
    input = archive(),
    browser = client(s).client;
  s.tables.projectContributors.set('grant', { projectId: 'project', contributor: 'contributor' });
  s.caller('contributor');
  globalThis.fetch = async () => {
    s.tables.projectContributors.clear();
    throw new DOMException('Upload aborted', 'AbortError');
  };
  await assert.rejects(uploadArchiveObjects(browser, 'project', input.file), { name: 'AbortError' });
  await assert.rejects(
    uploadArchiveObjects(browser, 'project', input.file),
    e => e.data?.code === 'PROJECT_UNAVAILABLE',
  );
  assert.equal(rows(s).length, 1);
  assert.equal(rows(s)[0].r2Committed, undefined);
  await assert.rejects(
    modules.projectObjectCommit.commitBatch._handler(s.ctx, { objects: [{ id: rows(s)[0]._id }] }),
    e => e.data?.code === 'PROJECT_UNAVAILABLE',
  );
});

test('browser backup import uses paged seed and resumes a committed page after a lost reply', async t => {
  const { s } = await setup(t);
  for (const name of ['projectHostedSeed', 'projectHostedSeedActions'])
    modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
  for (const table of ['projectHostedSeeds', 'projectHostedSeedPages', 'projectHostedChannels'])
    s.tables[table] ??= new Map();
  const { checkpoint } = await import('./project-exchange-fixture.mjs');
  const source = await checkpoint(t, s);
  const { exportNativeWork } = await import('../dist/native-backup.js');
  const { readFileSync } = await import('node:fs');
  const { result } = await exportNativeWork(source.store, source.store.revision(), true);
  const file = new File([readFileSync(result.archive.path)], 'synthetic-native.tar.gz');
  const { previewWorkArchive } = await import(moduleUrl('../web/src/work-archive.ts'));
  const preview = await previewWorkArchive(file);
  const browser = client(s).client;
  const { getFunctionName } = await import('convex/server');
  const action = browser.action;
  let lost = false,
    retiredCalls = 0;
  browser.action = async (ref, input) => {
    const name = getFunctionName(ref);
    if (name === 'projectExchangeActions:publish') retiredCalls++;
    const value = await action(ref, input);
    if (name === 'projectHostedSeedActions:stage' && !lost) {
      lost = true;
      throw Error('Synthetic lost page reply');
    }
    return value;
  };
  const seed = { operationId: randomUUID(), preview };
  await assert.rejects(uploadArchiveObjects(browser, 'project', file, seed), /Synthetic lost page reply/);
  const completed = await uploadArchiveObjects(browser, 'project', file, seed);
  assert(completed.backupId);
  const replay = await uploadArchiveObjects(browser, 'project', file, seed);
  assert.equal(replay.backupId, completed.backupId);
  assert.equal(s.tables.projectBackups.size, 1);
  assert.equal(s.tables.projectHostedSeeds.size, 1);
  assert.equal(JSON.parse([...s.tables.projectHostedChannels.values()][0].selection).head, preview.head);
  assert.equal(retiredCalls, 0);
});
