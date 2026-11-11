// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../dist/hash.js';
import { writePhysicalManifest } from '../dist/physical-manifest-write.js';
import { compactSourceGrants, expandSourceGrants } from '../dist/source-grant-wire.js';
import { physicalRuns } from '../dist/physical-manifest-runs.js';
import { rowsFromPhysicalRuns } from '../dist/hosted-actions-state-source.js';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { stateSourceReader } = await import(moduleUrl('../convex/projectStateSourceReader.ts'));
const { stateSourceGrants } = await import(moduleUrl('../convex/projectStateSourceGrants.ts'));
const { presignGet, r2Config, r2Key } = await import(moduleUrl('../convex/r2.ts'));
async function fixture(t, count, packed = true) {
  const r2 = fakeSourceR2(t),
    entries = [],
    files = [];
  const store = bytes => {
    const pin = { sha256: digest(bytes), size: bytes.length };
    r2.objects.set(`/synthetic/v1/p/project/o/${pin.sha256}`, bytes);
    return pin;
  };
  for (let at = 0; at < count; at += 1000) {
    const contents = Array.from({ length: Math.min(1000, count - at) }, (_, index) =>
        Buffer.from(`source ${at + index}`),
      ),
      pack = store(Buffer.concat(contents));
    let offset = 0;
    for (const [index, bytes] of contents.entries()) {
      const pin = store(bytes);
      entries.push({ ...pin, ...(packed ? { pack: { digest: pack.sha256, size: pack.size, offset } } : {}) });
      files.push({ path: `src/${String(at + index).padStart(6, '0')}.txt`, blob: pin.sha256, mode: 'file' });
      offset += bytes.length;
    }
  }
  const state = store(
    Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files,
        message: '',
        at: '2026-01-01T00:00:00.000Z',
      }),
    ),
  );
  const byId = new Map(entries.map(entry => [entry.sha256, entry]));
  const root = await writePhysicalManifest({
    state: state.sha256,
    members: [...byId.keys()],
    parent: null,
    describe: async ids => ids.map(id => byId.get(id)),
    put: store,
  });
  const location = {
    descriptor: { object: state, recipe: null },
    statePhysical: root.pin,
    storageId: null,
    url: await presignGet(r2Config(), r2Key('project', state.sha256)),
  };
  const catalog = [],
    notices = [];
  const resolve = (digests, all = false) =>
    stateSourceGrants({
      projectId: 'project',
      state: state.sha256,
      digests,
      all,
      select: async () => location,
      catalog: async ids => {
        catalog.push(ids);
        return ids.map(id => ({ descriptor: { object: byId.get(id), recipe: null }, url: null }));
      },
      log: message => notices.push(message),
    });
  return { r2, entries, files, state, root, location, resolve, notices, catalog };
}
test('State-bound all signs compact packs with at most64 metadata grants and reconstructs29k verified member rows without catalog reads', async t => {
  const f = await fixture(t, 29000),
    source = stateSourceReader('project');
  const plan = await source.plan(f.state.sha256, f.root.pin);
  assert(plan && plan.chunks.length + 1 <= 64);
  const result = await f.resolve([], true);
  assert.equal(result.mode, 'runs');
  assert.equal(result.runs.length, 29);
  const wire = compactSourceGrants(result);
  assert.deepEqual(expandSourceGrants(wire), result);
  assert(Buffer.byteLength(JSON.stringify(wire)) < 100000);
  const rows = new Map();
  await rowsFromPhysicalRuns(plan, result.runs, fetch, (id, row) => rows.set(id, row), 'whole');
  assert.equal(rows.size, 29000);
  for (const entry of f.entries) {
    const row = rows.get(entry.sha256);
    assert.deepEqual(row.descriptor.object, { sha256: entry.sha256, size: entry.size });
    assert.equal(row.range.offset, entry.pack.offset);
    assert.equal(row.run.length, entry.pack.size);
  }
  assert.equal(f.catalog.length, 0);
  t.diagnostic(
    JSON.stringify({
      files: rows.size,
      metadataGrants: plan.chunks.length + 1,
      grants: result.runs.length,
      replyBytes: Buffer.byteLength(JSON.stringify(wire)),
      r2Gets: f.r2.requests.length,
    }),
  );
});
test('300 raw State members fit compact exact-key replies and nonmembers are refused before catalog signing', async t => {
  const f = await fixture(t, 300, false),
    ids = f.entries.map(entry => entry.sha256);
  const reply = await f.resolve(ids);
  assert.equal(reply.mode, 'rows');
  const wire = compactSourceGrants(reply),
    bytes = Buffer.byteLength(JSON.stringify(wire));
  assert(bytes < 100000, `${bytes} compact reply bytes`);
  assert.deepEqual(expandSourceGrants(JSON.parse(JSON.stringify(wire))), JSON.parse(JSON.stringify(reply)));
  await assert.rejects(
    f.resolve([digest('stored outside selected State')]),
    error => error.code === 'SOURCE_UNAVAILABLE',
  );
  assert.equal(f.catalog.length, 0);
  t.diagnostic(JSON.stringify({ files: 300, grants: reply.rows.length, replyBytes: bytes }));
});
test('missing or corrupt manifests name catalog fallback while retaining exact State membership', async t => {
  const f = await fixture(t, 5),
    id = f.entries[0].sha256;
  delete f.location.statePhysical;
  assert.equal((await f.resolve([id])).mode, 'catalog');
  assert(f.notices.includes('source bindings: catalog (physical manifest missing)'));
  await assert.rejects(
    f.resolve([digest('other history object')]),
    error => error.code === 'SOURCE_UNAVAILABLE',
  );
  assert.equal(f.catalog.length, 1);
  f.location.statePhysical = f.root.pin;
  f.r2.objects.set(`/synthetic/v1/p/project/o/${f.root.pin.sha256}`, Buffer.from('bad root'));
  assert.equal((await f.resolve([id])).mode, 'catalog');
  assert(f.notices.includes('source bindings: catalog (physical manifest invalid or unavailable)'));
});
test('raw and fragmented States name the one-time bounded window rather than granting neighbours', async t => {
  const f = await fixture(t, 3400, false),
    result = await f.resolve([], true);
  assert.equal(result.mode, 'catalog');
  assert.equal(result.rows.length, 3200);
  assert(f.notices.some(message => message.includes('one-time windowed fallback')));
  const pack = digest('shared pack'),
    a = { sha256: digest('a'), size: 2, pack: { digest: pack, size: 5, offset: 0 } },
    b = { sha256: digest('b'), size: 2, pack: { digest: pack, size: 5, offset: 3 } };
  const runs = await physicalRuns([a, b]);
  assert.equal(runs.length, 2);
  assert.deepEqual(
    runs.map(run => [run.offset, run.length]),
    [
      [0, 2],
      [3, 2],
    ],
  );
});
test('grant compression is lossless across range/header query variants and refuses malformed references', () => {
  const url =
    'https://store.invalid/bucket/v1/p/synthetic/o/' +
    'a'.repeat(64) +
    '?X-Amz-Date=20261111T120000Z&X-Amz-SignedHeaders=host%3Brange&X-Amz-Signature=' +
    'b'.repeat(64);
  const value = { rows: [{ url }, { url: url.replace('range', 'host') }], root: url };
  const wire = compactSourceGrants(value);
  assert.equal(wire.templates.length, 2);
  assert.deepEqual(expandSourceGrants(wire), value);
  assert.throws(() =>
    expandSourceGrants({ sourceGrants: 1, templates: [], value: { url: '@0:x:' + 'b'.repeat(64) } }),
  );
});

test('recipe grants prove descendants of one selected member and refuse unrelated stored metadata', async t => {
  const { buildObjectRecipe } = await import('../dist/object-chunks.js');
  const f = await fixture(t, 1, false),
    member = f.entries[0],
    bytes = Buffer.from('source 0'),
    built = buildObjectRecipe(bytes),
    recipe = { sha256: digest(built.bytes), size: built.bytes.length };
  built.objects.set(recipe.sha256, built.bytes);
  for (const [id, body] of built.objects) f.r2.objects.set(`/synthetic/v1/p/project/o/${id}`, body);
  const root = await writePhysicalManifest({
    state: f.state.sha256,
    members: [member.sha256],
    parent: null,
    describe: async () => [{ ...member, recipe }],
    put: async bytes => {
      const pin = { sha256: digest(bytes), size: bytes.length };
      f.r2.objects.set(`/synthetic/v1/p/project/o/${pin.sha256}`, bytes);
      return pin;
    },
  });
  f.location.statePhysical = root.pin;
  let catalog = 0;
  const resolve = digests =>
    stateSourceGrants({
      projectId: 'project',
      state: f.state.sha256,
      object: member.sha256,
      digests,
      select: async () => f.location,
      log: () => {},
      catalog: async ids => {
        catalog++;
        return Promise.all(
          ids.map(async id => ({
            descriptor: { object: { sha256: id, size: built.objects.get(id).length }, recipe: null },
            url: await presignGet(r2Config(), r2Key('project', id)),
          })),
        );
      },
    });
  const reply = await resolve([recipe.sha256, member.sha256]);
  assert.deepEqual(
    reply.rows.map(row => row.descriptor.object.sha256),
    [recipe.sha256, member.sha256],
  );
  assert.equal(catalog, 1);
  await assert.rejects(
    resolve([digest('other stored metadata')]),
    error => error.code === 'SOURCE_UNAVAILABLE',
  );
  assert.equal(catalog, 1, 'a non-descendant never reaches catalog signing');
});

test('a missing raw leaf under its own logical recipe fails explicitly instead of awaiting its pending read', async () => {
  const { stateCatalogReader } = await import(moduleUrl('../convex/projectStateSourceCatalog.ts'));
  const pin = { sha256: digest('raw bytes'), size: 9 },
    bytes = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-object-recipe',
        object: pin,
        tree: { ...pin, height: 0, length: pin.size },
      }),
    ),
    recipe = { sha256: digest(bytes), size: bytes.length };
  const read = stateCatalogReader(
    async target => {
      if (target.sha256 === recipe.sha256) return bytes;
      throw Error('raw leaf missing');
    },
    async () => [{ descriptor: { object: pin, recipe }, url: null }],
  );
  await assert.rejects(read(pin), error => error.code === 'SOURCE_UNAVAILABLE');
});
