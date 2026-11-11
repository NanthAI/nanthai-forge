// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { moduleUrl } from './convex-module.mjs';
import { state, projectRow } from './hosted-fixture.mjs';
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
  const meter = {
    objectQueries: 0,
    objectDocuments: 0,
    objectBytes: 0,
    catalogQueries: 0,
    catalogDocuments: 0,
    catalogBytes: 0,
  };
  const query = s.ctx.db.query;
  s.ctx.db.query = table => {
    const result = query(table);
    const kind = table === 'projectObjectCatalog' ? 'catalog' : table === 'projectObjects' ? 'object' : null;
    if (!kind) return result;
    const method = kind === 'catalog' ? 'take' : 'unique';
    const read = result[method];
    const counted = {
      ...result,
      [method]: async (...args) => {
        meter[`${kind}Queries`]++;
        const value = await read(...args);
        const rows = Array.isArray(value) ? value : value ? [value] : [];
        meter[`${kind}Documents`] += rows.length;
        meter[`${kind}Bytes`] += rows.reduce(
          (total, row) => total + Buffer.byteLength(JSON.stringify(row)),
          0,
        );
        return value;
      },
    };
    counted.withIndex = (...args) => (result.withIndex(...args), counted);
    counted.order = value => (result.order(value), counted);
    return counted;
  };
  return {
    s,
    reads: () => meter.catalogQueries,
    bytes: () => meter.catalogBytes,
    meter: () => ({ ...meter }),
  };
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

test('sparse catalog lookup cost distinguishes page width from documents read at zoo sizes (8c4f126b)', async t => {
  for (const [count, fullBudget, tailBudget] of [
    [35, 6833, 6833],
    [402, 48542, 27797],
    [1387, 48919, 20589],
  ]) {
    // Synthetic packed blobs, not retained zoo source or provider billing. Equal-width
    // identities isolate full versus tail page placement from source/metadata drift.
    const pins = Array.from({ length: count }, (_, i) => ({
      digest: hex(`sparse-${i}`),
      size: 1024,
      pack: { digest: hex('pack'), size: count * 1024, offset: i * 1024 },
    }));
    const run = fixture(pins);
    const sorted = [...pins].sort((a, b) => (a.digest < b.digest ? -1 : 1));
    const selected = [sorted[0], sorted.at(-1)];
    const raw = selected.map((pin, index) => ({
      _id: `raw-${index}`,
      _creationTime: 1,
      projectId: 'project',
      ...pin,
      nonce: '00000000-0000-4000-8000-000000000000',
      removed: false,
      sourceReferenced: true,
      location: 'r2',
      r2Key: `v1/p/project/o/${pin.pack.digest}`,
      r2Committed: true,
    }));
    for (const row of raw) run.s.tables.projectObjects.set(row._id, row);
    const lookup = async pin => {
      const before = run.meter();
      const row = await find.findObject({ ...run.s.ctx }, 'project', pin.digest);
      assert.equal(row.size, pin.size);
      assert.deepEqual(row.pack, pin.pack);
      return Object.fromEntries(
        Object.entries(run.meter()).map(([key, value]) => [key, value - before[key]]),
      );
    };
    for (const pin of selected) {
      const measured = await lookup(pin);
      assert.equal(measured.objectDocuments, 1);
      assert.equal(measured.objectBytes, Buffer.byteLength(JSON.stringify(raw[selected.indexOf(pin)])));
      assert.equal(measured.catalogQueries, 0, 'raw descriptors take precedence');
    }
    const rawBytes = raw.map(row => Buffer.byteLength(JSON.stringify(row)));
    for (const row of raw) run.s.tables.projectObjects.delete(row._id);
    const after = [];
    for (const pin of selected) after.push(await lookup(pin));
    for (const [index, measured] of after.entries()) {
      assert.equal(measured.objectQueries, 1, 'raw precedence is checked once');
      assert.equal(measured.objectDocuments, 0, 'a raw miss is not a document read');
      assert.equal(measured.catalogQueries, 1);
      assert.equal(measured.catalogDocuments, 1, 'both full and tail lookup read one document');
      assert(
        measured.catalogBytes <= [fullBudget, tailBudget][index],
        `${count}: packed descriptor page byte ratchet`,
      );
    }
    assert(after.every((measured, index) => measured.catalogBytes > rawBytes[index]));
    if (count > 256)
      assert(after[0].catalogBytes > after[1].catalogBytes, 'one document has different byte costs');
    const request = { ...run.s.ctx };
    const start = run.meter();
    for (const pin of sorted.slice(0, Math.min(count, 100))) {
      assert.equal((await find.findObject(request, 'project', pin.digest)).size, pin.size);
    }
    assert.equal(
      run.meter().catalogQueries - start.catalogQueries,
      1,
      'neighbours reuse their covering page',
    );
    t.diagnostic(JSON.stringify({ sparseCatalog: { count, rawBytes, full: after[0], tail: after[1] } }));
  }
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

test('catalog compaction preserves every reachable binding, original upload retry and State provenance without idle work', async t => {
  const compact = await import(moduleUrl('../convex/projectObjectCatalogCompact.ts'));
  const commit = await import(moduleUrl('../convex/projectObjectCommit.ts'));
  const output = await import(moduleUrl('../convex/projectConvexSourceOutput.ts'));
  const f = state([], { keysetPaging: true }),
    projectId = 'project';
  f.tables.hostedProjects.set(projectId, projectRow({ _id: projectId }));
  f.counts = [];
  let meter;
  for (const name of ['insert', 'patch', 'replace', 'delete']) {
    const original = f.ctx.db[name];
    f.ctx.db[name] = async (...args) => {
      const result = await original(...args);
      if (meter) {
        meter.writes++;
        if (name !== 'delete') {
          const id = name === 'insert' ? result : args[0];
          const row = await f.ctx.db.get(id);
          meter.writeBytes += Buffer.byteLength(JSON.stringify(row));
        }
      }
      return result;
    };
  }
  f.run = async (name, action) => {
    meter = { name, writes: 0, writeBytes: 0 };
    try {
      return await f.transaction(action);
    } finally {
      f.counts.push(meter);
      meter = null;
    }
  };
  f.call = (name, fn, args) => f.run(name, () => fn._handler(f.ctx, args));
  const inputs = Array.from({ length: 600 }, (_, i) => ({
    digest: hex(`compact-${i}`),
    size: i + 1,
    ...(i % 19 === 0
      ? { recipe: { digest: hex('compact-1'), size: 2 } }
      : i % 17 === 0
        ? { pack: { digest: hex('compact-2'), size: 100000, offset: i } }
        : {}),
  }));
  const imported = Array.from({ length: 300 }, (_, i) => ({ digest: hex(`imported-${i}`), size: i }));
  for (const page of find.catalogPages(imported))
    await f.ctx.db.insert('projectObjectCatalog', { projectId, ...page, origin: 'github-import:complete' });
  const ids = [];
  for (const pin of inputs)
    ids.push(
      await f.ctx.db.insert('projectObjects', {
        projectId,
        ...pin,
        nonce: 'original-upload',
        removed: false,
        sourceReferenced: true,
        location: 'r2',
        r2Key: `v1/p/${projectId}/o/${pin.pack?.digest ?? pin.digest}`,
        r2Committed: true,
      }),
    );
  const stateDigest = hex('state-with-provenance');
  const stateId = await f.ctx.db.insert('projectObjects', {
    projectId,
    digest: stateDigest,
    size: 100,
    nonce: 'state',
    removed: false,
    sourceReferenced: true,
    stateGeneration: 2,
    stateParents: [hex('parent')],
    location: 'r2',
    r2Committed: true,
    r2Key: `v1/p/${projectId}/o/${stateDigest}`,
  });
  const preserved = JSON.stringify(f.tables.projectObjects.get(stateId));
  const untouched = [];
  for (const fields of [
    { sourceReferenced: false },
    { recipeClosure: [{ sha256: hex('closure-leaf'), size: 1 }] },
    { r2Committed: false },
    { r2SweepKey: 'cleanup-key' },
    { stateParents: [] },
    { packMembers: [{ digest: hex('member'), size: 1 }] },
  ]) {
    const digest = hex(JSON.stringify(fields));
    const id = await f.ctx.db.insert('projectObjects', {
      projectId,
      digest,
      size: 1,
      nonce: 'retained',
      removed: false,
      sourceReferenced: true,
      location: 'r2',
      r2Committed: true,
      r2Key: `v1/p/${projectId}/o/${digest}`,
      ...fields,
    });
    untouched.push([id, JSON.stringify(f.tables.projectObjects.get(id))]);
  }
  const before = [...f.tables.projectObjects.values(), ...f.tables.projectObjectCatalog.values()].reduce(
    (n, row) => n + Buffer.byteLength(JSON.stringify(row)),
    0,
  );
  let after = null,
    result,
    steps = 0;
  do {
    const request = { projectId, actor: 'owner', operationId: 'compact-original', after };
    const value = await f.call('compact', compact.step, request);
    assert.equal(
      await f.call('compact-replay', compact.step, request),
      value,
      'unknown outcome replays the same page receipt',
    );
    assert.equal(f.counts.at(-1).writes, 0, 'page replay writes nothing');
    result = JSON.parse(value);
    after = result.after;
    assert(++steps < 20, 'bounded migration converges');
  } while (!result.done);
  assert.equal(result.moved, 600);
  assert.equal(
    JSON.stringify(f.tables.projectObjects.get(stateId)),
    preserved,
    'mutable State provenance stays byte-identical',
  );
  assert.equal(f.tables.projectObjects.size, 1 + untouched.length);
  for (const [id, original] of untouched)
    assert.equal(JSON.stringify(f.tables.projectObjects.get(id)), original);
  // Sparse imported pages and later source writes can have interleaving digest ranges.
  await f.run('new-source', () =>
    output.storeSourceOutputs(f.ctx, projectId, 'source-execution', [
      { sha256: hex('later-source'), size: 7, r2Key: `v1/p/${projectId}/o/${hex('later-source')}` },
      {
        sha256: hex('new-state'),
        size: 9,
        stateGeneration: 3,
        stateParents: [stateDigest],
        r2Key: `v1/p/${projectId}/o/${hex('new-state')}`,
      },
    ]),
  );
  assert.equal(
    f.tables.projectObjects.size,
    3 + untouched.length,
    'new source output retains proportional writes without rewriting unrelated catalog pages',
  );
  const resolved = await f.run('reachable', () =>
    find.findObjects({ ...f.ctx }, projectId, [
      ...inputs.map(pin => pin.digest),
      hex('later-source'),
      hex('new-state'),
    ]),
  );
  assert.deepEqual(
    resolved.map(row => row?.size),
    [...inputs.map(pin => pin.size), 7, 9],
  );
  const oldImport = await find.findObjects(
    { ...f.ctx },
    projectId,
    imported.map(pin => pin.digest),
  );
  assert.deepEqual(
    oldImport.map(row => row?.size),
    imported.map(pin => pin.size),
    'pre-existing imported bindings remain reachable',
  );
  assert.deepEqual(resolved[0].recipe, inputs[0].recipe);
  assert.deepEqual(resolved[17].pack, inputs[17].pack);
  const pages = [...f.tables.projectObjectCatalog.values()].sort((a, b) => (a.first < b.first ? -1 : 1));
  for (let i = 1; i < pages.length; i++)
    assert(pages[i - 1].last < pages[i].first, 'catalog ranges never overlap');
  assert.deepEqual(
    await f.call('old-upload-retry', commit.pendingRows, { actor: 'owner', ids: [ids[0], ids[599]] }),
    [],
  );
  await assert.rejects(
    f.call('unauthorized-old-upload', commit.pendingRows, { actor: 'stranger', ids: [ids[0]] }),
  );
  await assert.rejects(f.call('unknown-upload', commit.pendingRows, { actor: 'owner', ids: ['absent'] }));
  let checked = 0,
    cursor = null,
    verification;
  do {
    verification = JSON.parse(await f.call('verify', compact.verify, { projectId, actor: 'owner', cursor }));
    cursor = verification.cursor;
    checked += verification.checked;
  } while (!verification.done);
  assert.equal(checked, inputs.length, 'the independent verifier checks every migrated digest');
  const pinReceipt = [...f.tables.projectObjectReceipts.values()].find(
    row => !row.key.startsWith('catalog-migration:'),
  );
  const originalSize = pinReceipt.size;
  await f.ctx.db.patch(pinReceipt._id, { size: originalSize + 1 });
  await assert.rejects(
    f.call('verify-size-mismatch', compact.verify, { projectId, actor: 'owner', cursor: null }),
    'reachability also retains the exact original logical size',
  );
  await f.ctx.db.patch(pinReceipt._id, { size: originalSize });

  const retained = ['projectObjects', 'projectObjectCatalog', 'projectObjectReceipts'].reduce(
    (n, table) =>
      n + [...f.tables[table].values()].reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0),
    0,
  );
  assert(
    retained < before * 0.9,
    `${retained}/${before}: compact descriptors plus permanent original-id and late-upload nonce receipts`,
  );
  for (const row of pages) assert(row.sizes.length <= 256);
  const sourceWrite = f.counts.find(row => row.name === 'new-source');
  assert(
    sourceWrite.writeBytes < 2 * 1024,
    'small worker publication does not rewrite unrelated catalog pages',
  );
  t.diagnostic(
    JSON.stringify({
      before,
      retained,
      moved: result.moved,
      pages: pages.length,
      steps,
      migration: result,
      sourceWriteBytes: sourceWrite.writeBytes,
    }),
  );
});
