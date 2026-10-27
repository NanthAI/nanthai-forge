// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { fixture, upload } from './project-exchange-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
const { objectRange } = await import(moduleUrl('../convex/projectObjectContent.ts'));
const { exchangeObjectReader } = await import(moduleUrl('../convex/projectExchangeReader.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;

async function recipe(s, count = 64, group = count, tag = 0, changeLast = false) {
  const parts = [],
    leaves = [];
  for (let i = 0; i < count; i++) {
    const bytes = Buffer.alloc(8192, tag);
    bytes.writeUInt32LE(i);
    if (changeLast && i === count - 1) bytes[bytes.length - 1] = 1;
    parts.push(bytes);
    leaves.push({ ...(await upload(s, bytes)), height: 0, length: bytes.length });
  }
  const page = async children => {
    const pin = await upload(
      s,
      Buffer.from(JSON.stringify({ kind: 'forge-byte-tree', schema: 1, children })),
    );
    return {
      ...pin,
      height: Math.max(...children.map(c => c.height)) + 1,
      length: children.reduce((n, c) => n + c.length, 0),
    };
  };
  let refs = leaves;
  if (group < count) {
    refs = [];
    for (let i = 0; i < count; i += group) refs.push(await page(leaves.slice(i, i + group)));
  }
  const tree = await page(refs),
    bytes = Buffer.concat(parts),
    pin = { sha256: digest(bytes), size: bytes.length };
  const body = await upload(
    s,
    Buffer.from(JSON.stringify({ kind: 'forge-object-recipe', schema: 1, object: pin, tree })),
  );
  const row = {
    _id: `recipe-${pin.sha256}`,
    projectId: 'project',
    digest: pin.sha256,
    size: pin.size,
    recipe: { digest: body.sha256, size: body.size },
  };
  s.tables.projectObjects.set(row._id, row);
  return { row, pin, bytes, leaves, tree };
}
function measure(s) {
  const run = s.ctx.runQuery,
    windows = [];
  s.ctx.runQuery = (ref, args) => {
    if (getFunctionName(ref) === 'projectObjects:resolve') windows.push(args.digests);
    return run(ref, args);
  };
  return windows;
}

test('recipe and ranged reads resolve bounded frontiers, including multiple tree levels and repeated leaves', async t => {
  const s = fixture(),
    built = await recipe(s, 128, 16),
    windows = measure(s);
  const reader = exchangeObjectReader(s.ctx, false, 0);
  assert.deepEqual(await reader.read('project', 'owner', [built.pin]), [built.bytes]);
  assert.equal(windows.length, 9); // Transitions combine the previous after-check with the next before-check.
  assert(windows.every(p => p.length <= 100));
  assert(windows.some(p => p.length === 100));
  windows.length = 0;
  assert.deepEqual(
    Buffer.from(await objectRange(s.ctx, built.row, 'owner', 8191, 17000)),
    built.bytes.subarray(8191, 8191 + 17000),
  );
  assert.equal(windows.length, 5); // Body, root, one page, intersecting leaves, then the final after-check.
  assert.equal(windows.at(-1).length, 4);
  t.diagnostic(JSON.stringify({ fullResolves: 9, rangeResolves: 5, maxPins: 100, retainedByteCache: 0 }));
});

test('recipe rows in one reader page share first-level and leaf resolution windows', async () => {
  const s = fixture(),
    a = await recipe(s, 16, 16, 1),
    b = await recipe(s, 16, 16, 2),
    windows = measure(s);
  assert.deepEqual(await exchangeObjectReader(s.ctx).read('project', 'owner', [a.pin, b.pin]), [
    a.bytes,
    b.bytes,
  ]);
  assert.equal(windows.length, 5); // One initial logical resolve, shared transitions and one final after-check.
  assert.deepEqual(
    windows.map(p => p.length),
    [2, 2, 4, 34, 34],
  );
});

test('shared recipe subtrees read and expand once across a State window', async () => {
  const s = fixture(),
    built = await recipe(s, 128, 16),
    changed = await recipe(s, 128, 16, 0, true),
    windows = measure(s);
  const read = s.ctx.storage.get,
    reads = new Map();
  s.ctx.storage.get = async id => {
    reads.set(id, (reads.get(id) ?? 0) + 1);
    return read(id);
  };
  const values = await exchangeObjectReader(s.ctx, false, 0).read('project', 'owner', [
    built.pin,
    changed.pin,
  ]);
  assert.deepEqual(values, [built.bytes, changed.bytes]);
  assert(windows.length <= 11, `one shared tree walk, got ${windows.length} resolves`);
  for (const leaf of built.leaves) {
    const row = [...s.tables.projectObjects.values()].find(r => r.digest === leaf.sha256);
    assert.equal(reads.get(row.storageId), 1);
  }
});

test('shared subtrees at different depths wait for one common height frontier', async () => {
  const s = fixture(),
    wide = await recipe(s, 128, 16),
    narrow = await recipe(s, 16, 16);
  const node = [...s.tables.projectObjects.values()].find(row => row.digest === narrow.tree.sha256);
  const get = s.ctx.storage.get;
  let reads = 0;
  s.ctx.storage.get = async id => {
    if (id === node.storageId) reads++;
    return get(id);
  };
  assert.deepEqual(
    await exchangeObjectReader(s.ctx, false, 0).read('project', 'owner', [wide.pin, narrow.pin]),
    [wide.bytes, narrow.bytes],
  );
  assert.equal(reads, 1);
});

test('batched content and ranges reject tampering, wrong size, recipe ancestry cycles and cross-project nodes', async () => {
  for (const fault of ['tamper', 'size', 'cycle', 'project']) {
    for (const range of [false, true]) {
      const s = fixture(),
        built = await recipe(s, 4);
      const leaf = [...s.tables.projectObjects.values()].find(row => row.digest === built.leaves[0].sha256);
      if (fault === 'tamper') s.files.get(leaf.storageId).blob = new Blob(['tampered']);
      if (fault === 'size') leaf.size++;
      if (fault === 'cycle') {
        delete leaf.storageId;
        leaf.recipe = { digest: leaf.digest, size: leaf.size };
      }
      if (fault === 'project') leaf.projectId = 'another-project';
      const read = () =>
        range
          ? objectRange(s.ctx, built.row, 'owner', 0)
          : exchangeObjectReader(s.ctx).read('project', 'owner', [built.pin]);
      await assert.rejects(read(), code('INVALID_WORK_BACKUP'), `${fault}, range=${range}`);
    }
  }
});

test('a resolve window rechecks availability and authority after leaf IO without cached access', async () => {
  for (const fault of ['access', 'availability']) {
    for (const range of [false, true]) {
      const s = fixture(),
        built = await recipe(s, 4),
        reader = exchangeObjectReader(s.ctx);
      await reader.read('project', 'owner', [built.pin]);
      const get = s.ctx.storage.get;
      const leaf = [...s.tables.projectObjects.values()].find(row => row.digest === built.leaves[0].sha256);
      s.ctx.storage.get = async id => {
        const blob = await get(id);
        if (id === leaf.storageId) {
          if (fault === 'access') s.tables.hostedProjects.get('project').owner = 'other';
          else leaf.removed = true;
        }
        return blob;
      };
      await assert.rejects(
        () =>
          range ? objectRange(s.ctx, built.row, 'owner', 0) : reader.read('project', 'owner', [built.pin]),
        code(fault === 'access' ? 'PROJECT_UNAVAILABLE' : 'INVALID_WORK_BACKUP'),
      );
    }
  }
});

test('nested recipe nodes and repeated leaves retain exact bytes without inheriting another branch ancestry', async () => {
  const s = fixture(),
    built = await recipe(s, 16);
  const leaf = [...s.tables.projectObjects.values()].find(row => row.digest === built.leaves[0].sha256);
  const chunk = Buffer.alloc(4096),
    child = await upload(s, chunk);
  // The selected original leaf is 8 KiB of zero bytes; bind it to two occurrences
  // of the same 4 KiB raw leaf, so its node is itself recipe-stored.
  const children = Array.from({ length: 2 }, () => ({ ...child, height: 0, length: child.size }));
  const page = await upload(s, Buffer.from(JSON.stringify({ kind: 'forge-byte-tree', schema: 1, children })));
  const tree = { ...page, height: 1, length: leaf.size };
  const body = await upload(
    s,
    Buffer.from(
      JSON.stringify({
        kind: 'forge-object-recipe',
        schema: 1,
        object: { sha256: leaf.digest, size: leaf.size },
        tree,
      }),
    ),
  );
  delete leaf.storageId;
  leaf.recipe = { digest: body.sha256, size: body.size };
  const windows = measure(s);
  assert.deepEqual(await exchangeObjectReader(s.ctx).read('project', 'owner', [built.pin]), [built.bytes]);
  assert.deepEqual(
    Buffer.from(await objectRange(s.ctx, built.row, 'owner', 0, 20000)),
    built.bytes.subarray(0, 20000),
  );
  assert(windows.every(pins => pins.length <= 100));
});
