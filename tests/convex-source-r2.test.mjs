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
    { states: Array.from({ length: 3000 }, (_, i) => `state-${i}`) },
    storage.store,
  );
  assert(sourceR2Pin(ref.id));
  assert.equal((await loadTaskData(ref, storage.read)).states.length, 3000);
  const bytes = Buffer.from('retry bytes');
  r2.hooks.lostPut = true;
  await assert.rejects(storage.store(bytes), /lost PUT/);
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
