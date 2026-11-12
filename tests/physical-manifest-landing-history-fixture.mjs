// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { digest } from '../dist/hash.js';
import { PhysicalManifestReader } from '../dist/physical-manifest.js';
import { physicalKey } from '../dist/physical-manifest-binary.js';
import { repairPhysicalRoot } from '../dist/physical-manifest-write.js';
import { downloadPhysicalManifest } from '../dist/physical-manifest-download.js';
import { moduleUrl } from './convex-module.mjs';
import { fixture } from './physical-manifest-capped-fixture.mjs';
const { stateSourceReader } = await import(moduleUrl('../convex/projectStateSourceReader.ts'));
export async function landingChain(t, count, steps) {
  const f = fixture(t, count);
  let ids = [...f.ids],
    main = await f.write(digest('landing seed'), ids);
  let maxRepairBytes = 0,
    maxRepairReads = 0,
    maxGrants = 0,
    maxSaveBytes = 0;
  const start = performance.now();
  for (let landing = 0; landing < steps; landing++) {
    let current = main;
    const saveKeys = new Set();
    const acceptedKeys = new Set(
      main.root.chunks.map(pin => physicalKey(pin.pack?.digest ?? pin.sha256, pin.pack?.nonce)),
    );
    const extra = digest(`temporary-${landing}`);
    f.bindings.set(extra, { sha256: extra, size: 8 });
    for (let save = 0; save < 3; save++) {
      const before = ids;
      ids = [...ids];
      for (let i = 0; i < 8; i++) {
        const at = (landing * 16 + save * 4 + i) % count,
          id = digest(`landing-${landing}-save-${save}-file-${i}`);
        f.bindings.delete(ids[at]);
        ids[at] = id;
        f.bindings.set(id, { sha256: id, size: 51 });
      }
      if (save === 0) ids.push(extra);
      if (save === 2) {
        ids = ids.filter(id => id !== extra);
        f.bindings.delete(extra);
      }
      const parent = await PhysicalManifestReader.open(current.root.state, current.pin, f.read);
      f.puts.length = 0;
      current = await f.write(digest(`landing-${landing}-save-${save}`), ids, parent, before);
      const bytes = f.puts.reduce((sum, pin) => sum + pin.size, 0);
      if (count === 29000) assert(bytes <= 150000);
      maxSaveBytes = Math.max(maxSaveBytes, bytes);
      for (const pin of current.root.chunks) {
        const key = physicalKey(pin.pack?.digest ?? pin.sha256, pin.pack?.nonce);
        if (!acceptedKeys.has(key)) saveKeys.add(key);
      }
    }
    f.puts.length = 0;
    f.reads.length = 0;
    const [head, accepted] = await Promise.all([
      PhysicalManifestReader.open(current.root.state, current.pin, f.read),
      PhysicalManifestReader.open(main.root.state, main.pin, f.read),
    ]);
    const repaired = await repairPhysicalRoot({
      state: current.root.state,
      head,
      main: accepted.root,
      put: f.put,
    });
    assert(repaired, 'overlapping saves require repair');
    const repairBytes = f.puts.reduce((sum, pin) => sum + pin.size, 0);
    assert.equal(f.puts.length, 2);
    assert.equal(
      f.reads.length,
      2 + repaired.failingKeys,
      'two roots plus one range per failing metadata key',
    );
    assert(repairBytes <= repaired.pin.size + repaired.movedBytes);
    if (count === 29000) assert(repairBytes <= 150000);
    const groups = new Map();
    for (const pin of repaired.root.chunks) {
      const key = physicalKey(pin.pack?.digest ?? pin.sha256, pin.pack?.nonce);
      groups.set(key, [...(groups.get(key) ?? []), pin]);
    }
    assert(groups.size + 1 <= 64);
    for (const [key, pins] of groups)
      if (saveKeys.has(key))
        assert.equal(
          pins.reduce((sum, pin) => sum + pin.size, 0),
          pins[0].pack?.size ?? pins[0].size,
          'no save-written metadata key in the accepted root contains a dead byte',
        );
    main = repaired;
    maxRepairBytes = Math.max(maxRepairBytes, repairBytes);
    maxRepairReads = Math.max(maxRepairReads, f.reads.length);
    maxGrants = Math.max(maxGrants, groups.size + 1);
    if ((landing + 1) % 50 === 0) {
      const plan = await stateSourceReader('project').plan(main.root.state, main.pin),
        reader = await downloadPhysicalManifest(plan, fetch),
        members = [];
      for await (const entry of reader.all(false)) members.push(entry.sha256);
      assert.deepEqual(members.sort(), [...new Set(ids)].sort());
      assert(!members.includes(extra), 'the temporary Lane file remains absent');
    }
    f.prune(main);
  }
  t.diagnostic(
    JSON.stringify({
      count,
      landings: steps,
      maxRepairBytes,
      maxRepairReads,
      maxGrants,
      maxSaveBytes,
      wallMs: Math.round(performance.now() - start),
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
}
