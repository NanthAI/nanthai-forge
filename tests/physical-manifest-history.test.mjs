// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../dist/hash.js';
import { PhysicalManifestReader } from '../dist/physical-manifest.js';
import { encodePhysicalRoot } from '../dist/physical-manifest-root.js';
import { writePhysicalManifest } from '../dist/physical-manifest-write.js';
import { downloadPhysicalManifest } from '../dist/physical-manifest-download.js';
import { physicalRuns } from '../dist/physical-manifest-runs.js';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { stateSourceReader } = await import(moduleUrl('../convex/projectStateSourceReader.ts'));

test('four saves grant one covering metadata range per selected root key and decode only hash-checked live buckets', async t => {
  const r2 = fakeSourceR2(t),
    bindings = new Map(
      Array.from({ length: 29000 }, (_, index) => {
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
    ),
    ids = [...bindings.keys()],
    objects = new Map(),
    memberships = new Map(),
    put = async bytes => {
      const pin = { sha256: digest(bytes), size: bytes.length };
      objects.set(pin.sha256, bytes);
      r2.objects.set(`/synthetic/v1/p/project/o/${pin.sha256}`, bytes);
      return pin;
    },
    read = async pin =>
      pin.pack
        ? objects.get(pin.pack.digest).subarray(pin.pack.offset, pin.pack.offset + pin.size)
        : objects.get(pin.sha256),
    write = async (state, parent) => {
      const result = await writePhysicalManifest({
        state,
        members: ids,
        parent,
        parentMembers: parent ? memberships.get(parent.root.state) : undefined,
        put,
        describe: async requested => requested.map(id => bindings.get(id)),
      });
      memberships.set(state, [...ids]);
      return result;
    };
  let state = digest('compact seed'),
    current = await write(state, null);
  assert.equal(1 + (await physicalRuns(current.root.chunks)).length, 2);
  const observations = [],
    removed = [];
  for (let step = 1; step <= 4; step++) {
    const parent = await PhysicalManifestReader.open(state, current.pin, read);
    for (let index = 0; index < 8; index++) {
      const at = (step - 1) * 8 + index,
        sha256 = digest(`replacement-${step}-${index}`);
      removed.push(ids[at]);
      ids[at] = sha256;
      bindings.set(sha256, {
        sha256,
        size: 51,
        pack: { digest: digest(`replacement-pack-${step}`), size: 408, offset: index * 51 },
      });
    }
    state = digest(`save-${step}`);
    current = await write(state, parent);
    // Fingerprint omission changes root bytes, never the chunks' immutable keys
    // or the exact intervals the deployed signer is allowed to grant.
    const root = {
        ...current.root,
        chunks: current.root.chunks.map(({ members: _members, ...chunk }) => chunk),
      },
      bytes = encodePhysicalRoot(root),
      pin = await put(bytes),
      keys = new Set(root.chunks.map(chunk => chunk.pack?.digest ?? chunk.sha256)).size,
      grants = 1 + (await physicalRuns(root.chunks)).length,
      plan = await stateSourceReader('project').plan(state, pin);
    assert.equal(bytes[3], 2);
    assert.equal(plan.chunks.length + 1, step + 2);
    assert.equal(plan.chunks.length, keys);
    for (const run of plan.chunks) {
      const live = root.chunks.filter(chunk => chunk.pack?.digest === run.digest);
      assert(live.length, 'no key outside the selected root');
      assert.equal(run.offset, Math.min(...live.map(chunk => chunk.pack.offset)));
      assert.equal(run.offset + run.length, Math.max(...live.map(chunk => chunk.pack.offset + chunk.size)));
      assert.equal(run.total, live[0].pack.size);
    }
    const downloaded = await downloadPhysicalManifest(plan, fetch);
    const downloadedMembers = [];
    for await (const entry of downloaded.all(false)) downloadedMembers.push(entry.sha256);
    assert.deepEqual(downloadedMembers.sort(), [...ids].sort());
    assert.deepEqual(
      await downloaded.lookup(removed),
      removed.map(() => null),
    );
    observations.push({ step, keys, grants });
    if (step === 4) {
      const reader = await PhysicalManifestReader.open(state, pin, read);
      assert.equal(reader.root.chunks.length, 1024, 'no bucket may be skipped to fit the plan');
      assert.deepEqual(
        await reader.lookup(removed),
        removed.map(() => null),
      );
      const members = [];
      for await (const entry of reader.all()) members.push(entry.sha256);
      assert.deepEqual(members.sort(), [...ids].sort(), 'all current members remain readable');
    }
  }
  assert.deepEqual(observations, [
    { step: 1, keys: 2, grants: 18 },
    { step: 2, keys: 3, grants: 35 },
    { step: 3, keys: 4, grants: 50 },
    { step: 4, keys: 5, grants: 66 },
  ]);
  t.diagnostic(JSON.stringify({ files: ids.length, observations }));
});
