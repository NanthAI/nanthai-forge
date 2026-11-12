// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../dist/hash.js';
import { PhysicalManifestReader } from '../dist/physical-manifest.js';
import { physicalBucket, encodePhysicalEntries } from '../dist/physical-manifest-codec.js';
import { physicalKey } from '../dist/physical-manifest-binary.js';
import { encodePhysicalRoot } from '../dist/physical-manifest-root.js';
import { repairPhysicalRoot } from '../dist/physical-manifest-write.js';
function fixture() {
  const objects = new Map(),
    reads = [],
    puts = [],
    state = digest('selected State');
  const entries = Array.from({ length: 8 }, (_, i) => ({ sha256: digest(`repair-${i}`), size: i + 1 })).sort(
    (a, b) => physicalBucket(a.sha256) - physicalBucket(b.sha256),
  );
  assert.equal(new Set(entries.map(entry => physicalBucket(entry.sha256))).size, 8);
  const bodies = entries.map(entry => encodePhysicalEntries([entry]));
  const put = async bytes => {
    const pin = { sha256: digest(bytes), size: bytes.length };
    objects.set(pin.sha256, bytes);
    puts.push(pin);
    return pin;
  };
  const read = async pin => {
    reads.push(pin);
    const bytes = objects.get(physicalKey(pin.pack?.digest ?? pin.sha256, pin.pack?.nonce));
    return pin.pack ? bytes.subarray(pin.pack.offset, pin.pack.offset + pin.size) : bytes;
  };
  const root = chunks => ({ schema: 1, kind: 'forge-physical-manifest', state, chunks });
  const open = async value => PhysicalManifestReader.open(state, await put(encodePhysicalRoot(value)), read);
  return { state, entries, bodies, objects, reads, puts, put, read, root, open };
}
test('repair copies failing-key live chunks with one range, ignores gap bytes, preserves other pins and is deterministic', async () => {
  const f = fixture(),
    pack = await f.put(Buffer.concat(f.bodies.slice(0, 3))),
    raw = await f.put(f.bodies[3]),
    chunks = [0, 2].map(i => ({
      bucket: physicalBucket(f.entries[i].sha256),
      sha256: digest(f.bodies[i]),
      size: f.bodies[i].length,
      pack: {
        digest: pack.sha256,
        size: pack.size,
        offset: f.bodies.slice(0, i).reduce((sum, bytes) => sum + bytes.length, 0),
      },
    }));
  const own = { bucket: physicalBucket(f.entries[3].sha256), ...raw };
  chunks.push(own);
  const head = await f.open(f.root(chunks)),
    main = f.root([]);
  f.reads.length = 0;
  f.puts.length = 0;
  const result = await repairPhysicalRoot({ state: f.state, head, main, put: f.put });
  assert.equal(f.reads.length, 1, 'one read for both live chunks in the failing key');
  assert.equal(f.reads[0].size, pack.size, 'range covers the first through last live chunk');
  assert.equal(f.puts.length, 2);
  assert.deepEqual(
    result.root.chunks.find(pin => pin.bucket === own.bucket),
    own,
  );
  const reader = await PhysicalManifestReader.open(f.state, result.pin, f.read);
  assert.deepEqual(await reader.lookup([f.entries[1].sha256]), [null], 'gap bytes never become members');
  assert.equal((await reader.lookup([f.entries[0].sha256]))[0].sha256, f.entries[0].sha256);
  const retry = await repairPhysicalRoot({ state: f.state, head, main, put: f.put });
  assert.deepEqual(retry.pin, result.pin);
  assert.equal(await repairPhysicalRoot({ state: f.state, head: reader, main, put: f.put }), null);
});
test('repair distinguishes nonce copies of the same pack and keeps a key only when main names that exact copy', async () => {
  const f = fixture(),
    pack = await f.put(Buffer.concat(f.bodies.slice(0, 3))),
    a = '00000000-0000-4000-8000-000000000001',
    b = '00000000-0000-4000-8000-000000000002';
  f.objects.set(physicalKey(pack.sha256, a), f.objects.get(pack.sha256));
  const chunk = {
      bucket: physicalBucket(f.entries[0].sha256),
      sha256: digest(f.bodies[0]),
      size: f.bodies[0].length,
      pack: { digest: pack.sha256, size: pack.size, offset: 0, nonce: a },
    },
    head = await f.open(f.root([chunk]));
  assert.equal(await repairPhysicalRoot({ state: f.state, head, main: f.root([chunk]), put: f.put }), null);
  assert(
    await repairPhysicalRoot({
      state: f.state,
      head,
      main: f.root([{ ...chunk, pack: { ...chunk.pack, nonce: b } }]),
      put: f.put,
    }),
  );
});
test('repair refuses a corrupt live chunk and a changed publication pin before binding a root', async () => {
  const f = fixture(),
    pack = await f.put(Buffer.concat(f.bodies.slice(0, 2))),
    chunk = {
      bucket: physicalBucket(f.entries[0].sha256),
      sha256: digest(f.bodies[0]),
      size: f.bodies[0].length,
      pack: { digest: pack.sha256, size: pack.size, offset: 0 },
    },
    head = await f.open(f.root([chunk]));
  await assert.rejects(
    repairPhysicalRoot({
      state: f.state,
      head,
      main: f.root([]),
      put: async bytes => ({ sha256: digest('wrong output'), size: bytes.length }),
    }),
    error => error.code === 'SOURCE_HASH_MISMATCH',
  );
  const bytes = Uint8Array.from(f.objects.get(pack.sha256));
  bytes[0] ^= 1;
  f.objects.set(pack.sha256, bytes);
  f.puts.length = 0;
  await assert.rejects(
    repairPhysicalRoot({ state: f.state, head, main: f.root([]), put: f.put }),
    error => error.code === 'SOURCE_HASH_MISMATCH',
  );
  assert.equal(f.puts.length, 0);
});
