// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../dist/hash.js';
import { PhysicalManifestReader } from '../dist/physical-manifest.js';
import { fixture, chain } from './physical-manifest-capped-fixture.mjs';
import { landingChain } from './physical-manifest-landing-history-fixture.mjs';
// The one-file builder guard keeps every required chain and landing count. Longer
// independent qualifications live in their own files under the same runner timeout.
test('2000 save-only eight-file writes at29k always use64 grants,150000B,two PUTs,eight descriptors and complete verified client reads', t =>
  chain(t, { count: 29000, steps: 2000 }));
test('the1024-key parent converges by write43 without rebuild and every one of2000 writes obeys the carry formula', t =>
  chain(t, { count: 29000, steps: 2000, split: true }));
test('300 eight-file saves at100k preserve64 grants and the root+changed+one63rd upload bound', t =>
  chain(t, { count: 100000, steps: 300 }));
test('accepted main metadata never reaches a Lane-only file saved then removed before landing', async t => {
  const f = fixture(t, 1000),
    main = await f.write(digest('main'), f.ids),
    mainReader = await PhysicalManifestReader.open(main.root.state, main.pin, f.read),
    privateId = digest('Lane-only source');
  f.bindings.set(privateId, { sha256: privateId, size: 3 });
  const lane = await f.write(digest('Lane intermediate'), [...f.ids, privateId], mainReader, f.ids);
  assert((await PhysicalManifestReader.open(lane.root.state, lane.pin, f.read)).root.chunks.length);
  // Compose extends main's side, using only the final Lane membership.
  const accepted = await f.write(digest('accepted'), f.ids, mainReader, f.ids);
  const reachable = new Set(accepted.root.chunks.map(chunk => chunk.pack?.digest ?? chunk.sha256));
  const laneOnly = lane.root.chunks.filter(
    chunk => !main.root.chunks.some(old => old.sha256 === chunk.sha256),
  );
  assert(laneOnly.length);
  for (const chunk of laneOnly) assert(!reachable.has(chunk.pack?.digest ?? chunk.sha256));
  assert.deepEqual(
    await (await PhysicalManifestReader.open(accepted.root.state, accepted.pin, f.read)).lookup([privateId]),
    [null],
  );
});

test('400 three-save landings at29k repair Lane-only dead bytes within150000B,two PUTs and two roots plus one range per failing key', t =>
  landingChain(t, 29000, 400));
test('150 three-save landings at100k retain64 grants and repair within root plus live failing-key bytes', t =>
  landingChain(t, 100000, 150));
