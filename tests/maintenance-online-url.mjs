// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceWorkerReader } from '../dist/hosted-source-worker-reader.js';
import { sourceWorkerHttp } from '../dist/hosted-source-worker-http.js';
import { verifiedBytes } from '../dist/verified-blob.js';
import { actionsFixture } from './hosted-actions-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const { describeAndGrant } = await import(moduleUrl('../convex/projectHostedActionsReadBatch.ts'));

export async function replayUrlSwitch(t, { payload, pin, switchFile }) {
  const s = await actionsFixture([{ path: 'legacy.txt', bytes: payload }]);
  // Fixture document IDs have a table prefix and hyphen. The R2 pin uses a
  // synthetic namespace shaped like a deployed Convex project ID.
  const file = pin('legacy-actions-file', 'project');
  const row = [...s.tables.projectObjects.values()].find(row => row.digest === file.digest);
  assert(row, 'the selected source has a stored project binding');
  s.patch('projectObjects', row._id, {
    storageId: file.storageId,
    location: undefined,
    r2Committed: undefined,
    r2Key: undefined,
    sourceReferenced: true,
  });
  const nativeUrl = `https://native.invalid/${file.storageId}`;
  let native = true,
    copy = payload;
  s.extendContext(ctx => {
    ctx.storage = {
      getUrl: async id => (native && id === file.storageId ? nativeUrl : null),
      async delete(id) {
        assert.equal(id, file.storageId);
        native = false;
      },
    };
  });
  const executionId = randomUUID();
  const claim = await s.store.control({ kind: 'claim', owner: executionId });
  const { transport } = sourceWorkerHttp({
    endpoint: 'https://control.invalid/',
    token: 'synthetic',
    executionId,
    input: {
      kind: 'forge-hosted-actions',
      runId: s.input.id,
      dispatchKey: s.input.dispatchKey,
      owner: executionId,
      token: claim.mapping.lease.token,
    },
    timeoutMs: 1000,
    fetch: async (target, init) => {
      const url = new URL(target);
      if (url.origin === 'https://control.invalid') {
        assert.equal(url.pathname, '/describe-and-grant');
        const request = JSON.parse(init.body);
        return new Response(
          await s.transaction('legacyActionsRead', describeAndGrant, {
            projectId: s.projectId,
            ...request,
            input: JSON.stringify(request.input),
          }),
        );
      }
      if (url.href === nativeUrl) return native ? new Response(payload) : new Response(null, { status: 404 });
      assert.equal(url.origin, 'https://synthetic.r2.cloudflarestorage.com');
      assert.equal(url.pathname, '/synthetic/' + file.copyKey);
      assert.match(url.searchParams.get('X-Amz-Signature'), /^[a-f0-9]{64}$/);
      return new Response(copy);
    },
  });
  const logs = t.mock.method(console, 'info', () => {});
  const [original] = await transport.describeAndRead([file.digest]);
  const healthy = s.counts.at(-1);
  assert(!healthy.touched.includes('legacyStorageTombstones'));
  assert.equal(healthy.writes, 0);
  assert.equal(logs.mock.callCount(), 0);
  assert.deepEqual(Buffer.concat(await Array.fromAsync(await original.read())), payload);

  assert(await s.run('legacyActionsSwitch', ctx => switchFile(ctx, file, copy), {}));
  await assert.rejects(original.read(), { code: 'SOURCE_WORKER_UNAVAILABLE' });
  const directory = await mkdtemp(join(tmpdir(), 'forge-legacy-url-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reader = new SourceWorkerReader(directory, transport);
  await reader.resolve(file.digest);
  const recovered = s.counts.at(-1);
  assert.equal(recovered.ranges, healthy.ranges + 1);
  assert.equal(recovered.documents, healthy.documents + 1);
  assert.equal(recovered.writes, healthy.writes);
  assert.deepEqual(await readFile(join(directory, file.digest)), payload);

  copy = Buffer.alloc(file.size, 1);
  const [corrupt] = await transport.describeAndRead([file.digest]);
  await assert.rejects(
    async () => verifiedBytes(Buffer.concat(await Array.fromAsync(await corrupt.read())), file.digest),
    { code: 'BLOB_DIGEST_MISMATCH' },
  );
  const freshDirectory = await mkdtemp(join(tmpdir(), 'forge-legacy-url-corrupt-'));
  t.after(() => rm(freshDirectory, { recursive: true, force: true }));
  const freshReader = new SourceWorkerReader(freshDirectory, transport);
  await assert.rejects(freshReader.resolve(file.digest), { code: 'SOURCE_HASH_MISMATCH' });
  await assert.rejects(readFile(join(freshDirectory, file.digest)), { code: 'ENOENT' });
}
