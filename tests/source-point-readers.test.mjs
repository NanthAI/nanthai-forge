// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { state, projectRow } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
const find = await import(moduleUrl('../convex/projectObjectFind.ts'));
const downloads = await import(moduleUrl('../convex/projectObjectDownloads.ts'));
const nonce = '00000000-0000-4000-8000-000000000001';
function fixture() {
  const s = state([]),
    projectId = 'project';
  const rows = s.tables.projectObjectReceipts;
  rows.set('header', {
    _id: 'header',
    _creationTime: 1,
    projectId,
    key: `source-points:${projectId}`,
    value: '1',
  });
  let bytes = 0,
    queries = 0;
  const query = s.ctx.db.query;
  s.ctx.db.query = table => {
    const original = query(table);
    const wrapped = { ...original };
    for (const name of ['unique', 'take'])
      if (original[name])
        wrapped[name] = async (...args) => {
          queries++;
          const value = await original[name](...args);
          for (const row of Array.isArray(value) ? value : value ? [value] : [])
            bytes += Buffer.byteLength(JSON.stringify(row));
          return value;
        };
    for (const name of ['withIndex', 'order'])
      wrapped[name] = (...args) => {
        original[name](...args);
        return wrapped;
      };
    return wrapped;
  };
  return {
    s,
    projectId,
    rows,
    bytes: () => bytes,
    queries: () => queries,
    add(id, sourceBinding, size = 7) {
      const row = {
        _id: `point-${id.slice(0, 8)}`,
        _creationTime: 1,
        projectId,
        key: `source-point:${projectId}:${id}`,
        value: id,
        size,
        sourceBinding,
      };
      rows.set(row._id, row);
      return row;
    },
  };
}
for (const count of [402, 1387])
  test(`slim point readers keep stored and absent whole-row reads below1KB at${count} without a catalog`, async t => {
    const f = fixture(),
      ids = [];
    const pack = digest('shared pack');
    for (let i = 0; i < count; i++) {
      const id = digest(`member-${i}`);
      ids.push(id);
      f.add(id, {
        r2Key: `v1/p/project/o/${pack}/u/${nonce}`,
        pack: { digest: pack, size: 16 * 1024 * 1024, offset: i * 7 },
      });
    }
    const hit = await find.findObject(f.s.ctx, f.projectId, ids.at(-1));
    assert.equal(hit.digest, ids.at(-1));
    assert.equal(hit.sourceReferenced, true);
    const stored = f.bytes();
    assert(stored < 1000, `${stored} stored DB bytes`);
    const before = f.bytes();
    assert.equal(await find.findObject({ ...f.s.ctx }, f.projectId, digest('absent')), null);
    const absent = f.bytes() - before;
    assert(absent < 1000, `${absent} absent DB bytes`);
    t.diagnostic(JSON.stringify({ descriptors: count, storedBytes: stored, absentBytes: absent }));
  });
test('mixed point/catalog migration never treats a missing slim descriptor as absence and full rows take precedence', async () => {
  const f = fixture(),
    a = digest('point'),
    b = digest('legacy');
  f.add(a, { recipe: { digest: digest('recipe'), size: 40 } }, 100);
  for (const page of find.catalogPages([{ digest: b, size: 8 }]))
    f.s.tables.projectObjectCatalog.set('legacy', {
      _id: 'legacy',
      _creationTime: 1,
      projectId: f.projectId,
      origin: 'synthetic',
      ...page,
    });
  const values = await find.findObjects(f.s.ctx, f.projectId, [a, b, a]);
  assert.deepEqual(
    values.map(row => row.digest),
    [a, b, a],
  );
  assert.equal(values[0].recipe.size, 40);
  assert.equal(values[1].size, 8);
  f.s.tables.projectObjects.set('full', {
    _id: 'full',
    _creationTime: 1,
    projectId: f.projectId,
    digest: a,
    size: 100,
    nonce: 'pending',
    removed: false,
    location: 'r2',
    r2Committed: false,
    r2Key: 'pending',
  });
  assert.equal(
    (await find.findObject(f.s.ctx, f.projectId, a))._id,
    'full',
    'pending and mutable rows keep authority',
  );
});
test('point mode reads its header once per request, invalidation sees a later header, and legacy reads keep complete fallback', async () => {
  const f = fixture(),
    id = digest('value');
  f.add(id, { r2Key: `v1/p/project/o/${id}` });
  f.rows.delete('header');
  for (const page of find.catalogPages([{ digest: id, size: 7 }]))
    f.s.tables.projectObjectCatalog.set('legacy', {
      _id: 'legacy',
      _creationTime: 1,
      projectId: f.projectId,
      origin: 'synthetic',
      ...page,
    });
  assert.equal((await find.findObject(f.s.ctx, f.projectId, id)).size, 7);
  f.rows.set('header', {
    _id: 'header',
    _creationTime: 1,
    projectId: f.projectId,
    key: 'source-points:project',
    value: '1',
  });
  find.clearObjectCatalogCache(f.s.ctx);
  const before = f.queries();
  await find.findObjects(f.s.ctx, f.projectId, [id, id]);
  assert.equal(f.queries() - before, 3, 'one full row, one header and one point lookup for duplicate digest');
  const next = f.queries();
  await find.findObject(f.s.ctx, f.projectId, id);
  assert.equal(f.queries() - next, 2, 'subsequent point lookup reuses the header');
});
test('source point bindings refuse foreign projects, wrong identities, invalid nonce keys and changed pack intervals', async () => {
  const f = fixture(),
    id = digest('value'),
    row = f.add(id, { r2Key: `v1/p/project/o/${id}` });
  for (const patch of [
    { projectId: 'other' },
    { value: digest('other') },
    { size: -1 },
    { sourceBinding: { r2Key: `v1/p/other/o/${id}` } },
    { sourceBinding: { r2Key: `v1/p/project/o/${id}/u/bad` } },
    { sourceBinding: { r2Key: `v1/p/project/o/${id}`, pack: { digest: id, size: 7, offset: 1 } } },
  ]) {
    f.rows.set(row._id, { ...row, ...patch });
    await assert.rejects(find.findObject(f.s.ctx, f.projectId, id), error =>
      ['SOURCE_HASH_MISMATCH', 'INVALID_WORK_BACKUP'].includes(error.code),
    );
  }
});

test('slim points preserve nonce downloads, upload dedup and original upload-id reconciliation with current authority', async () => {
  const f = fixture(),
    id = digest('retained bytes');
  f.s.tables.hostedProjects.set(f.projectId, projectRow({ _id: f.projectId }));
  f.add(id, { r2Key: `v1/p/project/o/${id}/u/${nonce}` }, 7);
  const objects = await import(moduleUrl('../convex/projectObjects.ts'));
  const commits = await import(moduleUrl('../convex/projectObjectCommit.ts'));
  const reply = await downloads.describe._handler(f.s.ctx, {
    projectId: f.projectId,
    digests: [id],
    signed: true,
  });
  assert.equal(reply.length, 1);
  assert(new URL(reply[0].url).pathname.endsWith(`/o/${id}/u/${nonce}`));
  assert.deepEqual(
    await objects.missing._handler(f.s.ctx, { projectId: f.projectId, objects: [{ digest: id, size: 7 }] }),
    [],
  );
  assert.deepEqual(
    await objects.available._handler(f.s.ctx, { projectId: f.projectId, objects: [{ digest: id, size: 7 }] }),
    { stored: [0], selected: [] },
  );
  f.rows.set('retry', {
    _id: 'retry',
    _creationTime: 1,
    projectId: f.projectId,
    key: 'old-upload',
    value: id,
    size: 7,
    nonce: 'original',
  });
  assert.deepEqual(await commits.pendingRows._handler(f.s.ctx, { actor: 'owner', ids: ['old-upload'] }), []);
  await assert.rejects(
    commits.pendingRows._handler(f.s.ctx, { actor: 'stranger', ids: ['old-upload'] }),
    error => (error.code ?? error.data?.code) === 'PROJECT_UNAVAILABLE',
  );
  const compact = await import(moduleUrl('../convex/projectObjectCatalogCompact.ts'));
  const verified = JSON.parse(
    await compact.verify._handler(f.s.ctx, {
      projectId: f.projectId,
      actor: 'owner',
      cursor: null,
    }),
  );
  assert.equal(
    verified.checked,
    2,
    'the verifier checks point and original-id bindings, not the mode header',
  );
  f.s.caller('stranger');
  await assert.rejects(
    downloads.describe._handler(f.s.ctx, { projectId: f.projectId, digests: [id], signed: true }),
    error => (error.code ?? error.data?.code) === 'PROJECT_UNAVAILABLE',
  );
});

for (const fault of ['missing', 'fragmented', 'corrupt'])
  test(`Done-when6: ${fault} roots keep exact-State complete fallback after real dense retirement`, async t => {
    const { physicalStateSourceFixture } = await import('./physical-state-source-fixture.mjs');
    const { expandSourceGrants } = await import('../dist/source-grant-wire.js');
    const api = await import(moduleUrl('../convex/projectStateSourceApi.ts'));
    const compact = await import(moduleUrl('../convex/projectObjectCatalogCompact.ts'));
    const { readSignedPhysical } = await import(moduleUrl('../convex/projectStateSourceReader.ts'));
    const f = await physicalStateSourceFixture(t, 1001, { fragmented: fault === 'fragmented' });
    f.s.patch('hostedProjects', f.s.projectId, { sourceManifestVersion: 2 });
    const stateRow = [...f.s.tables.projectObjects.values()].find(row => row.digest === f.s.state.sha256);
    if (fault === 'missing')
      f.s.patch('projectObjects', stateRow._id, { statePhysical: undefined, stateGeneration: 1 });
    if (fault === 'corrupt')
      f.r2.objects.set(
        `/synthetic/v1/p/${f.s.projectId}/o/${stateRow.statePhysical.sha256}`,
        Buffer.from('corrupt metadata'),
      );
    let after = null,
      result;
    do {
      result = JSON.parse(
        await f.s.transaction('retire fallback bindings', compact.step, {
          projectId: f.s.projectId,
          actor: 'owner',
          operationId: `fallback-${fault}`,
          points: true,
          after,
        }),
      );
      after = result.after;
    } while (!result.done);
    assert.equal(f.s.tables.projectObjectCatalog.size, 0);
    const request = { projectId: f.s.projectId, state: f.s.state.sha256, version: 2, digests: [], all: true };
    const reply = expandSourceGrants(JSON.parse(await api.read._handler(f.ctx, request)));
    assert.equal(reply.mode, 'catalog');
    assert.equal(reply.rows.length, f.entries.length);
    const expected = new Map(f.entries.map(entry => [entry.sha256, entry]));
    for (const row of reply.rows) {
      const pin = expected.get(row.digest);
      assert(pin, 'every binding belongs to the selected State');
      await readSignedPhysical(pin, row.url);
      expected.delete(row.digest);
    }
    assert.equal(expected.size, 0, 'every hash/size-verified member survives retirement');
    const first = f.entries[0],
      point = [...f.s.tables.projectObjectReceipts.values()].find(
        row => row.key === `source-point:${f.s.projectId}:${first.sha256}`,
      );
    f.s.tables.projectObjectReceipts.delete(point._id);
    await assert.rejects(
      api.read._handler(f.ctx, request),
      'a missing point must not silently omit a selected member',
    );
    t.diagnostic(
      JSON.stringify({ fault, selectedMembers: f.entries.length, retired: result.moved, densePages: 0 }),
    );
  });
