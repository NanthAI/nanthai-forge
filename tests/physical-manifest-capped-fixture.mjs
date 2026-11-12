// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { digest } from '../dist/hash.js';
import { PhysicalManifestReader } from '../dist/physical-manifest.js';
import { physicalBucket } from '../dist/physical-manifest-codec.js';
import { physicalKey } from '../dist/physical-manifest-binary.js';
import { physicalMetadataRuns } from '../dist/physical-manifest-runs.js';
import { encodePhysicalRoot } from '../dist/physical-manifest-root.js';
import { writePhysicalManifest } from '../dist/physical-manifest-write.js';
import { downloadPhysicalManifest } from '../dist/physical-manifest-download.js';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { stateSourceReader } = await import(moduleUrl('../convex/projectStateSourceReader.ts'));
export function fixture(t, count, { nonce = false } = {}) {
  const log = console.log;
  t.mock.method(console, 'log', (message, ...values) => {
    if (!String(message).startsWith('FORGE_R2_COUNT')) log(message, ...values);
  });
  const r2 = fakeSourceR2(t),
    objects = new Map(),
    bindings = new Map(),
    puts = [],
    described = [],
    reads = [];
  const ids = Array.from({ length: count }, (_, index) => {
    const sha256 = digest(`file-${index}`);
    bindings.set(sha256, {
      sha256,
      size: 51,
      pack: {
        digest: digest(`pack-${Math.floor(index / 1000)}`),
        size: 51000,
        offset: (index % 1000) * 51,
        ...(nonce ? { nonce: '00000000-0000-4000-8000-000000000001' } : {}),
      },
    });
    return sha256;
  });
  const put = async bytes => {
    const pin = { sha256: digest(bytes), size: bytes.length };
    objects.set(pin.sha256, bytes);
    r2.objects.set(`/synthetic/v1/p/project/o/${pin.sha256}`, bytes);
    puts.push(pin);
    return pin;
  };
  const read = async pin => {
    reads.push(pin);
    const bytes = objects.get(physicalKey(pin.pack?.digest ?? pin.sha256, pin.pack?.nonce));
    assert(bytes, 'exact parent metadata key exists');
    return pin.pack ? bytes.subarray(pin.pack.offset, pin.pack.offset + pin.size) : bytes;
  };
  const write = (state, members, parent = null, parentMembers) =>
    writePhysicalManifest({
      state,
      members,
      parent,
      parentMembers,
      put,
      describe: async requested => {
        described.push(...requested);
        return requested.map(id => bindings.get(id) ?? null);
      },
    });
  const prune = current => {
    const keys = new Set([
      current.pin.sha256,
      ...current.root.chunks.map(chunk => physicalKey(chunk.pack?.digest ?? chunk.sha256, chunk.pack?.nonce)),
    ]);
    // The fixture retains one frontier rather than every simulated history body.
    for (const key of objects.keys())
      if (!keys.has(key)) {
        objects.delete(key);
        r2.objects.delete(`/synthetic/v1/p/project/o/${key}`);
      }
  };
  return { r2, objects, bindings, ids, puts, described, reads, put, read, write, prune };
}
export async function chain(t, { count, steps, split = false, stress = false, nonce = false }) {
  const f = fixture(t, count, { nonce });
  let ids = [...f.ids],
    state = digest('seed'),
    current = await f.write(state, ids);
  if (split) {
    const chunks = [];
    for (const chunk of current.root.chunks) {
      const pin = await f.put(await f.read(chunk));
      chunks.push({ bucket: chunk.bucket, ...pin, pack: { digest: pin.sha256, size: pin.size, offset: 0 } });
    }
    const root = { ...current.root, chunks };
    current = { ...current, root, pin: await f.put(encodePhysicalRoot(root)) };
    assert.equal(chunks.length, 1024);
  }
  const removed = new Set(),
    occurrences = new Map();
  for (const id of ids) occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
  const release = id => {
    const count = occurrences.get(id) - 1;
    if (count) occurrences.set(id, count);
    else {
      occurrences.delete(id);
      f.bindings.delete(id);
    }
  };
  let maxGrants = 0,
    maxUpload = 0,
    uploadSum = 0,
    maxCarry = 0,
    carrySum = 0,
    firstBounded = null,
    wholeBytes = 0;
  const start = performance.now();
  for (let step = 1; step <= steps; step++) {
    const parentIds = ids,
      parent = await PhysicalManifestReader.open(state, current.pin, f.read);
    ids = [...ids];
    const changed = stress ? [1, 8, 300, 2000, count, 8, 0][(step - 1) % 7] : 8,
      packDigest = digest(`replacement-pack-${step}`);
    for (let index = 0; index < changed; index++) {
      const at = ((step - 1) * 8 + index) % ids.length,
        sha256 = digest(`replacement-${step}-${index}`);
      removed.add(ids[at]);
      release(ids[at]);
      ids[at] = sha256;
      occurrences.set(sha256, (occurrences.get(sha256) ?? 0) + 1);
      f.bindings.set(sha256, {
        sha256,
        size: 51,
        pack: {
          digest: packDigest,
          size: changed * 51,
          offset: index * 51,
          ...(nonce ? { nonce: '00000000-0000-4000-8000-000000000002' } : {}),
        },
      });
    }
    // Alternating additions/deletions, and unchanged digest membership for renames.
    if (stress && step % 7 === 1) {
      ids.push(ids[0]);
      occurrences.set(ids[0], occurrences.get(ids[0]) + 1);
    }
    if (stress && step % 7 === 2) release(ids.pop());
    f.puts.length = 0;
    f.described.length = 0;
    f.reads.length = 0;
    state = digest(`save-${step}`);
    current = await f.write(state, ids, parent, parentIds);
    assert(current, 'complete bindings publish a manifest');
    const old = new Map(parent.root.chunks.map(chunk => [chunk.bucket, chunk]));
    const changedBytes = current.root.chunks
      .filter(chunk => !old.has(chunk.bucket) || old.get(chunk.bucket).sha256 !== chunk.sha256)
      .reduce((sum, chunk) => sum + chunk.size, 0);
    const upload = f.puts.reduce((sum, pin) => sum + pin.size, 0);
    assert(
      upload <= current.pin.size + changedBytes + current.carryBudget,
      `write ${step}: root + changed buckets + ceil(parent live bytes/63)`,
    );
    assert(current.carriedBytes <= current.carryBudget);
    assert(f.puts.slice(0, -1).every(pin => pin.size <= 16 * 1024 * 1024));
    assert(f.puts.length <= 4);
    if (!stress) {
      assert.equal(f.described.length, 8, 'only eight new digest bindings reach descriptors');
      assert.equal(f.puts.length, 2);
      if (count === 29000 && !split) assert(upload <= 150000, `${step}: ${upload} upload bytes`);
    }
    if (stress && changed === 8) assert(upload <= 150000, `${step}: ${upload} stress upload bytes`);
    const keys = new Set(
      current.root.chunks.map(chunk => physicalKey(chunk.pack?.digest ?? chunk.sha256, chunk.pack?.nonce)),
    );
    const grants = keys.size + 1;
    if (!split || step >= 43) assert(grants <= 64, `write ${step}: ${grants} grants`);
    const metadata = await physicalMetadataRuns(current.root.chunks);
    assert.equal(metadata.length + 1, grants, 'the production planner issues exactly one grant per key');
    if (grants <= 64) firstBounded ??= step;
    if (split && [1, 42, 43].includes(step)) {
      const plan = await stateSourceReader('project').plan(state, current.pin);
      if (grants > 64) assert.equal(plan, null);
      else assert.equal(plan.chunks.length + 1, grants);
    }
    maxGrants = Math.max(maxGrants, grants);
    maxUpload = Math.max(maxUpload, upload);
    uploadSum += upload;
    maxCarry = Math.max(maxCarry, current.carriedBytes);
    carrySum += current.carriedBytes;
    if (step % 100 === 0 || step === steps) {
      const plan = await stateSourceReader('project').plan(state, current.pin);
      assert(plan);
      assert.equal(plan.chunks.length + 1, grants);
      const before = f.r2.requests.length,
        reader = await downloadPhysicalManifest(plan, fetch),
        members = new Set();
      for await (const entry of reader.all(false)) members.add(entry.sha256);
      assert.deepEqual(
        [...members].sort(),
        [...new Set(ids)].sort(),
        'whole client read contains every member',
      );
      const expected = new Set(ids);
      for (const id of removed) if (!expected.has(id)) assert(!members.has(id), 'removed member is absent');
      assert(f.r2.requests.length - before <= 64);
      removed.clear();
      wholeBytes = Math.max(
        wholeBytes,
        plan.pin.size + plan.chunks.reduce((sum, run) => sum + run.length, 0),
      );
    }
    f.prune(current);
  }
  t.diagnostic(
    JSON.stringify({
      count,
      steps,
      split,
      stress,
      nonce,
      maxGrants,
      firstBounded,
      maxUpload,
      meanUpload: Math.round(uploadSum / steps),
      maxCarry,
      meanCarry: Math.round(carrySum / steps),
      wholeBytes,
      wallMs: Math.round(performance.now() - start),
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
}
