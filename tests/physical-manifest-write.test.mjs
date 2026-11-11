// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { digest } from '../dist/hash.js';
import { physicalBucket } from '../dist/physical-manifest-codec.js';
import { PhysicalManifestReader } from '../dist/physical-manifest.js';
import { writePhysicalManifest } from '../dist/physical-manifest-write.js';
function fixture(count) {
  const bindings = new Map(
    Array.from({ length: count }, (_, index) => {
      const sha256 = digest(`file-${index}`);
      return [
        sha256,
        {
          sha256,
          size: 51,
          pack: {
            digest: digest(`pack-${Math.floor(index / 1000)}`),
            size: 51000,
            offset: (index % 1000) * 51,
          },
        },
      ];
    }),
  );
  const objects = new Map(),
    reads = [],
    described = [],
    puts = [];
  const put = async bytes => {
    const pin = { sha256: digest(bytes), size: bytes.length };
    objects.set(pin.sha256, bytes);
    puts.push(pin);
    return pin;
  };
  const read = async pin => {
    reads.push(pin);
    return pin.pack
      ? objects.get(pin.pack.digest).subarray(pin.pack.offset, pin.pack.offset + pin.size)
      : objects.get(pin.sha256);
  };
  const describe = async ids => {
    described.push(...ids);
    return ids.map(id => bindings.get(id) ?? null);
  };
  return {
    bindings,
    objects,
    reads,
    described,
    puts,
    put,
    read,
    describe,
    write: (state, members, parent = null) =>
      writePhysicalManifest({ state, members, parent, describe, put }),
  };
}
test('29k physical writer shares unchanged chunks: eight replacements stay within 150 KB, four PUTs and eight descriptor reads', async t => {
  const f = fixture(29000),
    members = [...f.bindings.keys()],
    firstState = digest('first State');
  const seeded = await f.write(firstState, members);
  assert.equal(f.described.length, 29000, 'only the explicit seed enumerates descriptors');
  assert.equal(f.puts.length, 2, 'seed chunk pack plus one recipe root');
  const parent = await PhysicalManifestReader.open(firstState, seeded.pin, f.read);
  const largest = [...seeded.root.chunks].sort((a, b) => b.size - a.size).slice(0, 16);
  const remove = largest.slice(0, 8).map(chunk => members.find(id => physicalBucket(id) === chunk.bucket));
  const added = [];
  for (const chunk of largest.slice(8)) {
    let index = 0,
      id;
    do {
      id = digest(`replacement-${chunk.bucket}-${index++}`);
    } while (physicalBucket(id) !== chunk.bucket || f.bindings.has(id));
    f.bindings.set(id, { sha256: id, size: 17 });
    added.push(id);
  }
  const next = members.filter(id => !remove.includes(id)).concat(added);
  f.described.length = 0;
  f.puts.length = 0;
  f.reads.length = 0;
  const changed = await f.write(digest('next State'), next, parent);
  assert.deepEqual([...f.described].sort(), added.sort(), 'only new digests reach the catalog');
  assert.equal(changed.changedChunks, 16);
  assert.equal(f.reads.length, 16, 'unchanged membership buckets are not read');
  assert(f.puts.length <= 4);
  const bytes = f.puts.reduce((sum, pin) => sum + pin.size, 0);
  assert(bytes <= 150000, `${bytes} incremental manifest bytes`);
  const old = new Map(seeded.root.chunks.map(chunk => [chunk.bucket, chunk]));
  assert.equal(
    changed.root.chunks.filter(chunk => isDeepStrictEqual(old.get(chunk.bucket), chunk)).length,
    1008,
  );
  const reader = await PhysicalManifestReader.open(digest('next State'), changed.pin, f.read);
  const all = [];
  for await (const entry of reader.all()) all.push(entry.sha256);
  assert.deepEqual(all, next.sort(), 'deleted members never survive in the selected State');
  assert.deepEqual(
    await reader.lookup(remove),
    remove.map(() => null),
  );
  const lookup = await PhysicalManifestReader.open(digest('next State'), changed.pin, f.read);
  f.reads.length = 0;
  assert.deepEqual(
    (await lookup.lookup(added)).map(entry => entry.sha256),
    added,
  );
  assert(f.reads.length <= 8, 'k digests use at most k chunks beyond the root');
  t.diagnostic(
    JSON.stringify({
      files: 29000,
      changedPaths: 8,
      manifestBytes: bytes,
      puts: f.puts.length,
      descriptors: changed.described,
      changedChunks: changed.changedChunks,
    }),
  );
});
test('mode changes, renames and shared blobs reuse every membership chunk; deletions resolve no descriptors', async () => {
  const f = fixture(1500),
    ids = [...f.bindings.keys()],
    seed = await f.write(digest('seed'), ids);
  const parent = await PhysicalManifestReader.open(digest('seed'), seed.pin, f.read);
  f.described.length = 0;
  f.reads.length = 0;
  f.puts.length = 0;
  const same = await f.write(digest('renamed State'), [...ids, ids[0]], parent);
  assert.equal(same.changedChunks, 0);
  assert.equal(f.described.length, 0);
  assert.equal(f.reads.length, 0);
  assert.equal(f.puts.length, 1);
  assert.deepEqual(same.root.chunks, seed.root.chunks);
  f.puts.length = 0;
  const deleted = await f.write(digest('deleted State'), ids.slice(8), parent);
  assert.equal(f.described.length, 0);
  const reader = await PhysicalManifestReader.open(digest('deleted State'), deleted.pin, f.read);
  assert.deepEqual(await reader.lookup(ids.slice(0, 8)), Array(8).fill(null));
});
test('legacy or unavailable bindings do not publish a partial manifest; changed publication pins fail closed', async () => {
  const f = fixture(1);
  assert.equal(await f.write(digest('State'), [digest('legacy Convex-only object')]), null);
  assert.equal(f.puts.length, 0);
  await assert.rejects(
    writePhysicalManifest({
      state: digest('State'),
      members: [...f.bindings.keys()],
      parent: null,
      describe: f.describe,
      put: async bytes => ({ sha256: digest('wrong'), size: bytes.length }),
    }),
    error => error.code === 'SOURCE_HASH_MISMATCH',
  );
});
