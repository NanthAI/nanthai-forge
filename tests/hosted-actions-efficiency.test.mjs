// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceWorkerReader } from '../dist/hosted-source-worker-reader.js';
import { buildObjectRecipe } from '../dist/object-chunks.js';
import { performance } from 'node:perf_hooks';
import { getFunctionName } from 'convex/server';
import { actionsFixture } from './hosted-actions-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { exportHostedActions } from '../dist/hosted-actions-export.js';
import { sourceWorkerHttp } from '../dist/hosted-source-worker-http.js';
import { digest } from '../dist/hash.js';
import { code } from './hosted-checks-fixture.mjs';
const batch = await import(moduleUrl('../convex/projectHostedActionsReadBatch.ts'));
const transfers = await import(moduleUrl('../convex/projectHostedActionsTransfers.ts'));

function environment(t) {
  const env = {
    FORGE_BLOBS: 'r2',
    R2_ACCOUNT_ID: 'synthetic',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
  };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [k, value] of Object.entries(saved))
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
  });
}
async function selected(s) {
  const owner = randomUUID(),
    claim = await s.store.control({ kind: 'claim', owner });
  return {
    projectId: s.projectId,
    executionId: owner,
    input: JSON.stringify({
      kind: 'forge-hosted-actions',
      runId: s.input.id,
      dispatchKey: s.input.dispatchKey,
      owner,
      token: claim.mapping.lease.token,
    }),
  };
}

test('3000-file export uses bounded job-authorized source windows and streams actual Git bytes', async t => {
  environment(t);
  const files = Array.from({ length: 3000 }, (_, i) => ({ path: `src/${i}.txt`, bytes: `synthetic ${i}\n` }));
  // Repeated hashes exercise deduplication before either describing or reading.
  files.push(...Array.from({ length: 100 }, (_, i) => ({ path: `shared/${i}`, bytes: files[i].bytes })));
  const s = await actionsFixture(files);
  s.patch('hostedProjects', s.projectId, { r2Writes: true });
  // Execute the retained per-file resolver through a single-object fake control
  // transport to measure the old describe+grant boundary without another Git export.
  let beforeSourceControlCalls = 0;
  const baselineRoot = await mkdtemp(join(tmpdir(), 'forge-e1-baseline-'));
  try {
    const legacy = new SourceWorkerReader(baselineRoot, {
      ...s.transport,
      describe: async sha256 => {
        beforeSourceControlCalls++;
        return s.transport.describe(sha256);
      },
      read: async pin => {
        beforeSourceControlCalls++;
        return s.transport.read(pin);
      },
    });
    await legacy.resolve(s.input.request.expectedHead);
    await legacy.json(s.input.plan.manifest);
    await legacy.json(s.input.plan.selection);
    for (const file of files) await legacy.resolve(digest(file.bytes));
  } finally {
    await rm(baselineRoot, { recursive: true, force: true });
  }
  // The single-object fallback skips repeats this job already verified (3,000 × describe+read + 4).
  assert.equal(beforeSourceControlCalls, 6004);
  s.advance(Date.now() - s.now());
  const args = await selected(s);
  let lastHeartbeat = Date.now(),
    heartbeatCalls = 0;
  const windows = [],
    start = performance.now(),
    baseline = s.counts.length;
  let peakRss = process.memoryUsage().rss,
    controlCalls = 0;
  const transport = {
    ...s.transport,
    async describeAndRead(sha256s) {
      controlCalls++;
      windows.push(sha256s);
      const result = JSON.parse(
        await s.transaction('sourceReadBatch', batch.describeAndGrant, { ...args, sha256s }),
      );
      return result.map(({ descriptor, target }) => {
        assert.equal(new URL(target.url).protocol, 'https:');
        return { descriptor, read: () => s.transport.read(descriptor.object) };
      });
    },
    async describe() {
      throw Error('per-object describe');
    },
    // Exercise the actual upload entrypoints and nested HEAD/commit mutations.
    async upload(pin, bytes) {
      const upload = { ...args, pin };
      controlCalls++;
      await s.transaction('sourceUploadGrant', transfers.grant, { ...upload, action: 'upload' });
      await s.transport.upload(pin, bytes);
      controlCalls++;
      await transfers.commit._handler(
        {
          runMutation: async (ref, input) => {
            controlCalls++;
            const name = getFunctionName(ref).split(':').at(-1);
            return s.transaction(`sourceUpload${name}`, transfers[name], input);
          },
        },
        upload,
      );
    },
  };
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.method, 'HEAD');
    const object = [...s.tables.projectObjects.values()].find(row => !row.r2Committed);
    assert(object);
    return new Response(null, {
      headers: {
        'content-length': String(object.size),
        'x-amz-checksum-sha256': Buffer.from(object.digest, 'hex').toString('base64'),
      },
    });
  });
  const result = await exportHostedActions(s.input, transport, async () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    // Match HostedActionsProvider's existing progress heartbeat. This fixture
    // measures real wall time under contention without expiring its live worker.
    if (Date.now() - lastHeartbeat >= 30_000) {
      s.advance(Date.now() - s.now());
      await s.store.control({
        kind: 'heartbeat',
        owner: args.executionId,
        token: JSON.parse(args.input).token,
      });
      heartbeatCalls++;
      lastHeartbeat = Date.now();
    }
  });
  assert.equal(result.metrics.sourceFiles, 3100);
  assert.equal(windows.length, 31);
  assert(windows.every(window => window.length <= 100 && new Set(window).size === window.length));
  assert.equal(new Set(windows.flat()).size, 3003);
  assert(controlCalls <= 40);
  assert(result.metrics.maxChunkBytes <= 8192);
  assert(
    peakRss < 512 * 1024 * 1024,
    'export stays below 512 MiB including synthetic fixture and Git parent',
  );
  const measured = s.counts.slice(baseline);
  t.diagnostic(
    JSON.stringify({
      files: files.length,
      uniqueSourceFiles: 3000,
      beforeSourceControlCalls,
      afterSourceControlCalls: windows.length,
      afterControlCalls: controlCalls,
      heartbeatCalls,
      windows: windows.length,
      documents: measured.reduce((n, c) => n + c.documents, 0),
      writes: measured.reduce((n, c) => n + c.writes, 0),
      maxWindowDocuments: Math.max(...measured.map(c => c.documents)),
      peakRss,
      wallMs: Math.round(performance.now() - start),
      metrics: result.metrics,
    }),
  );
});

test('batch source ingress keeps exact ordering, fresh lease/epoch checks and cached-byte revocation', async t => {
  environment(t);
  const s = await actionsFixture([
    { path: 'a', bytes: 'a' },
    { path: 'b', bytes: 'b' },
  ]);
  const args = await selected(s),
    hashes = [digest('a'), digest('b')];
  const call = sha256s => s.transaction('readBatch', batch.describeAndGrant, { ...args, sha256s });
  assert.equal(JSON.parse(await call(hashes))[0].descriptor.object.sha256, hashes[0]);
  for (const sha256s of [[], Array(101).fill(hashes[0]), [hashes[0], hashes[0]], ['invalid']])
    await assert.rejects(call(sha256s), code('BAD_ARGUMENT'));
  await assert.rejects(call([digest('foreign')]), code('SOURCE_UNAVAILABLE'));
  const http = sourceWorkerHttp({
    endpoint: 'https://synthetic-control.invalid/',
    token: 'synthetic',
    executionId: args.executionId,
    input: JSON.parse(args.input),
    timeoutMs: 1000,
    fetch: async (url, init) => {
      assert.equal(new URL(url).pathname, '/describe-and-grant');
      const body = JSON.parse(init.body);
      return new Response(await call(body.sha256s));
    },
  });
  const window = await http.transport.describeAndRead(hashes);
  assert.deepEqual(
    window.map(entry => entry.descriptor.object.sha256),
    hashes,
  );
  assert(window.every(entry => typeof entry.read === 'function'));
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(http.transport.describeAndRead(hashes), code('SOURCE_AUTHORITY_CHANGED'));
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 1 } });
  const row = [...s.tables.projectHostedActionsExports.values()][0],
    mapping = JSON.parse(row.value);
  mapping.lease.until = 0;
  s.patch('projectHostedActionsExports', row._id, { value: JSON.stringify(mapping) });
  await assert.rejects(call(hashes), code('SOURCE_JOB_FENCED'));
});

test('recipe windows preserve verified leaves, exact hashes and fresh authority over cached files', async t => {
  environment(t);
  const bytes = Buffer.alloc(3 * 1024 * 1024, 8),
    built = buildObjectRecipe(bytes);
  const s = await actionsFixture([{ path: 'recipe', bytes }]),
    args = await selected(s);
  for (const content of built.objects.values()) s.put(content);
  const recipe = s.put(built.bytes),
    hash = digest(bytes);
  const object = [...s.tables.projectObjects.values()].find(row => row.digest === hash);
  s.patch('projectObjects', object._id, { recipe: { digest: recipe.sha256, size: recipe.size } });
  const root = await mkdtemp(join(tmpdir(), 'forge-e1-recipe-'));
  try {
    const reader = new SourceWorkerReader(root, {
      ...s.transport,
      describeAndRead: async sha256s => {
        const entries = JSON.parse(
          await s.transaction('recipeReadBatch', batch.describeAndGrant, { ...args, sha256s }),
        );
        return entries.map(({ descriptor, target }) => {
          assert.equal(target, null);
          return { descriptor, read: null };
        });
      },
      read: async pin => {
        await s.transaction('recipeLeafGrant', transfers.grant, { ...args, pin, action: 'read' });
        return s.transport.read(pin);
      },
    });
    await reader.resolveMany([hash, hash]);
    assert.deepEqual(await readFile(join(root, hash)), bytes);
    const reads = s.metrics.reads;
    await reader.resolveMany([hash]);
    assert.equal(s.metrics.reads, reads, 'byte cache avoids another recipe download');
    s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
    await assert.rejects(reader.resolveMany([hash]), code('SOURCE_AUTHORITY_CHANGED'));
    assert.equal(s.metrics.reads, reads, 'cached bytes do not bypass current batch authorization');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
