import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../scripts/child-env.mjs';
import { makeFunctionReference } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { pagedFixture } from './github-import-pages-fixture.mjs';
import { streamGithubSourceBlob, githubBlobEndpointBytes } from '../dist/github-project-source.js';
import { ObjectRecipeBuilder } from '../dist/object-chunks.js';
import { importPageBytes } from '../dist/github-import-pages.js';
const { ImportUpload } = await import(moduleUrl('../convex/projectGithubImportUpload.ts'));

test('100 MiB acquisition streams bounded physical windows with memory margin', async t => {
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('./github-import-stream-memory.mjs', import.meta.url)),
        moduleUrl('../convex/projectGithubImportUpload.ts'),
      ],
      { encoding: 'utf8', env: childEnv() },
    ),
  );
  assert.equal(result.logicalBytes, githubBlobEndpointBytes);
  assert.ok(result.peakBufferedBytes <= importPageBytes + 1024 * 1024, String(result.peakBufferedBytes));
  assert.ok(
    result.peakProcessRss < 384 * 1024 * 1024,
    `Streaming process RSS ${result.peakProcessRss} exceeds the 384 MiB margin target`,
  );
  t.diagnostic(JSON.stringify(result));
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
