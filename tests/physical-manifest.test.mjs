// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../dist/hash.js';
import {
  encodePhysicalEntries,
  decodePhysicalEntries,
  physicalBucket,
} from '../dist/physical-manifest-codec.js';
import { PhysicalManifestReader, manifestOrCatalog } from '../dist/physical-manifest.js';
import { encodePhysicalRoot } from '../dist/physical-manifest-root.js';
import { moduleUrl } from './convex-module.mjs';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
const { convexSourceTransport } = await import(moduleUrl('../convex/projectConvexSourceTransport.ts'));
const state = digest('selected State');
function fixture(entries) {
  const objects = new Map(),
    reads = [];
  const put = bytes => {
    const pin = { sha256: digest(bytes), size: bytes.length };
    objects.set(pin.sha256, bytes);
    return pin;
  };
  const groups = new Map();
  for (const entry of [...entries].sort((a, b) => a.sha256.localeCompare(b.sha256))) {
    const bucket = physicalBucket(entry.sha256),
      group = groups.get(bucket) ?? [];
    group.push(entry);
    groups.set(bucket, group);
  }
  const root = {
    schema: 1,
    kind: 'forge-physical-manifest',
    state,
    chunks: [...groups]
      .sort(([a], [b]) => a - b)
      .map(([bucket, entries]) => ({ bucket, ...put(encodePhysicalEntries(entries)) })),
  };
  const pin = put(Buffer.from(JSON.stringify(root)));
  const read = async pin => {
    reads.push(pin.sha256);
    return objects.get(pin.sha256);
  };
  return { objects, reads, root, pin, put, read };
}
const raw = { sha256: digest('raw'), size: 3 };
const packed = { sha256: digest('packed'), size: 6, pack: { digest: digest('pack'), size: 40, offset: 8 } };
const recipe = {
  sha256: digest('recipe'),
  size: 7,
  recipe: { sha256: digest('recipe metadata'), size: 200 },
};
test('physical bindings retain raw, packed and recipe identity; k lookups read at most k+1 chunks', async () => {
  const f = fixture([raw, packed, recipe]),
    reader = await PhysicalManifestReader.open(state, f.pin, f.read);
  assert.deepEqual(await reader.lookup([packed.sha256, raw.sha256, packed.sha256]), [packed, raw, packed]);
  assert(f.reads.length <= 3, 'one root plus at most one chunk per distinct digest');
  const before = f.reads.length;
  assert.deepEqual(await reader.lookup([packed.sha256]), [packed]);
  assert.equal(f.reads.length, before, 'only the authorized operation reuses verified bindings');
  const entries = [];
  for await (const entry of reader.all()) entries.push(entry);
  assert.deepEqual(
    entries,
    [raw, packed, recipe].sort((a, b) => a.sha256.localeCompare(b.sha256)),
  );
  assert.deepEqual(await reader.lookup([digest('absent')]), [null]);
});
for (const corruption of ['root hash', 'root size', 'State pin', 'chunk hash', 'chunk size', 'bucket order'])
  test(`physical manifest ${corruption} falls back explicitly to the same catalog digests`, async () => {
    const f = fixture([raw, packed]),
      logs = [];
    let pin = f.pin;
    if (corruption === 'root hash') f.objects.set(pin.sha256, Buffer.from('invalid'));
    if (corruption === 'root size') pin = { ...pin, size: pin.size + 1 };
    if (corruption === 'State pin') f.root.state = digest('other State');
    if (corruption === 'chunk hash') f.objects.set(f.root.chunks[0].sha256, Buffer.from('invalid'));
    if (corruption === 'chunk size') f.root.chunks[0].size++;
    if (corruption === 'bucket order') f.root.chunks.reverse();
    if (['State pin', 'chunk size', 'bucket order'].includes(corruption))
      pin = f.put(Buffer.from(JSON.stringify(f.root)));
    const ids = [raw.sha256, packed.sha256];
    let catalog = 0;
    const result = await manifestOrCatalog(
      async () => (await PhysicalManifestReader.open(state, pin, f.read)).lookup(ids),
      async () => {
        catalog++;
        return ids;
      },
      message => logs.push(message),
    );
    assert.deepEqual(result, ids);
    assert.equal(catalog, 1);
    assert.deepEqual(logs, ['source bindings: catalog (physical manifest invalid or unavailable)']);
  });
test('missing manifest names catalog fallback; catalog errors propagate without a retry or revision substitution', async () => {
  const logs = [],
    error = new Error('catalog unavailable');
  await assert.rejects(
    manifestOrCatalog(
      async () => null,
      async () => {
        throw error;
      },
      message => logs.push(message),
    ),
    value => value === error,
  );
  assert.deepEqual(logs, ['source bindings: catalog (physical manifest missing)']);
});

test('binary recipe roots preserve shared pack ranges and membership fingerprints before writer rollout', async () => {
  const f = fixture([raw, packed, recipe]);
  const bytes = Buffer.concat(f.root.chunks.map(chunk => Buffer.from(f.objects.get(chunk.sha256))));
  const pack = f.put(bytes);
  let offset = 0;
  f.root.chunks = f.root.chunks.map(chunk => {
    const members = decodePhysicalEntries(f.objects.get(chunk.sha256), chunk.bucket)
      .map(entry => entry.sha256)
      .join('');
    const next = {
      ...chunk,
      members: digest(members),
      pack: { digest: pack.sha256, size: pack.size, offset },
    };
    offset += chunk.size;
    return next;
  });
  const root = f.put(encodePhysicalRoot(f.root));
  const read = async pin =>
    pin.pack
      ? f.objects.get(pin.pack.digest).subarray(pin.pack.offset, pin.pack.offset + pin.size)
      : f.read(pin);
  const reader = await PhysicalManifestReader.open(state, root, read);
  assert.deepEqual(reader.root, f.root);
  assert.deepEqual(await reader.lookup([raw.sha256]), [raw]);
  for (const corrupt of [
    Uint8Array.from([...f.objects.get(root.sha256), 0]),
    f.objects.get(root.sha256).subarray(0, root.size - 1),
  ]) {
    const pin = f.put(corrupt);
    await assert.rejects(PhysicalManifestReader.open(state, pin, f.read));
  }
  f.root.chunks[0].members = digest('wrong membership');
  const wrong = await PhysicalManifestReader.open(state, f.put(encodePhysicalRoot(f.root)), read);
  const id = decodePhysicalEntries(f.objects.get(f.root.chunks[0].sha256), f.root.chunks[0].bucket)[0].sha256;
  await assert.rejects(wrong.lookup([id]), error => error.code === 'SOURCE_HASH_MISMATCH');
});
test('physical chunks refuse truncation, trailing bytes, duplicate members, wrong buckets and overflowing intervals', () => {
  const bytes = encodePhysicalEntries([packed]);
  for (const bad of [bytes.subarray(0, bytes.length - 1), Uint8Array.from([...bytes, 0])])
    assert.throws(() => decodePhysicalEntries(bad, physicalBucket(packed.sha256)));
  assert.throws(() => decodePhysicalEntries(bytes, (physicalBucket(packed.sha256) + 1) % 256));
  assert.throws(() => encodePhysicalEntries([raw, raw]));
  assert.throws(() => encodePhysicalEntries([{ ...packed, pack: { ...packed.pack, offset: 39 } }]));
  assert.throws(() => decodePhysicalEntries(Uint8Array.from([70, 80, 77, 1, ...Array(10).fill(255)]), 0));
});
test('trusted source transport resolves manifest members without a descriptor RPC and retains verified body reads', async t => {
  const r2 = fakeSourceR2(t),
    f = fixture([raw, packed, recipe]);
  for (const [id, bytes] of f.objects) r2.objects.set(`/synthetic/v1/p/project/o/${id}`, bytes);
  r2.objects.set(`/synthetic/v1/p/project/o/${raw.sha256}`, Buffer.from('raw'));
  let calls = 0;
  const { io } = convexSourceTransport(
    {
      runMutation: async () => {
        calls++;
        throw Error('unexpected catalog call');
      },
    },
    { projectId: 'project', jobId: 'job', step: 0 },
    [
      {
        descriptor: { object: { sha256: state, size: 100 }, recipe: null },
        storageId: null,
        url: null,
        statePhysical: f.pin,
      },
    ],
  );
  const result = await io.describeBatch([raw.sha256, packed.sha256, recipe.sha256]);
  assert.deepEqual(
    result,
    [raw, packed, recipe].map(entry => ({
      object: { sha256: entry.sha256, size: entry.size },
      recipe: entry.recipe ?? null,
    })),
  );
  const bytes = [];
  for await (const part of await io.read(raw)) bytes.push(part);
  assert.equal(Buffer.concat(bytes).toString(), 'raw');
  assert.equal(calls, 0);
  assert.equal(r2.requests.length, f.root.chunks.length + 2, 'root, required chunks, and one blob');
});
test('trusted source transport uses the catalog for invalid manifests and nonmember protocol objects', async t => {
  const r2 = fakeSourceR2(t),
    f = fixture([raw]);
  for (const [id, bytes] of f.objects) r2.objects.set(`/synthetic/v1/p/project/o/${id}`, bytes);
  const metadata = { sha256: digest('save page'), size: 9 },
    requested = [];
  const { io } = convexSourceTransport(
    {
      runMutation: async (_name, args) => {
        requested.push(...args.digests);
        return JSON.stringify(
          args.digests.map(sha256 => ({
            descriptor: { object: { sha256, size: 9 }, recipe: null },
            storageId: null,
            url: 'https://synthetic.invalid/object',
          })),
        );
      },
    },
    { projectId: 'project', jobId: 'job', step: 0 },
    [
      {
        descriptor: { object: { sha256: state, size: 100 }, recipe: null },
        storageId: null,
        url: null,
        statePhysical: f.pin,
      },
    ],
  );
  assert.equal((await io.describeBatch([metadata.sha256]))[0].object.sha256, metadata.sha256);
  r2.objects.set(`/synthetic/v1/p/project/o/${f.root.chunks[0].sha256}`, Buffer.from('corrupt'));
  assert.equal((await io.describeBatch([raw.sha256]))[0].object.sha256, raw.sha256);
  assert.deepEqual(requested, [metadata.sha256, raw.sha256]);
});
