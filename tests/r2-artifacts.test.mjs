// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { backupFields } from './project-backup-fixture.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { setup, pinOf } from './r2-harness.mjs';
import { job } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { decodeHostedArtifact } from '../dist/hosted-artifact.js';
import { putR2 } from '../dist/exchange-blobs.js';
const { blobStore } = await import(moduleUrl('../convex/blobStore.ts'));
const { storeProjectArtifact } = await import(moduleUrl('../convex/projectArtifactActions.ts'));
const { rawContent } = await import(moduleUrl('../convex/projectObjectContent.ts'));
const indexer = await import(moduleUrl('../convex/indexer.ts'));
const remote = await import(moduleUrl('../convex/remote.ts'));
const { derivedArtifact, derivedBytes } = await import(moduleUrl('../convex/derivedArtifactActions.ts'));
const { default: worker } = await import(moduleUrl('../netlify/functions/analyze-background.mts'));
const artifactStorage = await import(moduleUrl('../convex/artifactStorage.ts'));

function github(t) {
  const previous = globalThis.fetch,
    remote = process.env.NETLIFY_WORKER_URL;
  delete process.env.NETLIFY_WORKER_URL;
  const bytes = Buffer.from('export const answer = 42;\n');
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  globalThis.fetch = async (url, init) => {
    const target = new URL(url);
    if (target.hostname !== 'api.github.com') return previous(url, init);
    if (target.pathname.includes('/commits/'))
      return Response.json({ sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } });
    if (target.pathname.includes('/git/trees/'))
      return Response.json({
        tree: [{ path: 'a.ts', mode: '100644', type: 'blob', sha, size: bytes.length }],
        truncated: false,
      });
    if (target.pathname.includes('/git/blobs/'))
      return init?.headers?.Accept === 'application/vnd.github.raw+json'
        ? new Response(bytes)
        : Response.json({ sha, content: bytes.toString('base64'), encoding: 'base64' });
    return Response.json({
      full_name: 'example/project',
      private: false,
      default_branch: 'main',
      html_url: 'https://github.com/example/project',
      license: null,
    });
  };
  t.after(() => {
    globalThis.fetch = previous;
    if (remote === undefined) delete process.env.NETLIFY_WORKER_URL;
    else process.env.NETLIFY_WORKER_URL = remote;
  });
  return bytes.toString();
}
function noConvexWrites(s) {
  s.ctx.storage.store = () => assert.fail('opted-in artifacts must not call Convex storage.store');
  s.ctx.storage.generateUploadUrl = () =>
    assert.fail('opted-in artifacts must not generate Convex upload URLs');
}
function indexed(s, optIn = true) {
  s.tables.imports.set('indexed', {
    ...job('indexed'),
    visibility: 'public',
    phase: 'fetching',
    artifactKey: undefined,
    r2Writes: optIn,
  });
}

test('server-built project artifacts go to R2 with or without the retired opt-in', async t => {
  for (const options of [{}, { optIn: false }]) {
    await t.test(JSON.stringify(options), async t => {
      const { s, fake } = await setup(t, options),
        bytes = Buffer.from('project artifact');
      noConvexWrites(s);
      await storeProjectArtifact(s.ctx, 'project', 'owner', bytes);
      const [row] = s.tables.projectObjects.values();
      assert.equal(row.location, 'r2');
      assert.equal(fake.objects.size, 1);
      assert.deepEqual(await rawContent(s.ctx, row, { sha256: row.digest, size: row.size }), bytes);
      await storeProjectArtifact(s.ctx, 'project', 'owner', bytes);
      assert.equal(s.tables.projectObjects.size, 1);
      assert.equal(fake.objects.size, 1);
    });
  }
});

test('a lost project-artifact commit reply retries one immutable R2 object', async t => {
  const { s, fake } = await setup(t),
    bytes = Buffer.from('one receipt');
  noConvexWrites(s);
  const mutation = s.ctx.runMutation;
  let lost = true;
  s.ctx.runMutation = async (ref, args) => {
    const result = await mutation(ref, args);
    if (lost && getFunctionName(ref) === 'projectExchangeCache:completeR2') {
      lost = false;
      throw Error('lost reply');
    }
    return result;
  };
  await assert.rejects(storeProjectArtifact(s.ctx, 'project', 'owner', bytes), /lost reply/);
  await storeProjectArtifact(s.ctx, 'project', 'owner', bytes);
  assert.equal(fake.objects.size, 1);
  assert.equal(fake.requests.filter(r => r.method === 'PUT').length, 1);
});

test('indexed imports store R2 gzip, reconcile a lost publication reply, and read without Convex bytes', async t => {
  const { s, fake } = await setup(t);
  indexed(s);
  const text = github(t);
  noConvexWrites(s);
  const mutation = s.ctx.runMutation;
  let lost = false;
  s.ctx.runMutation = async (ref, args) => {
    const result = await mutation(ref, args);
    if (!lost && getFunctionName(ref) === 'imports:update' && args.phase === 'ready') {
      lost = true;
      throw Error('lost publication');
    }
    return result;
  };
  await indexer.run._handler(s.ctx, { id: 'indexed', generation: 1 });
  const row = s.tables.imports.get('indexed');
  assert.equal(row.phase, 'ready');
  assert.match(row.artifactKey, /^r2blob:/);
  const artifact = await decodeHostedArtifact(await blobStore(s.ctx).get(row.artifactKey));
  assert.equal(artifact.content['a.ts'], text);
  const count = fake.objects.size;
  await indexer.run._handler(s.ctx, { id: 'indexed', generation: 1 });
  assert.equal(fake.objects.size, count);
  assert.equal(fake.requests.filter(r => r.method === 'PUT').length, 1);
  assert.equal(
    (await decodeHostedArtifact(await blobStore(s.ctx).get(row.artifactKey))).content['a.ts'],
    text,
  );
});

test('indexed imports and binary derivatives use R2 without the old flag or per-import opt-in', async t => {
  for (const options of [{}, { optIn: false }])
    await t.test(JSON.stringify(options), async t => {
      const { s, fake } = await setup(t, options);
      indexed(s, options.optIn !== false);
      github(t);
      await indexer.run._handler(s.ctx, { id: 'indexed', generation: 1 });
      const original = s.tables.imports.get('indexed').artifactKey;
      assert.match(original, /^r2blob:/);
      const record = await derivedArtifact(
        s.ctx,
        original,
        'export',
        '',
        async () => new Blob(['derived']),
        async () => {},
      );
      assert.equal(Buffer.from(await derivedBytes(s.ctx, record)).toString(), 'derived');
      assert.equal(fake.objects.size, 2);
      assert.equal(s.files.size, 0);
    });
});

test('hosted imports still fail explicitly when R2 is unconfigured', async t => {
  const { s } = await setup(t, { credentials: false });
  indexed(s, false);
  github(t);
  await indexer.run._handler(s.ctx, { id: 'indexed', generation: 1 });
  const row = s.tables.imports.get('indexed');
  assert.equal(row.phase, 'error');
  assert.match(row.error, /Object storage needs R2_ACCOUNT_ID/);
  assert.equal(s.files.size, 0);
});

test('R2 derivatives of legacy originals retry unknown storage outcomes and reject corrupt reads', async t => {
  const { s, fake } = await setup(t);
  s.file('old', new Blob(['original']));
  noConvexWrites(s);
  let build = 0,
    lost = true;
  const run = s.ctx.runAction;
  s.ctx.runAction = async (ref, args) => {
    const result = await run(ref, args);
    if (lost && getFunctionName(ref) === 'artifactStorage:commit') {
      lost = false;
      throw Error('lost storage reply');
    }
    return result;
  };
  const derive = () =>
    derivedArtifact(
      s.ctx,
      'old',
      'zone-export-v1',
      'pin',
      async () => {
        build++;
        return new Blob(['derived'], { type: 'application/gzip' });
      },
      async () => {},
      true,
    );
  await assert.rejects(derive(), /lost storage reply/);
  const record = await derive();
  assert.match(record.storageId, /^r2blob:/);
  assert.equal(Buffer.from(await derivedBytes(s.ctx, record)).toString(), 'derived');
  assert.equal(fake.objects.size, 1);
  assert.equal((await derive())._id, record._id);
  assert.equal(build, 2);
  const [key] = fake.objects.keys();
  fake.corrupt.add(key);
  await assert.rejects(derivedBytes(s.ctx, record), e => e.code === 'BLOB_DIGEST_MISMATCH');
});

test('remote import uploads directly and HEAD-verifies before publication; foreign refs fail', async t => {
  const { s, fake } = await setup(t);
  indexed(s);
  github(t);
  noConvexWrites(s);
  const job = s.tables.imports.get('indexed');
  job.remote = true;
  assert.equal((await remote.prepare._handler(s.ctx, { id: 'indexed', generation: 1 })).r2, true);
  const bytes = Buffer.from('remote artifact'),
    input = { id: 'indexed', generation: 1 };
  const upload = await remote.uploadTarget._handler(s.ctx, { ...input, ...pinOf(bytes) });
  await assert.rejects(
    remote.update._handler(s.ctx, {
      ...input,
      phase: 'ready',
      artifactKey: upload.ref,
      head: 'a'.repeat(40),
      analysisVersion: 'test',
    }),
    e => e.code === 'R2_OBJECT_MISSING',
  );
  const retryBytes = bytes;
  const retry = await remote.uploadTarget._handler(s.ctx, { ...input, ...pinOf(retryBytes) });
  assert.equal(retry.ref, upload.ref);
  await putR2(retry.target, retryBytes);
  const ready = {
    ...input,
    phase: 'ready',
    artifactKey: retry.ref,
    head: 'a'.repeat(40),
    analysisVersion: 'test',
  };
  assert.equal(await remote.update._handler(s.ctx, ready), true);
  assert.equal(await remote.update._handler(s.ctx, ready), true);
  assert.equal(
    Buffer.from(await (await blobStore(s.ctx).get(retry.ref)).arrayBuffer()).toString(),
    retryBytes.toString(),
  );
  assert.ok(fake.requests.some(r => r.method === 'HEAD'));
  job.generation = 2;
  job.phase = 'fetching';
  job.workerClaimed = true;
  const foreign = await blobStore(s.ctx).store(new Blob(['foreign']), { r2Namespace: 'v1/i/another/g/2' });
  await assert.rejects(
    remote.update._handler(s.ctx, { ...ready, generation: 2, artifactKey: foreign }),
    e => e.code === 'INVALID_ARTIFACT',
  );
  assert.ok(await blobStore(s.ctx).get(foreign));
});

test('explicit R2 cleanup deletes only its artifact and a late commit cannot revive it', async t => {
  const { s, fake } = await setup(t);
  noConvexWrites(s);
  const first = await blobStore(s.ctx).store(new Blob(['first']), { r2Namespace: 'v1/i/first/g/1' });
  const second = await blobStore(s.ctx).store(new Blob(['second']), { r2Namespace: 'v1/i/second/g/1' });
  await blobStore(s.ctx).delete(first);
  assert.equal(await blobStore(s.ctx).get(first), null);
  await artifactStorage.deleteBytes._handler(s.ctx, { ref: first });
  assert.equal(fake.objects.size, 1);
  assert.equal(await (await blobStore(s.ctx).get(second)).text(), 'second');
  await assert.rejects(
    artifactStorage.commit._handler(s.ctx, { ref: first }),
    e => e.code === 'INVALID_ARTIFACT',
  );
  await artifactStorage.deleteBytes._handler(s.ctx, { ref: first });
  assert.equal(fake.objects.size, 1);
});

test('artifact commit checks size and checksum', async t => {
  const { s, fake } = await setup(t);
  indexed(s, false);
  const pin = pinOf('expected');
  const row = await artifactStorage.reserve._handler(s.ctx, {
    namespace: 'v1/i/indexed/g/9',
    ...pin,
    contentType: 'text/plain',
  });
  fake.objects.set(fake.key(row.r2Key), Buffer.from('short'));
  const ref = `r2blob:${row._id}`;
  await assert.rejects(
    artifactStorage.commit._handler(s.ctx, { ref }),
    e => e.code === 'R2_OBJECT_SIZE_MISMATCH',
  );
  fake.objects.set(fake.key(row.r2Key), Buffer.from('mismatch'));
  await assert.rejects(
    artifactStorage.commit._handler(s.ctx, { ref }),
    e => e.code === 'R2_OBJECT_CHECKSUM_MISMATCH',
  );
  assert.equal(s.tables.artifactBlobs.get(row._id).committed, false);
});

test('the Netlify runner builds bytes locally and publishes an R2 artifact through metadata callbacks', async t => {
  const { s, fake } = await setup(t);
  indexed(s);
  const text = github(t);
  noConvexWrites(s);
  s.tables.imports.get('indexed').remote = true;
  const names = ['FORGE_WORKER_KEY', 'FORGE_CONVEX_SITE_URL'];
  const saved = names.map(name => process.env[name]);
  process.env.FORGE_WORKER_KEY = 'synthetic-worker';
  process.env.FORGE_CONVEX_SITE_URL = 'https://callbacks.invalid';
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = new URL(url);
    if (target.hostname !== 'callbacks.invalid') return previous(url, init);
    const operation = target.pathname.split('/').at(-1);
    const result = await remote[operation]._handler(s.ctx, JSON.parse(init.body));
    return Response.json(result);
  };
  t.after(() => {
    globalThis.fetch = previous;
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
  });
  const response = await worker(
    new Request('https://worker.invalid', {
      method: 'POST',
      headers: { Authorization: 'Bearer synthetic-worker' },
      body: JSON.stringify({ id: 'indexed', generation: 1 }),
    }),
  );
  assert.equal(response.status, 204);
  const job = s.tables.imports.get('indexed');
  assert.equal(job.phase, 'ready');
  assert.match(job.artifactKey, /^r2blob:/);
  assert.equal(
    (await decodeHostedArtifact(await blobStore(s.ctx).get(job.artifactKey))).content['a.ts'],
    text,
  );
  assert.equal(fake.objects.size, 1);
});

test('archive parts read migrated storage IDs and artifact references through their own resolvers', async t => {
  const { s, fake } = await setup(t);
  const { projectArchivePart } = await import(moduleUrl('../convex/projectArchivePart.ts'));
  const bytes = Buffer.from('R2 archive part');
  const ref = await blobStore(s.ctx).store(new Blob([bytes]), { r2Namespace: 'v1/p/project/artifacts' });
  assert.match(ref, /^r2blob:/);
  const artifact = s.tables.artifactBlobs.get(ref.slice(7)),
    storageId = await s.ctx.storage.store(new Blob([bytes]));
  await s.ctx.db.insert('projectBackups', {
    ...backupFields(),
    projectId: 'project',
    ...pinOf(bytes),
    storageId,
    status: 'stored',
    location: 'r2',
    r2Key: artifact.r2Key,
    r2Committed: true,
    r2ConvexPurged: true,
  });
  await s.ctx.storage.delete(storageId);
  s.ctx.storage.getMetadata = () => assert.fail('R2 archives must not read Convex metadata');
  s.ctx.storage.getUrl = () => assert.fail('R2 archives must not read Convex URLs');
  const query = s.ctx.runQuery,
    resolutions = [];
  s.ctx.runQuery = (fn, args) => {
    if (getFunctionName(fn) === 'r2ArchiveSource:resolve') {
      assert.equal(args.storageId, storageId, 'only the legacy ID reaches the storage-ID validator');
      assert.equal(args.actor, 'owner', 'legacy resolution retains the current actor');
      resolutions.push(args.storageId);
    }
    return query(fn, args);
  };
  let checks = 0;
  for (const id of [storageId, ref]) {
    const part = await projectArchivePart(s.ctx, id, bytes.length, pinOf(bytes).digest, 0, async () => {
      checks++;
    });
    assert.deepEqual(Buffer.from(part), bytes);
  }
  assert.deepEqual(resolutions, [storageId]);
  assert.equal(checks, 2);
  assert.equal(fake.requests.filter(request => request.method === 'GET').length, 2);
});
