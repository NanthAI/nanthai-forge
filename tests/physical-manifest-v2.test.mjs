// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../dist/hash.js';
import { PhysicalManifestReader } from '../dist/physical-manifest.js';
import {
  encodePhysicalEntries,
  decodePhysicalEntries,
  physicalBucket,
} from '../dist/physical-manifest-codec.js';
import { encodePhysicalRoot, decodePhysicalRoot } from '../dist/physical-manifest-root.js';
import { physicalKey } from '../dist/physical-manifest-binary.js';
import { physicalRuns, physicalRunFor } from '../dist/physical-manifest-runs.js';
import { downloadPhysicalManifest } from '../dist/physical-manifest-download.js';
import { compactSourceGrants, expandSourceGrants } from '../dist/source-grant-wire.js';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { stateSourceReader } = await import(moduleUrl('../convex/projectStateSourceReader.ts'));
const { stateSourceGrants } = await import(moduleUrl('../convex/projectStateSourceGrants.ts'));
const { convexSourceTransport } = await import(moduleUrl('../convex/projectConvexSourceTransport.ts'));
const nonceA = '00000000-0000-4000-8000-000000000001';
const nonceB = '00000000-0000-4000-8000-000000000002';
const state = digest('selected State');
function fixture(t, entries, { fingerprints = false, split = false } = {}) {
  const r2 = fakeSourceR2(t),
    objects = new Map();
  const store = (bytes, nonce) => {
    const pin = { sha256: digest(bytes), size: bytes.length, ...(nonce ? { nonce } : {}) };
    objects.set(physicalKey(pin.sha256, nonce), bytes);
    r2.objects.set(`/synthetic/v1/p/project/o/${physicalKey(pin.sha256, nonce)}`, bytes);
    return pin;
  };
  const groups = new Map();
  for (const entry of entries) {
    const bucket = physicalBucket(entry.sha256),
      group = groups.get(bucket) ?? [];
    group.push(entry);
    groups.set(bucket, group);
  }
  const chunks = [...groups]
    .sort(([a], [b]) => a - b)
    .map(([bucket, group]) => {
      group.sort((a, b) => a.sha256.localeCompare(b.sha256));
      const bytes = encodePhysicalEntries(group),
        pin = store(bytes, split ? undefined : nonceA);
      return {
        bucket,
        sha256: pin.sha256,
        size: pin.size,
        ...(fingerprints ? { members: digest(group.map(entry => entry.sha256).join('')) } : {}),
        pack: { digest: pin.sha256, size: pin.size, offset: 0, ...(pin.nonce ? { nonce: pin.nonce } : {}) },
      };
    });
  const root = { schema: 1, kind: 'forge-physical-manifest', state, chunks },
    pin = store(encodePhysicalRoot(root));
  const reads = [];
  const read = async pin => {
    reads.push(pin);
    const bytes = objects.get(physicalKey(pin.pack?.digest ?? pin.sha256, pin.pack?.nonce ?? pin.nonce));
    return pin.pack ? bytes.subarray(pin.pack.offset, pin.pack.offset + pin.size) : bytes;
  };
  return { r2, store, root, pin, reads, read };
}
test('FPR2 without fingerprints verifies exact State and chunk hashes with k+1 point reads', async t => {
  const entries = Array.from({ length: 100 }, (_, index) => ({ sha256: digest(`member-${index}`), size: 3 }));
  const f = fixture(t, entries),
    reader = await PhysicalManifestReader.open(state, f.pin, f.read);
  assert.deepEqual(reader.root, f.root);
  assert.deepEqual(await reader.lookup(entries.slice(0, 4).map(entry => entry.sha256)), entries.slice(0, 4));
  assert(f.reads.length <= 5);
  await assert.rejects(PhysicalManifestReader.open(digest('wrong State'), f.pin, f.read));
  const damaged = Uint8Array.from(encodePhysicalRoot(f.root));
  damaged[damaged.length - 1] ^= 1;
  await assert.rejects(PhysicalManifestReader.open(state, f.pin, async () => damaged));
  for (const bytes of [
    encodePhysicalRoot(f.root).subarray(0, f.pin.size - 1),
    Uint8Array.from([...encodePhysicalRoot(f.root), 0]),
  ])
    assert.throws(() => decodePhysicalRoot(bytes));
});
test('FPR1 and mixed FPR2 keep fingerprint validation; FPM1 stays compatible with canonical readers', async t => {
  const entry = { sha256: digest('member'), size: 3 },
    f = fixture(t, [entry], { fingerprints: true, split: true });
  assert.equal(encodePhysicalRoot(f.root)[3], 1);
  assert.equal(encodePhysicalEntries([entry])[3], 1);
  const root = {
    ...f.root,
    chunks: f.root.chunks.map(chunk => ({ ...chunk, members: digest('wrong membership') })),
  };
  const bad = await PhysicalManifestReader.open(state, f.store(encodePhysicalRoot(root)), f.read);
  await assert.rejects(bad.lookup([entry.sha256]), error => error.code === 'SOURCE_HASH_MISMATCH');
  const extra = { sha256: digest('another member'), size: 5 },
    mixed = fixture(t, [entry, extra]);
  mixed.root.chunks[0].members = digest('wrong membership');
  const reader = await PhysicalManifestReader.open(
    state,
    mixed.store(encodePhysicalRoot(mixed.root)),
    mixed.read,
  );
  await assert.rejects(
    reader.lookup([
      mixed.root.chunks[0].bucket === physicalBucket(entry.sha256) ? entry.sha256 : extra.sha256,
    ]),
  );
});
test('FPM2 retains raw and packed nonce keys and refuses truncated or arbitrary key suffixes', () => {
  const entries = [
    { sha256: digest('raw nonce'), size: 3, nonce: nonceA },
    {
      sha256: digest('packed nonce'),
      size: 4,
      pack: { digest: digest('pack'), size: 9, offset: 2, nonce: nonceB },
    },
    { sha256: digest('recipe'), size: 5, recipe: { sha256: digest('recipe root'), size: 20 } },
  ];
  for (const entry of entries) {
    const encoded = encodePhysicalEntries([entry]);
    assert.deepEqual(decodePhysicalEntries(encoded, physicalBucket(entry.sha256)), [entry]);
    assert.throws(() =>
      decodePhysicalEntries(encoded.subarray(0, encoded.length - 1), physicalBucket(entry.sha256)),
    );
  }
  for (const nonce of ['', '../other', 'ABCDEFAB-0000-4000-8000-000000000001', `${nonceA}/extra`])
    assert.throws(() => encodePhysicalEntries([{ sha256: digest('member'), size: 3, nonce }]));
});
test('nonce copies of one pack never coalesce or match grants for a different exact key', async () => {
  const pack = { digest: digest('ab'), size: 2 };
  const a = { sha256: digest('a'), size: 1, pack: { ...pack, offset: 0, nonce: nonceA } };
  const b = { sha256: digest('b'), size: 1, pack: { ...pack, offset: 1, nonce: nonceB } };
  const runs = await physicalRuns([a, b]);
  assert.equal(runs.length, 2);
  assert.equal(physicalRunFor(runs, a).nonce, nonceA);
  assert.equal(physicalRunFor(runs, b).nonce, nonceB);
  assert.equal(physicalRunFor([runs[0]], b), undefined);
});
test('trusted workers and State-bound signers use exact raw and pack nonce keys without catalog calls', async t => {
  const a = Buffer.from('a'),
    b = Buffer.from('b'),
    raw = Buffer.from('raw'),
    pack = Buffer.concat([a, b]);
  const entries = [
    {
      sha256: digest(a),
      size: a.length,
      pack: { digest: digest(pack), size: pack.length, offset: 0, nonce: nonceA },
    },
    {
      sha256: digest(b),
      size: b.length,
      pack: { digest: digest(pack), size: pack.length, offset: 1, nonce: nonceB },
    },
    { sha256: digest(raw), size: raw.length, nonce: nonceB },
  ];
  const f = fixture(t, entries);
  f.store(pack, nonceA);
  f.store(pack, nonceB);
  f.store(raw, nonceB);
  const location = {
    descriptor: { object: { sha256: state, size: 100 }, recipe: null },
    statePhysical: f.pin,
    storageId: null,
    url: null,
  };
  let catalog = 0;
  const { io } = convexSourceTransport(
    {
      runMutation: async () => {
        catalog++;
        throw Error('catalog unexpected');
      },
    },
    { projectId: 'project', jobId: 'job', step: 0 },
    [location],
  );
  const described = await io.describeBatch(entries.map(entry => entry.sha256));
  for (const [index, entry] of entries.entries()) {
    assert.equal(described[index].object.sha256, entry.sha256);
    const parts = [];
    for await (const part of await io.read({ sha256: entry.sha256, size: entry.size })) parts.push(part);
    assert.equal(digest(Buffer.concat(parts)), entry.sha256);
  }
  const source = stateSourceReader('project'),
    plan = await source.plan(state, f.pin);
  assert(plan);
  const downloaded = await downloadPhysicalManifest(plan, fetch);
  assert.deepEqual(await downloaded.lookup(entries.map(entry => entry.sha256)), entries);
  // Removing the nonce from a metadata grant cannot make the same digest a key match.
  const wrongPlan = { ...plan, chunks: plan.chunks.map(({ nonce: _nonce, ...run }) => run) };
  const wrong = await downloadPhysicalManifest(wrongPlan, fetch);
  await assert.rejects(wrong.lookup([entries[0].sha256]), error => error.code === 'SOURCE_HASH_MISMATCH');
  const result = await stateSourceGrants({
    projectId: 'project',
    state,
    digests: entries.map(entry => entry.sha256),
    runs: true,
    select: async () => location,
    catalog: async () => {
      catalog++;
      throw Error('catalog unexpected');
    },
    log: () => {},
  });
  assert.equal(result.mode, 'rows');
  for (const [index, entry] of entries.entries()) {
    const url = result.rows[index].url;
    assert(
      new URL(url).pathname.endsWith(
        '/' + physicalKey(entry.pack?.digest ?? entry.sha256, entry.pack?.nonce ?? entry.nonce),
      ),
    );
    const response = await fetch(url, {
      headers: entry.pack
        ? { Range: `bytes=${entry.pack.offset}-${entry.pack.offset + entry.size - 1}` }
        : {},
    });
    assert.equal(digest(new Uint8Array(await response.arrayBuffer())), entry.sha256);
  }
  assert.equal(catalog, 0);
  assert.deepEqual(expandSourceGrants(compactSourceGrants(result)), result);
});
test('300 independent nonce grants share the URL template and stay below the100KB reply budget', () => {
  const rows = Array.from({ length: 300 }, (_, index) => ({
    url: `https://store.invalid/bucket/v1/p/project/o/${digest(String(index))}/u/${nonceA}?X-Amz-Date=20261111T120000Z&X-Amz-SignedHeaders=host&X-Amz-Signature=${digest('signature' + index)}`,
  }));
  const wire = compactSourceGrants({ rows });
  assert.equal(wire.templates.length, 1);
  assert(Buffer.byteLength(JSON.stringify(wire)) < 100000);
  assert.deepEqual(expandSourceGrants(wire), { rows });
});
test('29k long-history FPR2 preserves all1024chunks and k+1 lookup without claiming the64grant writer qualification', async t => {
  const entries = Array.from({ length: 29000 }, (_, index) => ({
    sha256: digest(`file-${index}`),
    size: 51,
    pack: { digest: digest(`pack-${Math.floor(index / 1000)}`), size: 51000, offset: (index % 1000) * 51 },
  }));
  const f = fixture(t, entries, { split: true }),
    reader = await PhysicalManifestReader.open(state, f.pin, f.read);
  assert.equal(reader.root.chunks.length, 1024);
  assert(f.pin.size <= 76585, `${f.pin.size} optional-fingerprint root bytes`);
  const selected = entries.slice(0, 8);
  assert.deepEqual(await reader.lookup(selected.map(entry => entry.sha256)), selected);
  assert(f.reads.length <= 9);
  assert.equal((await physicalRuns(reader.root.chunks)).length + 1, 1025);
  assert.equal(
    await stateSourceReader('project').plan(state, f.pin),
    null,
    'whole-plan limit stays64; root compression cannot coalesce1024 independent keys',
  );
  t.diagnostic(
    JSON.stringify({
      files: entries.length,
      chunks: reader.root.chunks.length,
      rootBytes: f.pin.size,
      metadataGrants: 1025,
      lookupReads: f.reads.length,
    }),
  );
});

test('metadata covering grants stay inside the selected root live bounds and ignore unlisted corrupt bytes', async t => {
  const r2 = fakeSourceR2(t),
    objects = new Map();
  const put = bytes => {
    const pin = { sha256: digest(bytes), size: bytes.length };
    objects.set(pin.sha256, bytes);
    r2.objects.set(`/synthetic/v1/p/project/o/${pin.sha256}`, bytes);
    return pin;
  };
  const entries = ['first', 'last']
    .map(value => ({ sha256: digest(value), size: 3 }))
    .sort((a, b) => physicalBucket(a.sha256) - physicalBucket(b.sha256));
  const bodies = entries.map(entry => encodePhysicalEntries([entry]));
  const garbage = Buffer.from('unlisted bytes are not a bucket');
  const packed = Buffer.concat([garbage, bodies[0], garbage, bodies[1], garbage]);
  const pack = put(packed);
  const root = {
    schema: 1,
    kind: 'forge-physical-manifest',
    state,
    chunks: entries.map((entry, index) => ({
      bucket: physicalBucket(entry.sha256),
      sha256: digest(bodies[index]),
      size: bodies[index].length,
      pack: {
        digest: pack.sha256,
        size: pack.size,
        offset: index ? garbage.length * 2 + bodies[0].length : garbage.length,
      },
    })),
  };
  const pin = put(encodePhysicalRoot(root));
  const plan = await stateSourceReader('project').plan(state, pin);
  assert.equal(plan.chunks.length, 1);
  const [run] = plan.chunks;
  assert.equal(run.digest, pack.sha256);
  assert.equal(run.offset, garbage.length);
  assert.equal(run.offset + run.length, packed.length - garbage.length);
  assert.equal(new URL(run.url).pathname.split('/').at(-1), pack.sha256);
  const reader = await downloadPhysicalManifest(plan, fetch);
  assert.deepEqual(await reader.lookup(entries.map(entry => entry.sha256)), entries);
  // A selected-State mismatch is refused before any metadata grants are returned.
  await assert.rejects(
    stateSourceReader('project').plan(digest('another State'), pin),
    error => error.code === 'SOURCE_HASH_MISMATCH',
  );
});

test('binary codec preserves exact FPR1,FPR2,FPM1 and FPM2 bytes after indexed pack encoding', () => {
  const state = '11'.repeat(32),
    sha256 = '22'.repeat(32),
    digest = '33'.repeat(32),
    members = '44'.repeat(32);
  const pack = { digest, size: 100, offset: 7 };
  const root = {
    schema: 1,
    kind: 'forge-physical-manifest',
    state,
    chunks: [{ bucket: 12, sha256, size: 9, pack }],
  };
  const hex = bytes => Buffer.from(bytes).toString('hex');
  assert.equal(
    hex(encodePhysicalRoot(root)),
    '46505202' + state + '01' + digest + '6400010c' + sha256 + '09000107',
  );
  assert.equal(
    hex(encodePhysicalRoot({ ...root, chunks: [{ ...root.chunks[0], members }] })),
    '46505201' + state + '01' + digest + '64010c' + sha256 + '09' + members + '0107',
  );
  assert.equal(
    hex(encodePhysicalEntries([{ sha256, size: 9, pack }])),
    '46504d0101' + sha256 + '0901' + digest + '6407',
  );
  assert.equal(
    hex(encodePhysicalEntries([{ sha256, size: 9, pack: { ...pack, nonce: nonceA } }])),
    '46504d0201' + sha256 + '0901' + digest + '640701' + nonceA.replaceAll('-', ''),
  );
});
