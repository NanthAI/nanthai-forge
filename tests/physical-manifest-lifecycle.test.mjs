// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { physicalProject, physicalObjectRow } from './convex-physical-manifest-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { PhysicalManifestReader } from '../dist/physical-manifest.js';
const sweep = await import(moduleUrl('../convex/projectR2Sweep.ts'));
const cleanup = await import(moduleUrl('../convex/projectCheckLogCleanupStore.ts'));
const { planStep } = await import(moduleUrl('../convex/projectCheckLogCleanupPlan.ts'));
const { projectGuard } = await import(moduleUrl('../convex/projectCheckLogCleanupGuard.ts'));
test('retained State roots keep whole shared metadata packs protected in sweep and cleanup inventory', async t => {
  const f = await physicalProject(t, 1000);
  await f.queueSeed();
  await f.seed();
  const first = await f.compose(f.files, f.base, 'main-0');
  f.s.main.head = first.head.sha256;
  f.s.main.receipt.id = 'main-1';
  f.s.moveMain(first.head.sha256, 'main-1');
  const files = [...f.files.slice(1), f.s.file('new.txt', 'new member')];
  const second = await f.compose(files, first.head, 'main-1');
  const readers = await Promise.all(
    [first, second].map(value =>
      PhysicalManifestReader.open(
        value.head.sha256,
        physicalObjectRow(f.s, value.head.sha256).statePhysical,
        f.read,
      ),
    ),
  );
  const metadata = new Set(
    readers.flatMap(reader => reader.root.chunks.map(pin => pin.pack?.digest ?? pin.sha256)).filter(Boolean),
  );
  // Root pin is retained independently of each shared pack.
  for (const value of [first, second])
    metadata.add(physicalObjectRow(f.s, value.head.sha256).statePhysical.sha256);
  assert(metadata.size >= 3);
  const shared = readers[0].root.chunks[0].pack;
  assert(shared, 'the seed stores metadata chunks in a pack');
  const live = readers[1].root.chunks.filter(pin => pin.pack?.digest === shared.digest);
  assert(live.length > 0, 'the child retains chunks from the parent metadata pack');
  assert(
    live.reduce((sum, pin) => sum + pin.size, 0) < shared.size,
    'only part of the parent pack is live in the child; protection must cover the whole key',
  );
  const rows = [...metadata].map(id => physicalObjectRow(f.s, id));
  assert(rows.every(row => row?.sourceReferenced && row.r2Committed && !row.removed));
  const jobs = await f.s.run('metadata sweep', ctx =>
    sweep.claim._handler(ctx, { projectId: f.s.projectId, ids: rows.map(row => row._id), dryRun: true }),
  );
  assert.deepEqual(jobs, []);
  const guard = await f.s.run('metadata guard', async ctx =>
    projectGuard(ctx, await ctx.db.get(f.s.projectId)),
  );
  const protectedKeys = new Set();
  const state = {
    version: 2,
    guard,
    now: Date.now(),
    phase: 'objects',
    step: 0,
    cursor: null,
    fileOffset: 0,
    counts: { objects: 0, logs: 0, shared: 0, archives: 0, hostedOutputs: 0, digests: 0 },
    bytes: 0,
    planDigest: '',
    recipeCount: 0,
    recipeOffset: 0,
    queueCount: 0,
    queueOffset: 0,
    treeCount: 0,
    treeOffset: 0,
    offset: 0,
    outputOffset: 0,
  };
  const action = {
    runQuery: async (ref, args) => {
      assert.equal(getFunctionName(ref), 'projectCheckLogCleanupStore:inventory');
      return f.s.run('metadata inventory', ctx => cleanup.inventory._handler(ctx, args));
    },
    runMutation: async (ref, args) => {
      assert.equal(getFunctionName(ref), 'projectCheckLogCleanupStore:planStep');
      for (const node of JSON.parse(args.nodes)) if (node.protected) protectedKeys.add(node.key);
      return args.value;
    },
  };
  let current = state;
  for (let page = 0; current.phase === 'objects' && page < 10; page++)
    current = await planStep(
      action,
      { projectId: f.s.projectId, actor: 'owner', operationId: 'synthetic' },
      current,
    );
  assert.notEqual(current.phase, 'objects');
  for (const id of metadata) assert(protectedKeys.has(id), `whole metadata key remains protected: ${id}`);
});
