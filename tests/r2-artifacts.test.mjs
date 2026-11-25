// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import { backupFields } from './project-backup-fixture.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { setup, pinOf } from './r2-harness.mjs';
import { job } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { decodeHostedArtifact } from '../dist/hosted-artifact.js';
import { hostedQuery } from '../dist/hosted-query.js';
const { blobStore } = await import(moduleUrl('../convex/blobStore.ts'));
const { storeProjectArtifact } = await import(moduleUrl('../convex/projectArtifactActions.ts'));
const { rawContent } = await import(moduleUrl('../convex/projectObjectContent.ts'));
const indexer = await import(moduleUrl('../convex/indexer.ts'));
const { derivedArtifact, derivedBytes } = await import(moduleUrl('../convex/derivedArtifactActions.ts'));
const artifactStorage = await import(moduleUrl('../convex/artifactStorage.ts'));

function github(t, files = { 'a.ts': 'export const answer = 42;\n' }, requests = []) {
  const previous = globalThis.fetch;
  const blobs = new Map(),
    tree = Object.entries(files).map(([path, text]) => {
      const bytes = Buffer.from(text);
      const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      blobs.set(sha, bytes);
      return { path, mode: '100644', type: 'blob', sha, size: bytes.length };
    });
  globalThis.fetch = async (url, init) => {
    const target = new URL(url);
    if (target.hostname !== 'api.github.com') return previous(url, init);
    requests.push(target.pathname);
    if (target.pathname.includes('/commits/'))
      return Response.json({ sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } });
    if (target.pathname.includes('/git/trees/')) return Response.json({ tree, truncated: false });
    if (target.pathname.includes('/git/blobs/')) {
      const sha = target.pathname.split('/').at(-1),
        bytes = blobs.get(sha);
      return init?.headers?.Accept === 'application/vnd.github.raw+json'
        ? new Response(bytes)
        : Response.json({ sha, content: bytes.toString('base64'), encoding: 'base64' });
    }
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
  });
  return files['a.ts'];
}
function noConvexWrites(s) {
  s.ctx.storage.store = () => assert.fail('opted-in artifacts must not call Convex storage.store');
  s.ctx.storage.generateUploadUrl = () =>
    assert.fail('opted-in artifacts must not generate Convex upload URLs');
}
function indexed(s) {
  s.tables.imports.set('indexed', {
    ...job('indexed'),
    visibility: 'public',
    phase: 'fetching',
    artifactKey: undefined,
  });
}

test('server-built project artifacts go to R2', async t => {
  const { s, fake } = await setup(t),
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

test('a Go and C# import lists fetched text without adding downloads, R2 reads or Convex calls', async t => {
  const { s, fake } = await setup(t);
  indexed(s);
  const requests = [];
  github(
    t,
    {
      '.gitignore': 'ignored.md\n',
      'main.go': 'package main\n\nfunc main() {}\n',
      'go.mod': 'module example.com/project\n',
      'App.cs': 'namespace App;\npublic class Program {}\n',
      'README.md': '# Project\n🦎',
      'docs/guide.md': '# Guide\n',
      LICENSE: 'Synthetic license',
      NOTICE: 'Synthetic attribution',
      'logo.png': 'binary by name',
      'ignored.md': 'ignored text',
      Makefile: 'not fetched by analysis imports',
    },
    requests,
  );
  const calls = {};
  for (const method of ['runQuery', 'runMutation', 'runAction']) {
    const run = s.ctx[method];
    calls[method] = 0;
    s.ctx[method] = (...args) => {
      calls[method]++;
      return run(...args);
    };
  }
  await indexer.run._handler(s.ctx, { id: 'indexed', generation: 1 });
  const row = s.tables.imports.get('indexed');
  assert.equal(row.phase, 'ready');
  assert.deepEqual(calls, { runQuery: 6, runMutation: 7, runAction: 1 });
  assert.equal(requests.length, 12);
  const downloads = requests.filter(path => path.includes('/git/blobs/'));
  assert.equal(downloads.length, 8);
  assert.equal(new Set(downloads).size, 8);
  assert.equal(fake.requests.filter(r => r.method === 'GET').length, 0);
  assert.equal(s.scheduled.length, 0);
  const artifact = await decodeHostedArtifact(await blobStore(s.ctx).get(row.artifactKey));
  const files = hostedQuery(artifact, 'files', row.head).results;
  assert.deepEqual(files.map(file => file.path).sort(), [
    '.gitignore',
    'App.cs',
    'LICENSE',
    'NOTICE',
    'README.md',
    'docs/guide.md',
    'go.mod',
    'main.go',
  ]);
  const declaration = hostedQuery(artifact, 'declarations?file=README.md', row.head).results[0];
  assert.equal(declaration.kind, 'File');
  assert.deepEqual(declaration.locator.end, { offset: 12, line: 2, column: 3 });
  assert.deepEqual(
    artifact.pack.nodes
      .filter(node => node.kind === 'File')
      .map(node => node.locator.file)
      .sort(),
    ['.gitignore', 'LICENSE', 'NOTICE', 'README.md', 'docs/guide.md', 'go.mod'],
  );
  assert.equal(artifact.content['README.md'], undefined);
  assert.equal(artifact.documents['README.md'], '# Project\n🦎');
});

test('indexed imports and binary derivatives use R2', async t => {
  const { s, fake } = await setup(t);
  indexed(s);
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

test('hosted imports still fail explicitly when R2 is unconfigured', async t => {
  const { s } = await setup(t, { credentials: false });
  indexed(s);
  github(t);
  await indexer.run._handler(s.ctx, { id: 'indexed', generation: 1 });
  const row = s.tables.imports.get('indexed');
  assert.equal(row.phase, 'error');
  assert.match(row.error, /Object storage needs R2_ACCOUNT_ID/);
  assert.equal(s.files.size, 0);
});

test('R2 derivatives of an R2 original retry unknown storage outcomes and reject corrupt reads', async t => {
  const { s, fake } = await setup(t);
  const old = await blobStore(s.ctx).store(new Blob(['original']), { r2Namespace: 'v1/i/own/g/1' });
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
      old,
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
  assert.equal(fake.objects.size, 2, 'the original and one derivative');
  assert.equal((await derive())._id, record._id);
  assert.equal(build, 2);
  fake.corrupt.add([...fake.objects.keys()].at(-1));
  await assert.rejects(derivedBytes(s.ctx, record), e => e.code === 'BLOB_DIGEST_MISMATCH');
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
  indexed(s);
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
