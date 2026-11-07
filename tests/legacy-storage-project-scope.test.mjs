// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
import { initialSourceStep } from '../dist/hosted-source-step.js';
import { saveSourceProgress, loadSourceProgress } from '../dist/hosted-source-step-progress.js';
import { storeTaskData, loadTaskData } from '../dist/hosted-source-task-data.js';
const { sourceStorage } = await import(moduleUrl('../convex/projectConvexSourceStorage.ts'));
const { owns } = await import(moduleUrl('../convex/projectConvexSourceOwnership.ts'));
const { objectTables } = await import(moduleUrl('../convex/projectObjectFields.ts'));

function fixture() {
  const rows = [
    { projectId: 'other', storageId: 'owned', removed: false },
    { projectId: 'project', storageId: 'owned', removed: false },
    { projectId: 'other', storageId: 'foreign', removed: false },
    { projectId: 'project', storageId: 'removed', removed: true },
    { projectId: 'project', storageId: 'missing', removed: false },
  ];
  const blobs = new Map([['owned', new Uint8Array([11, 22, 33])]]);
  const counts = { calls: 0, lookups: 0, returnedRows: 0, storageReads: [] };
  const db = {
    system: {
      normalizeId(table, ref) {
        assert.equal(table, '_storage');
        return ref === 'invalid-id' ? null : ref;
      },
    },
    query(table) {
      assert.equal(table, 'projectObjects');
      const terms = {};
      return {
        withIndex(name, select) {
          assert.equal(name, 'by_project_and_storage_and_removed');
          const q = {
            eq(key, value) {
              terms[key] = value;
              return q;
            },
          };
          select(q);
          assert.deepEqual(Object.keys(terms), ['projectId', 'storageId', 'removed']);
          return this;
        },
        async first() {
          counts.lookups++;
          const row = rows.find(row => Object.entries(terms).every(([key, value]) => row[key] === value));
          if (row) counts.returnedRows++;
          return row ?? null;
        },
      };
    },
  };
  const ctx = {
    async runQuery(ref, args) {
      assert.equal(getFunctionName(ref), 'projectConvexSourceOwnership:owns');
      counts.calls++;
      return owns._handler({ db }, args);
    },
    storage: {
      async get(ref) {
        counts.storageReads.push(ref);
        // Refusal must happen even if storage would return bytes for an unowned ID.
        return ref === 'missing' ? null : new Blob([blobs.get(ref) ?? new Uint8Array([99])]);
      },
    },
  };
  return { ctx, rows, blobs, counts, storage: sourceStorage(ctx, 'project') };
}

test('legacy ownership index covers project, storage ID and live membership', () => {
  const index = objectTables.projectObjects
    .export()
    .indexes.find(index => index.indexDescriptor === 'by_project_and_storage_and_removed');
  assert.deepEqual(index.fields, ['projectId', 'storageId', 'removed']);
});

test('owned legacy ref reads bytes even when another project shares the ID', async () => {
  const f = fixture();
  assert.deepEqual(await f.storage.read('owned'), f.blobs.get('owned'));
  assert.deepEqual(f.counts, { calls: 1, lookups: 1, returnedRows: 1, storageReads: ['owned'] });
});

for (const ref of ['foreign', 'unknown', 'removed', 'invalid-id']) {
  test(`legacy ${ref} ref is refused with a typed error before fetching bytes`, async () => {
    const f = fixture();
    await assert.rejects(f.storage.read(ref), { name: 'ForgeError', code: 'SOURCE_REF_UNOWNED' });
    assert.deepEqual(f.counts, {
      calls: 1,
      lookups: ref === 'invalid-id' ? 0 : 1,
      returnedRows: 0,
      storageReads: [],
    });
  });
}

test('SOURCE_REF_UNOWNED tells the caller to start the operation again', async () => {
  const f = fixture();
  await assert.rejects(f.storage.read('foreign'), {
    code: 'SOURCE_REF_UNOWNED',
    message: /cannot resume\. Start the operation again from its input/,
  });
});

test('an owned ref whose bytes are absent retains SOURCE_UNAVAILABLE', async () => {
  const f = fixture();
  await assert.rejects(f.storage.read('missing'), { code: 'SOURCE_UNAVAILABLE' });
  assert.deepEqual(f.counts, { calls: 1, lookups: 1, returnedRows: 1, storageReads: ['missing'] });
});

test('ownership is checked again on each read after the binding is removed', async () => {
  const f = fixture();
  await f.storage.read('owned');
  f.rows.find(row => row.projectId === 'project' && row.storageId === 'owned').removed = true;
  await assert.rejects(f.storage.read('owned'), { code: 'SOURCE_REF_UNOWNED' });
  assert.deepEqual(f.counts, { calls: 2, lookups: 2, returnedRows: 1, storageReads: ['owned'] });
});

test('cursor sections and fanout progress use the same ownership boundary', async () => {
  const f = fixture();
  let next = 0;
  const store = async bytes => {
    const ref = `legacy-${next++}`;
    f.blobs.set(ref, bytes);
    f.rows.push({ projectId: 'project', storageId: ref, removed: false });
    return ref;
  };
  const cursor = initialSourceStep({ sha256: 'a'.repeat(64), size: 0 });
  cursor.parents = Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [String(i).padStart(64, '0'), []]),
  );
  const saved = await saveSourceProgress(cursor, null, store);
  assert(saved.value.sections.parents);
  assert.deepEqual((await loadSourceProgress(await f.storage.read(saved.id), f.storage.read)).cursor, cursor);
  const section = saved.value.sections.parents.id;
  f.rows.find(row => row.storageId === section).projectId = 'other';
  await assert.rejects(loadSourceProgress(await f.storage.read(saved.id), f.storage.read), {
    code: 'SOURCE_REF_UNOWNED',
  });
  assert.equal(f.counts.storageReads.filter(ref => ref === section).length, 1);
  const task = await storeTaskData({ index: 0, states: [], verify: null }, store);
  assert.equal((await loadTaskData(task, f.storage.read)).index, 0);
  f.rows.find(row => row.storageId === task.id).projectId = 'other';
  await assert.rejects(loadTaskData(task, f.storage.read), { code: 'SOURCE_REF_UNOWNED' });
  assert.equal(f.counts.storageReads.filter(ref => ref === task.id).length, 1);
  assert.equal(f.counts.lookups, f.counts.calls);
});

test('R2 refs stay project-scoped with no Convex calls or legacy reads', async t => {
  fakeSourceR2(t);
  const ctx = {
    runQuery() {
      assert.fail('R2 added an ownership RPC');
    },
    storage: {
      get() {
        assert.fail('R2 read legacy bytes');
      },
    },
  };
  const storage = sourceStorage(ctx, 'project');
  const bytes = new Uint8Array([1, 2, 3]);
  const ref = await storage.store(bytes);
  assert.deepEqual(await storage.read(ref), bytes);
  await assert.rejects(sourceStorage(ctx, 'other').read(ref), { code: 'SOURCE_UNAVAILABLE' });
  await assert.rejects(storage.read('r2source:invalid'), { code: 'SOURCE_HASH_MISMATCH' });
});

test('3000 legacy reads cost one lookup each and retain no ownership cache', async t => {
  const f = fixture(),
    started = performance.now(),
    rss = process.memoryUsage().rss;
  for (let index = 0; index < 3000; index++) await f.storage.read('owned');
  assert.equal(f.counts.calls, 3000);
  assert.equal(f.counts.lookups, 3000);
  assert.equal(f.counts.returnedRows, 3000);
  assert.equal(f.counts.storageReads.length, 3000);
  t.diagnostic(
    JSON.stringify({
      reads: 3000,
      convexCalls: 3000,
      indexedLookups: 3000,
      rowsRead: 3000,
      blobBytes: 9000,
      wallMs: Math.round(performance.now() - started),
      rssGrowth: process.memoryUsage().rss - rss,
    }),
  );
});
