// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { initialSourceStep } from '../dist/hosted-source-step.js';
import { saveSourceProgress, loadSourceProgress } from '../dist/hosted-source-step-progress.js';
import { storeTaskData, loadTaskData } from '../dist/hosted-source-task-data.js';
const { sourceStorage, sourceR2Pin } = await import(moduleUrl('../convex/projectConvexSourceStorage.ts'));
const { convexSourceTransport } = await import(moduleUrl('../convex/projectConvexSource.ts'));
const { storeSourceOutputs } = await import(moduleUrl('../convex/projectConvexSourceOutput.ts'));

import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';

const forbiddenStorage = {
  store() {
    assert.fail('hot path called Convex storage.store in R2 mode');
  },
  get() {
    assert.fail('R2 reference read Convex bytes');
  },
  getMetadata() {
    assert.fail('R2 output read Convex metadata');
  },
};

test('R2 source outputs, cursor sections and fanout progress use zero Convex byte stores', async t => {
  const r2 = fakeSourceR2(t),
    ctx = { storage: forbiddenStorage },
    storage = sourceStorage(ctx, 'project');
  const cursor = initialSourceStep({ sha256: 'a'.repeat(64), size: 0 });
  cursor.files = Array.from({ length: 3000 }, (_, i) => ({
    path: `file-${i}`,
    blob: 'a'.repeat(64),
    mode: 'file',
  }));
  const saved = await saveSourceProgress(cursor, null, storage.store);
  assert(sourceR2Pin(saved.id));
  assert(Object.values(saved.value.sections).every(section => sourceR2Pin(section.id)));
  const loaded = await loadSourceProgress(await storage.read(saved.id), storage.read);
  assert.deepEqual(loaded.cursor, cursor);
  const ref = await storeTaskData(
    {
      index: 3000,
      verify: null,
      states: Array.from({ length: 3000 }, (_, i) => ({
        id: String(i).padStart(64, '0'),
        parents: [],
        files: [],
        error: null,
      })),
    },
    storage.store,
  );
  assert(sourceR2Pin(ref.id));
  assert.equal((await loadTaskData(ref, storage.read)).states.length, 3000);
  const bytes = Buffer.from('retry bytes');
  r2.hooks.lostPut = true;
  await assert.rejects(storage.store(bytes), { name: 'SourceIoError', stage: 'source-put' });
  const replay = await storage.store(bytes);
  assert.deepEqual(Buffer.from(await storage.read(replay)), bytes);
  r2.hooks.mismatch = true;
  await assert.rejects(storage.store(Buffer.from('bad HEAD')), e => e.code === 'R2_VERIFY_FAILED');
  await assert.rejects(storage.read('r2source:invalid'), e => e.code === 'SOURCE_HASH_MISMATCH');
});

test('3000 source outputs keep RPCs at one stage per 100 objects and prefer R2 over fallback bytes', async t => {
  const r2 = fakeSourceR2(t),
    calls = [],
    rows = new Map();
  const ctx = {
    storage: forbiddenStorage,
    db: {
      query(table) {
        let id;
        return {
          withIndex(_name, fn) {
            const q = {
              eq(k, v) {
                if (k === 'digest') id = v;
                return q;
              },
              lte: () => q,
            };
            fn(q);
            return this;
          },
          order() {
            return this;
          },
          // No GitHub-import object catalog in this fixture.
          async take() {
            assert.equal(table, 'projectObjectCatalog');
            return [];
          },
          async unique() {
            return rows.get(id) ?? null;
          },
        };
      },
      async insert(table, row) {
        if (table === 'projectObjects') rows.set(row.digest, { ...row, _id: row.digest });
      },
      async patch(id, patch) {
        rows.set(id, { ...rows.get(id), ...patch });
      },
    },
    async runMutation(ref, input) {
      assert.equal(getFunctionName(ref), 'projectConvexSourceStore:stage');
      calls.push(input.objects.length);
      await storeSourceOutputs(ctx, input.projectId, 'execution', input.objects);
    },
  };
  const { io, outputs } = convexSourceTransport(ctx, { projectId: 'project', jobId: 'job', step: 0 });
  const before = process.memoryUsage().rss,
    started = performance.now();
  for (let offset = 0; offset < 3000; offset += 100) {
    const objects = Array.from({ length: 100 }, (_, i) => {
      const bytes = Buffer.from(`synthetic-${offset + i}`),
        pin = { sha256: digest(bytes), size: bytes.length };
      return {
        pin,
        bytes: (async function* () {
          yield bytes;
        })(),
      };
    });
    await io.uploadBatch(objects);
  }
  assert.equal(outputs.length, 0);
  assert.equal(calls.length, 30);
  assert(calls.every(count => count === 100));
  assert.equal(rows.size, 3000);
  assert([...rows.values()].every(row => row.location === 'r2' && row.r2Committed && !row.storageId));
  const row = [...rows.values()][0],
    bytes = r2.objects.get(`/synthetic/${row.r2Key}`);
  const target = await sourceStorage(ctx, 'project').store(bytes);
  const signed = new URL(`https://synthetic.r2.cloudflarestorage.com/synthetic/${row.r2Key}`);
  const reading = convexSourceTransport(ctx, { projectId: 'project', jobId: 'job', step: 0 }, [
    {
      descriptor: { object: { sha256: row.digest, size: row.size }, recipe: null },
      storageId: 'retained-fallback',
      url: signed.href,
    },
  ]);
  let read = Buffer.alloc(0);
  for await (const part of await reading.io.read({ sha256: row.digest, size: row.size }))
    read = Buffer.concat([read, part]);
  assert.deepEqual(read, bytes);
  assert(sourceR2Pin(target));
  await assert.rejects(
    storeSourceOutputs(ctx, 'project', 'execution', [
      { sha256: row.digest, size: row.size, r2Key: `v1/p/other/o/${row.digest}` },
    ]),
    e => e.code === 'SOURCE_HASH_MISMATCH',
  );
  t.diagnostic(
    JSON.stringify({
      objects: 3000,
      convexCalls: calls.length,
      rows: rows.size,
      r2Puts: r2.requests.filter(x => x === 'PUT').length,
      wallMs: Math.round(performance.now() - started),
      rssGrowth: process.memoryUsage().rss - before,
    }),
  );
});

for (const mode of ['network', 429, 503]) {
  test(`source HEAD ${mode} is repairable while a verified mismatch stays deterministic`, async t => {
    fakeSourceR2(t);
    const storage = sourceStorage({ storage: forbiddenStorage }, 'project');
    const serve = globalThis.fetch;
    let failing = true;
    t.mock.method(globalThis, 'fetch', (url, init) => {
      if (failing && init?.method === 'HEAD') {
        if (mode === 'network') throw new TypeError('synthetic connection reset');
        return new Response(null, { status: mode });
      }
      return serve(url, init);
    });
    const bytes = Buffer.from('stable output');
    await assert.rejects(
      storage.store(bytes),
      error => error.name === 'SourceIoError' && error.stage === 'source-head' && !('data' in error),
    );
    failing = false;
    const replay = await storage.store(bytes);
    assert.deepEqual(Buffer.from(await storage.read(replay)), bytes);
  });
}

test('durable section reads escape unchanged, while corrupt compressed/JSON bytes retain exact hash errors', async t => {
  fakeSourceR2(t);
  const storage = sourceStorage({ storage: forbiddenStorage }, 'project');
  const cursor = initialSourceStep({ sha256: 'a'.repeat(64), size: 0 });
  cursor.parents = Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [String(i).padStart(64, '0'), []]),
  );
  const saved = await saveSourceProgress(cursor, null, storage.store);
  assert(saved.value.sections.parents);
  const root = await storage.read(saved.id);
  const failure = new TypeError('synthetic durable read reset');
  await assert.rejects(
    loadSourceProgress(root, async () => {
      throw failure;
    }),
    e => e === failure,
  );
  await assert.rejects(
    loadSourceProgress(root, async () => Buffer.from('bad gzip')),
    { code: 'SOURCE_HASH_MISMATCH' },
  );
  const taskRef = await storeTaskData({ index: 0 }, storage.store);
  await assert.rejects(
    loadTaskData(taskRef, async () => {
      throw failure;
    }),
    e => e === failure,
  );
  await assert.rejects(
    loadTaskData(taskRef, async () => Buffer.from('bad gzip')),
    { code: 'SOURCE_HASH_MISMATCH' },
  );
  const { gzipSync } = await import('node:zlib');
  const invalid = Buffer.from('{');
  await assert.rejects(
    loadTaskData({ id: taskRef.id, sha256: digest(invalid) }, async () => gzipSync(invalid)),
    { code: 'SOURCE_HASH_MISMATCH' },
  );
});

test('a padded recipe root above the established 2 MiB metadata bound is rejected before acquisition', async () => {
  const { MemoryMergeSource, MemorySourceReader } = await import('../dist/hosted-source-memory.js');
  const object = { sha256: digest('x'), size: 1 };
  const raw = Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-object-recipe',
      object,
      tree: { ...object, height: 0, length: 1 },
    }) + ' '.repeat(2 * 1024 * 1024),
  );
  const recipe = { sha256: digest(raw), size: raw.length };
  let reads = 0;
  const reader = new MemorySourceReader(new MemoryMergeSource({}), {
    read: async () => {
      reads++;
      return (async function* () {
        yield raw;
      })();
    },
  });
  await assert.rejects(reader.bytes({ object, recipe }), { code: 'SOURCE_PAGE_INVALID' });
  assert.equal(reads, 0);
  assert.equal(reader.source.objects.size, 0);
});

test('cost 298f9675: the existing step marker separates attempted State, progress, result and refused bodies', async t => {
  fakeSourceR2(t);
  const { sourcePutMetrics } = await import(moduleUrl('../convex/projectSourceBytes.ts'));
  const { logSourceStep } = await import('../dist/hosted-source-io-error.js');
  const counts = sourcePutMetrics(),
    ctx = { storage: forbiddenStorage };
  const state = sourceStorage(ctx, 'project', digest, counts.observer('state')),
    progress = sourceStorage(ctx, 'project', digest, counts.observer('progress')),
    other = sourceStorage(ctx, 'project', digest, counts.observer('other'));
  const result = Buffer.from('result');
  await state.store(Buffer.from('state'));
  await state.store(Buffer.from('state'));
  await progress.store(Buffer.from('cursor'));
  await other.store(result);
  counts.avoid(123);
  let logged;
  t.mock.method(console, 'warn', value => {
    logged = JSON.parse(value);
  });
  logSourceStep(
    { jobId: 'synthetic', step: 1 },
    {
      runtime: 'node',
      kind: 'save',
      from: 'input',
      to: 'done',
      objects: 1,
      bytes: 5,
      outputs: 2,
      started: performance.now(),
      putBytes: counts.snapshot({ sha256: digest(result) }),
    },
  );
  assert.equal(logged.event, 'forge-source-step');
  assert.deepEqual(logged.putBytes, {
    state: 10,
    progress: 6,
    result: 6,
    other: 0,
    refused: 5,
    avoided: 123,
  });
});

test('State reuse reconciles lost PUT outcomes without resending bytes and rejects a changed binding', async t => {
  const r2 = fakeSourceR2(t);
  const { sourcePutMetrics } = await import(moduleUrl('../convex/projectSourceBytes.ts'));
  const counts = sourcePutMetrics();
  const storage = sourceStorage(
    { storage: forbiddenStorage },
    'project',
    digest,
    counts.observer('state'),
    true,
  );
  const bytes = Buffer.from('exact immutable State');
  r2.hooks.lostPut = true;
  await assert.rejects(storage.store(bytes), { name: 'SourceIoError', stage: 'source-put' });
  const puts = r2.requests.filter(method => method === 'PUT').length;
  const retained = await storage.store(bytes);
  assert.equal(r2.requests.filter(method => method === 'PUT').length, puts);
  assert.deepEqual(Buffer.from(await storage.read(retained)), bytes);
  assert.equal(counts.snapshot().avoided, bytes.length);
  r2.hooks.mismatch = true;
  await assert.rejects(storage.store(bytes), { code: 'R2_VERIFY_FAILED' });
  assert.equal(r2.requests.filter(method => method === 'PUT').length, puts);
});

for (const status of [429, 503])
  test(`State reuse preserves retryable HEAD ${status} without uploading over an unknown binding`, async t => {
    fakeSourceR2(t);
    let puts = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init = {}) => {
      if (init.method === 'PUT') puts++;
      return new Response(null, { status });
    });
    await assert.rejects(
      sourceStorage({ storage: forbiddenStorage }, 'project', digest, undefined, true).store(
        Buffer.from('state'),
      ),
      { name: 'SourceIoError', stage: 'source-head', httpStatus: status },
    );
    assert.equal(puts, 0);
  });
