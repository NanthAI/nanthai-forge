// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
const find = await import(moduleUrl('../convex/projectObjectFind.ts'));
const store = await import(moduleUrl('../convex/projectWorkIndexStore.ts'));
const catalog = await import(moduleUrl('../convex/projectGithubImportCatalog.ts'));
const hex = value => createHash('sha256').update(String(value)).digest('hex');

/** Count reads of catalog rows: the budget is one small document per catalog row a request touches. */
function fixture(objects) {
  const s = state([]);
  for (const page of find.catalogPages(objects))
    s.tables.projectObjectCatalog.set(`catalog-${page.first}`, {
      _id: `catalog-${page.first}`,
      _creationTime: 1,
      projectId: 'project',
      origin: 'github-import:job',
      ...page,
    });
  let catalogReads = 0,
    catalogReadBytes = 0;
  const query = s.ctx.db.query;
  s.ctx.db.query = table => {
    const result = query(table);
    if (table !== 'projectObjectCatalog') return result;
    const take = result.take;
    const counted = {
      ...result,
      take: async n => {
        catalogReads += n;
        const rows = await take(n);
        catalogReadBytes += rows.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row)), 0);
        return rows;
      },
    };
    counted.withIndex = (...args) => (result.withIndex(...args), counted);
    counted.order = value => (result.order(value), counted);
    return counted;
  };
  return { s, reads: () => catalogReads, bytes: () => catalogReadBytes };
}
const objects = Array.from({ length: 1000 }, (_, i) => ({
  digest: hex(i),
  size: i,
  ...(i % 97 === 0 ? { recipe: { digest: hex(`recipe-${i}`), size: 64 } } : {}),
}));

test('no project object digest lookup bypasses findObject (catalog-backed projects have no rows)', () => {
  const offenders = [];
  for (const name of readdirSync(new URL('../convex/', import.meta.url))) {
    if (!name.endsWith('.ts') || name === 'projectObjectFind.ts') continue;
    const source = readFileSync(new URL(`../convex/${name}`, import.meta.url), 'utf8');
    if (/withIndex\(\s*'by_project_and_digest'[^)]*\)[^;]*?\.eq\(\s*'digest'/s.test(source))
      offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'resolve project objects with findObject (convex/projectObjectFind.ts)');
});

test('findObject resolves catalog entries, recipes and misses; per-object rows take precedence', async () => {
  const { s } = fixture(objects);
  const sorted = [...objects].sort((a, b) => (a.digest < b.digest ? -1 : 1));
  const raw = await find.findObject(s.ctx, 'project', objects[5].digest);
  assert.deepEqual(
    { size: raw.size, location: raw.location, r2Key: raw.r2Key, committed: raw.r2Committed, id: raw._id },
    { size: 5, location: 'r2', r2Key: `v1/p/project/o/${objects[5].digest}`, committed: true, id: undefined },
  );
  assert.equal(raw.sourceReferenced, true, 'catalog objects are source and protected from log cleanup');
  const recipe = await find.findObject(s.ctx, 'project', objects[97].digest);
  assert.deepEqual(recipe.recipe, objects[97].recipe);
  assert.equal(recipe.location, undefined);
  for (const digest of ['0'.repeat(64), 'f'.repeat(64), hex('absent'), 'not-a-digest'])
    assert.equal(await find.findObject(s.ctx, 'project', digest), null, digest);
  assert.equal(await find.findObject(s.ctx, 'other', sorted[0].digest), null, 'catalogs are per project');
  for (const entry of [sorted[0], sorted[255], sorted[256], sorted.at(-1)])
    assert.equal((await find.findObject(s.ctx, 'project', entry.digest)).size, entry.size);
  s.tables.projectObjects.set('row', {
    _id: 'row',
    _creationTime: 1,
    projectId: 'project',
    digest: objects[5].digest,
    size: 5,
    nonce: 'n',
    removed: false,
    location: 'r2',
    r2Key: 'own',
    r2Committed: true,
  });
  assert.equal((await find.findObject(s.ctx, 'project', objects[5].digest))._id, 'row');
});

test('a request reads each catalog row once; sorted pages touch one or two rows', async () => {
  const sorted = [...objects].map(o => o.digest).sort();
  const sortedRun = fixture(objects);
  const ctx = { ...sortedRun.s.ctx };
  for (const digest of sorted.slice(300, 400)) assert.ok(await find.findObject(ctx, 'project', digest));
  assert.ok(sortedRun.reads() <= 2, `${sortedRun.reads()} catalog reads for 100 sorted digests`);
  const random = fixture(objects);
  const request = { ...random.s.ctx };
  for (let i = 0; i < 3; i++)
    for (const object of objects.slice(0, 100))
      assert.ok(await find.findObject(request, 'project', object.digest));
  assert.ok(random.reads() <= 4, `${random.reads()} catalog reads: at most one per catalog row`);
  // A page lookup reads rows concurrently but still each catalog row at most once, in order.
  const batch = fixture(objects);
  const digests = [...objects.slice(0, 500).map(o => o.digest), objects[3].digest, hex('absent'), 'bad'];
  const rows = await find.findObjects({ ...batch.s.ctx }, 'project', digests);
  assert.ok(batch.reads() <= 4, `${batch.reads()} catalog reads for a 500-digest page`);
  assert.deepEqual(
    rows.map(row => row?.size ?? null),
    [...objects.slice(0, 500).map(o => o.size), 3, null, null],
  );
  assert.deepEqual(rows[97].recipe, objects[97].recipe);
});

test('Actions source lookup cost guard batches neighbouring catalog rows without repeated per-object pages (686ecdde, 298f9675)', async t => {
  const { directSourceWindow, directSourceBatch, sourceWindowOrder } =
    await import('../dist/hosted-actions-direct.js');
  // A catalog-backed tree in path order (sha order is unrelated), with one blob at two paths.
  const tree = Array.from({ length: 20000 }, (_, i) => ({
    digest: hex(`tree-${i}`),
    size: 1024 + (i % 1024),
  }));
  const blobs = [...tree.map(o => o.digest), tree[7].digest];
  const pages = find.catalogPages(tree).length;
  const sizes = new Map(tree.map(row => [row.digest, row.size]));
  const windows = async (ordered, window = directSourceWindow) => {
    const run = fixture(tree);
    for (let at = 0; at < ordered.length; at += window) {
      const hashes = ordered.slice(at, at + window);
      assert(
        hashes.reduce((bytes, hash) => bytes + sizes.get(hash), 0) < 8 * 1024 * 1024,
        'fixture batches fit the resolver byte lookahead without an earlier prefix',
      );
      const rows = await find.findObjects({ ...run.s.ctx }, 'project', hashes);
      assert(rows.every(Boolean));
    }
    return { reads: run.reads(), bytes: run.bytes() };
  };
  const ordered = sourceWindowOrder(blobs);
  assert.equal(ordered.length, tree.length, 'each object once');
  const sorted = await windows(ordered),
    pathOrder = await windows(blobs);
  const calls = Math.ceil(ordered.length / directSourceWindow);
  assert(
    sorted.reads <= pages + calls,
    `${sorted.reads} catalog rows read in ${calls} sorted windows (${pages} rows)`,
  );
  assert(
    pathOrder.reads > 10 * sorted.reads,
    `path order reads ${pathOrder.reads} rows, sorted ${sorted.reads}`,
  );
  const batched = await windows(ordered, directSourceBatch);
  assert.equal(Math.ceil(ordered.length / directSourceBatch), 7);
  assert(batched.bytes <= 1_480_000, `${batched.bytes} catalog DB bytes`);
  assert(batched.bytes < sorted.bytes * 0.7, 'larger windows remove repeated boundary-page reads');
  t.diagnostic(
    JSON.stringify({
      catalogLookup: {
        files: tree.length,
        before: sorted,
        after: batched,
        beforeCalls: calls + 1,
        afterCalls: 8,
      },
    }),
  );
});

test('catalog-backed generations resolve sourceBlobs from the catalog, others do not', async () => {
  const { s } = fixture(objects);
  s.tables.projectWorkGenerations.set('catalogued', {
    _id: 'catalogued',
    projectId: 'project',
    objectCatalog: true,
  });
  s.tables.projectWorkGenerations.set('plain', { _id: 'plain', projectId: 'project' });
  const row = await store.readRecord(s.ctx, 'catalogued', 'sourceBlobs', objects[7].digest);
  assert.deepEqual(JSON.parse(row.value), { sha256: objects[7].digest, size: 7 });
  assert.equal(await store.readRecord(s.ctx, 'catalogued', 'sourceBlobs', hex('absent')), null);
  assert.equal(await store.readRecord(s.ctx, 'plain', 'sourceBlobs', objects[7].digest), null);
  assert.equal(await store.readRecord(s.ctx, 'catalogued', 'lanes', objects[7].digest), null);
});

test('objectRow copies a catalog entry into one stored, source-referenced row only when a writer needs an id', async () => {
  const { s } = fixture(objects);
  const view = await find.findObject(s.ctx, 'project', objects[9].digest);
  const row = await find.objectRow(s.ctx, view);
  assert.ok(row._id);
  assert.deepEqual(
    { location: row.location, r2Committed: row.r2Committed, sourceReferenced: row.sourceReferenced },
    { location: 'r2', r2Committed: true, sourceReferenced: true },
  );
  assert.equal((await find.objectRow(s.ctx, row))._id, row._id, 'rows are returned as they are');
  assert.equal(s.tables.projectObjects.size, 1);
});

test('import progress rows are deleted in bounded pages once main is published (legacy protocol too)', async () => {
  const s = state([]);
  s.tables.projectGithubImports.set('job', {
    _id: 'job',
    projectId: 'project',
    owner: 'owner',
    phase: 'ready',
  });
  for (let i = 0; i < 1200; i++)
    s.tables.projectGithubImportInventory.set(`row-${i}`, {
      _id: `row-${i}`,
      projectId: 'project',
      jobId: 'job',
      part: i % 2 ? 'files' : 'directories',
      key: String(i).padStart(5, '0'),
      position: i,
      value: '{}',
    });
  await catalog.purgeInventory(s.ctx, 'job', 'owner');
  assert.equal(s.tables.projectGithubImportInventory.size, 200, 'tiny rows stop at the 1,000-row cap');
  for (let run = 0; run < 5 && s.scheduled.length; run++) {
    const task = s.scheduled.shift();
    await catalog.purge._handler(s.ctx, task.args);
  }
  assert.equal(s.tables.projectGithubImportInventory.size, 0);
  assert.equal(s.scheduled.length, 0, 'the chain stops when nothing is left');
});

test('a large inventory (135 KB window rows, 40 MB) is purged in pages that each read under 8 MiB', async () => {
  const s = state([]);
  s.tables.projectGithubImports.set('job', {
    _id: 'job',
    projectId: 'project',
    owner: 'owner',
    phase: 'ready',
  });
  const value = 'x'.repeat(135 * 1024);
  for (let i = 0; i < 300; i++)
    s.tables.projectGithubImportInventory.set(`row-${i}`, {
      _id: `row-${i}`,
      projectId: 'project',
      jobId: 'job',
      part: 'objects',
      key: String(i).padStart(5, '0'),
      position: 0,
      value,
    });
  let read = 0;
  const query = s.ctx.db.query;
  s.ctx.db.query = table => {
    const q = query(table);
    if (table !== 'projectGithubImportInventory') return q;
    const iterate = async function* (indexed) {
      for await (const row of indexed) {
        read += JSON.stringify(row).length;
        yield row;
      }
    };
    return {
      withIndex: (...args) => iterate(q.withIndex(...args)),
    };
  };
  const pages = [];
  await catalog.purge._handler(s.ctx, { id: 'job', actor: 'owner' });
  pages.push(read);
  while (s.scheduled.length) {
    read = 0;
    await catalog.purge._handler(s.ctx, s.scheduled.shift().args);
    pages.push(read);
    assert.ok(pages.length < 100, 'the purge chain converges');
  }
  assert.equal(s.tables.projectGithubImportInventory.size, 0);
  assert.ok(Math.max(...pages) < 8 * 1024 * 1024, `a page read ${Math.max(...pages)} bytes`);
  assert.ok(pages.length >= 9, `${pages.length} pages: bounded by bytes, not one 500-row page of ~66 MB`);
});
