import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeFunctionReference } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { pagedFixture } from './github-import-pages-fixture.mjs';
import { streamGithubSourceBlob, githubBlobEndpointBytes } from '../dist/github-project-source.js';
import { ObjectRecipeBuilder } from '../dist/object-chunks.js';
import { importPageBytes } from '../dist/github-import-pages.js';
const { ImportUpload } = await import(moduleUrl('../convex/projectGithubImportUpload.ts'));

test('100 MiB acquisition streams bounded physical windows with memory margin', async t => {
  const s = pagedFixture();
  const projectId = await s.ctx.db.insert('hostedProjects', {
    owner: 'owner',
    key: 'stream',
    name: 'stream',
    currentBackup: null,
    revision: 0,
  });
  // Model an external durable byte sink, rather than retaining an artificial
  // whole database of bytes inside the action's process.
  const store = s.ctx.storage.store;
  s.ctx.storage.store = async blob => {
    const id = await store(blob);
    s.files.get(id).blob = new Blob();
    return id;
  };
  const size = githubBlobEndpointBytes,
    blockSize = 64 * 1024;
  const block = index => {
    const seed = createHash('sha256').update(String(index)).digest();
    const value = Buffer.allocUnsafe(blockSize);
    for (let offset = 0; offset < value.length; offset += seed.length) seed.copy(value, offset);
    return value;
  };
  const git = createHash('sha1').update(`blob ${size}\0`),
    logical = createHash('sha256');
  for (let i = 0; i < size / blockSize; i++) {
    const bytes = block(i);
    git.update(bytes);
    logical.update(bytes);
  }
  const expected = logical.digest('hex'),
    upload = new ImportUpload(s.ctx, projectId, 'owner');
  const builder = new ObjectRecipeBuilder(upload.put);
  let index = 0,
    peakRss = process.memoryUsage().rss;
  const pin = await streamGithubSourceBlob(
    'fixture/stream',
    { path: 'large.bin', sha: git.digest('hex'), size, mode: '100644' },
    async bytes => {
      builder.update(bytes);
      await upload.drain();
      await upload.commit();
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    },
    undefined,
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (index * blockSize >= size) controller.close();
            else controller.enqueue(block(index++));
          },
        }),
      ),
  );
  assert.equal(pin.blob, expected);
  assert.equal(pin.size, size);
  upload.recipe(pin, builder.finish({ sha256: pin.blob, size }).bytes);
  await upload.drain(true);
  await upload.commit();
  const row = [...s.tables.projectObjects.values()].find(row => row.digest === expected);
  assert.ok(row.recipe);
  assert.equal(row.storageId, undefined);
  assert.ok(upload.peakBufferedBytes <= importPageBytes + 1024 * 1024, String(upload.peakBufferedBytes));
  assert.ok(
    peakRss < 384 * 1024 * 1024,
    `Streaming process RSS ${peakRss} exceeds the local 384 MiB margin target`,
  );
  t.diagnostic(
    JSON.stringify({
      logicalBytes: size,
      peakBufferedBytes: upload.peakBufferedBytes,
      peakProcessRss: peakRss,
      physicalObjects: s.tables.projectObjects.size,
      executions: [...s.calls.values()].reduce((a, b) => a + b, 0),
    }),
  );
});

test('batched completion rejects changed bytes and current access is rechecked', async () => {
  const s = pagedFixture(),
    projectId = await s.ctx.db.insert('hostedProjects', {
      owner: 'owner',
      key: 'negative',
      name: 'negative',
      currentBackup: null,
      revision: 0,
    });
  const digest = createHash('sha256').update('expected').digest('hex');
  const [pin] = await s.ctx.runMutation(makeFunctionReference('projectGithubImportBatch:prepare'), {
    projectId,
    actor: 'owner',
    objects: [{ digest, size: 8 }],
  });
  const storageId = await s.ctx.storage.store(new Blob(['changed!'], { type: pin.contentType }));
  await assert.rejects(
    s.ctx.runMutation(makeFunctionReference('projectGithubImportBatch:complete'), {
      projectId,
      actor: 'owner',
      objects: [{ id: pin.id, storageId }],
      recipes: [],
    }),
    e => e.code === 'INVALID_WORK_BACKUP',
  );
  await assert.rejects(
    s.ctx.runMutation(makeFunctionReference('projectGithubImportBatch:prepare'), {
      projectId,
      actor: 'outsider',
      objects: [{ digest, size: 8 }],
    }),
    e => e.code === 'PROJECT_UNAVAILABLE',
  );
  assert.equal(s.tables.projectObjects.get(pin.id).storageId, undefined);
});

test('multiple chunked files share one byte window before recipes bind atomically', async () => {
  const s = pagedFixture(),
    projectId = await s.ctx.db.insert('hostedProjects', {
      owner: 'owner',
      key: 'mixed',
      name: 'mixed',
      currentBackup: null,
      revision: 0,
    });
  const upload = new ImportUpload(s.ctx, projectId, 'owner');
  for (let index = 0; index < 3; index++) {
    const bytes = Buffer.alloc(2 * 1024 * 1024, index),
      builder = new ObjectRecipeBuilder(upload.put);
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      builder.update(bytes.subarray(offset, offset + 65536));
      if (await upload.drain()) await upload.commit();
    }
    const blob = createHash('sha256').update(bytes).digest('hex');
    upload.recipe({ blob, size: bytes.length }, builder.finish({ sha256: blob, size: bytes.length }).bytes);
  }
  await upload.drain(true);
  await upload.commit();
  assert.equal([...s.tables.projectObjects.values()].filter(row => row.recipe).length, 3);
});

test('gitlinks use the page stream sink as SHA metadata without a GitHub fetch', async () => {
  for (const sha of ['a'.repeat(40), 'b'.repeat(64)]) {
    const parts = [];
    const pin = await streamGithubSourceBlob(
      'fixture/repo',
      { path: 'vendor/lib', sha, size: 0, mode: '160000' },
      async bytes => {
        parts.push(bytes);
      },
      undefined,
      async () => assert.fail('never request third-party submodule content'),
    );
    assert.equal(Buffer.concat(parts).toString(), sha);
    assert.deepEqual(pin, { blob: createHash('sha256').update(sha).digest('hex'), size: sha.length });
    await assert.rejects(
      streamGithubSourceBlob(
        'fixture/repo',
        { path: 'vendor/lib', sha, size: 0, mode: '160000' },
        async () => {
          throw Error('sink interrupted');
        },
        undefined,
        async () => assert.fail('no fetch'),
      ),
      /sink interrupted/,
    );
  }
});
