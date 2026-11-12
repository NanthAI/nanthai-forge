// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../dist/hash.js';
import { physicalProject, physicalObjectRow } from './convex-physical-manifest-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const compact = await import(moduleUrl('../convex/projectObjectCatalogCompact.ts'));
const cleanup = await import(moduleUrl('../convex/projectCheckLogCleanupStore.ts'));
const plan = await import(moduleUrl('../convex/projectCheckLogCleanupPlanStore.ts'));
const sweep = await import(moduleUrl('../convex/projectR2Sweep.ts'));
const { sourceKeyReferenced } = await import(moduleUrl('../convex/projectSourceKeyProtection.ts'));
const { projectGuard } = await import(moduleUrl('../convex/projectCheckLogCleanupGuard.ts'));
const { PhysicalManifestReader } = await import('../dist/physical-manifest.js');

test('Done-when5: whole shared metadata packs stay live through catalog compaction, point retirement and stale cleanup/sweep jobs', async t => {
  const f = await physicalProject(t, 1000);
  await f.queueSeed();
  await f.seed();
  const first = await f.compose(f.files, f.base, 'main-0');
  const run = (name, handler) => f.s.transaction(name, { _handler: handler }, {});
  f.s.main.head = first.head.sha256;
  f.s.main.receipt.id = 'main-1';
  f.s.moveMain(first.head.sha256, 'main-1');
  const second = await f.compose(
    [...f.files.slice(1), f.s.file('new.txt', 'new source')],
    first.head,
    'main-1',
  );
  const root = physicalObjectRow(f.s, first.head.sha256).statePhysical;
  const reader = await PhysicalManifestReader.open(first.head.sha256, root, f.read),
    shared = reader.root.chunks[0].pack;
  const laterRoot = physicalObjectRow(f.s, second.head.sha256).statePhysical;
  const later = await PhysicalManifestReader.open(second.head.sha256, laterRoot, f.read);
  const live = later.root.chunks.filter(pin => pin.pack?.digest === shared.digest);
  assert(live.length > 0 && live.reduce((sum, pin) => sum + pin.size, 0) < shared.size);
  const metadata = new Set([
    root.sha256,
    laterRoot.sha256,
    ...reader.root.chunks.map(pin => pin.pack?.digest ?? pin.sha256),
    ...later.root.chunks.map(pin => pin.pack?.digest ?? pin.sha256),
  ]);
  const key = physicalObjectRow(f.s, shared.digest).r2Key;
  const migrate = async points => {
    let after = null,
      result;
    for (let page = 0; page < 100; page++) {
      result = JSON.parse(
        await run('retire metadata descriptor', ctx =>
          compact.step._handler(ctx, {
            projectId: f.s.projectId,
            actor: 'owner',
            operationId: points ? 'points' : 'catalog',
            after,
            ...(points ? { points: true } : {}),
          }),
        ),
      );
      if (result.done) return result;
      after = result.after;
    }
    assert.fail('migration did not converge');
  };
  await migrate(false);
  for (const id of metadata)
    assert.equal(physicalObjectRow(f.s, id), undefined, 'metadata carriers moved to the legacy catalog');
  assert(await run('legacy metadata key', ctx => sourceKeyReferenced(ctx, f.s.projectId, key)));
  const result = await migrate(true);
  assert.equal(f.s.tables.projectObjectCatalog.size, 0);
  const points = [...f.s.tables.projectObjectReceipts.values()].filter(row =>
    row.key.startsWith('source-point:'),
  );
  for (const id of metadata) assert(points.some(row => row.value === id && row.sourceBinding));
  assert(await run('point metadata key', ctx => sourceKeyReferenced(ctx, f.s.projectId, key)));
  const id = await run('queued stale deletion', ctx =>
    ctx.db.insert('projectObjects', {
      projectId: f.s.projectId,
      digest: digest('expired log fragment'),
      size: 1,
      nonce: 'synthetic-log',
      removed: false,
      sourceReferenced: false,
      location: 'r2',
      r2Key: `v1/p/${f.s.projectId}/o/${digest('expired log fragment')}`,
      r2Committed: false,
      r2SweepKey: key,
      pack: { digest: shared.digest, size: shared.size, offset: 0 },
    }),
  );
  assert.deepEqual(
    await run('protected shared pack sweep', ctx =>
      sweep.claim._handler(ctx, { projectId: f.s.projectId, ids: [id], dryRun: true }),
    ),
    [],
  );
  const different = `${key}/u/11111111-1111-4111-8111-111111111111`;
  f.s.patch('projectObjects', id, { r2SweepKey: different });
  assert.deepEqual(
    await run('unreferenced copy sweep', ctx =>
      sweep.claim._handler(ctx, { projectId: f.s.projectId, ids: [id], dryRun: true }),
    ),
    [{ id, key: different }],
    'another nonce copy remains eligible under existing cleanup policy',
  );
  f.s.patch('projectObjects', id, { r2Key: key, r2Committed: true, r2SweepKey: undefined });
  const row = await run('selected log row', ctx => ctx.db.get(id)),
    operationId = 'stale-shared-plan';
  await run('selected log node', async ctx => {
    for (const [part, value] of [
      [`node:${row.digest}`, JSON.stringify({ key: row.digest, candidate: true })],
      [`object:${row.digest}`, JSON.stringify(row)],
    ])
      await ctx.db.insert('projectCheckLogCleanupPages', {
        projectId: f.s.projectId,
        operationId,
        part,
        position: 0,
        value,
      });
  });
  const selected = JSON.parse(
    await run('point-aware cleanup inventory', ctx =>
      plan.nodes._handler(ctx, { projectId: f.s.projectId, actor: 'owner', operationId, cursor: null }),
    ),
  );
  assert(
    JSON.parse(selected.page[0].value).protected,
    'a log fragment cannot make the whole source carrier deletable',
  );
  await run('stale reviewed deletion', async ctx => {
    const guard = await projectGuard(ctx, await ctx.db.get(f.s.projectId));
    await ctx.db.insert('projectCheckLogCleanups', {
      projectId: f.s.projectId,
      operationId,
      value: JSON.stringify({ phase: 'ready', offset: 0, guard }),
    });
    await ctx.db.insert('projectCheckLogCleanupPages', {
      projectId: f.s.projectId,
      operationId,
      part: 'objects',
      position: 0,
      value: JSON.stringify([row]),
    });
  });
  await assert.rejects(
    run('final source-key fence', ctx =>
      cleanup.claim._handler(ctx, { projectId: f.s.projectId, actor: 'owner', operationId, offset: 0 }),
    ),
    error => (error.code ?? error.data?.code) === 'EVIDENCE_CHANGED',
  );
  assert.deepEqual(await run('retained original row', ctx => ctx.db.get(id)), row);
  assert.deepEqual(
    await PhysicalManifestReader.open(first.head.sha256, root, f.read).then(r => r.root),
    reader.root,
  );
  t.diagnostic(
    JSON.stringify({
      retainedRoots: 2,
      metadataKeys: metadata.size,
      wholeSharedPackBytes: shared.size,
      liveChildBytes: live.reduce((sum, pin) => sum + pin.size, 0),
      migrated: result.moved,
      densePages: 0,
    }),
  );
});

test('Done-when2/5: a verified placement replacement retains the older exact key and producers accept only a proven nonce carrier', async () => {
  const { migrationFixture } = await import('./source-point-migration-fixture.mjs');
  const output = await import(moduleUrl('../convex/projectConvexSourceOutput.ts'));
  const f = migrationFixture(10);
  await f.migrate();
  const bytes = Buffer.from('ab'),
    sha256 = digest(bytes),
    oldKey = `v1/p/project/o/${sha256}/u/11111111-1111-4111-8111-111111111111`,
    currentKey = `v1/p/project/o/${sha256}`;
  const id = await f.run(ctx =>
    ctx.db.insert('projectObjects', {
      projectId: f.projectId,
      digest: sha256,
      size: bytes.length,
      nonce: 'original-carrier',
      removed: false,
      sourceReferenced: true,
      location: 'r2',
      r2Key: oldKey,
      r2Committed: true,
    }),
  );
  await f.run(ctx =>
    output.storeSourceOutputs(ctx, f.projectId, 'replace-placement', [
      { sha256, size: bytes.length, r2Key: currentKey },
    ]),
  );
  assert.equal(f.s.tables.projectObjects.get(id).r2Key, currentKey);
  assert(
    await f.run(ctx => sourceKeyReferenced(ctx, f.projectId, oldKey)),
    'the older whole carrier remains live',
  );
  assert(await f.run(ctx => sourceKeyReferenced(ctx, f.projectId, currentKey)));
  const member = {
    sha256: digest('a'),
    size: 1,
    r2Key: oldKey,
    pack: { digest: sha256, size: bytes.length, offset: 0 },
  };
  await f.run(ctx => output.storeSourceOutputs(ctx, f.projectId, 'reuse-exact-retained-carrier', [member]));
  const { findStoredObject } = await import(moduleUrl('../convex/projectObjectFind.ts'));
  assert.equal((await f.run(ctx => findStoredObject(ctx, f.projectId, member.sha256))).r2Key, oldKey);
  await assert.rejects(
    f.run(ctx =>
      output.storeSourceOutputs(ctx, f.projectId, 'unproven-copy', [
        { ...member, sha256: digest('c'), r2Key: `${currentKey}/u/22222222-2222-4222-8222-222222222222` },
      ]),
    ),
    error => error.code === 'SOURCE_HASH_MISMATCH',
  );
});

test('Done-when5: exact carrier liveness uses existing indexes and survives a newer committed upload of a retained raw point', async () => {
  const { migrationFixture } = await import('./source-point-migration-fixture.mjs');
  const { storePointObjects } = await import(moduleUrl('../convex/projectObjectPointStore.ts'));
  const f = migrationFixture(1),
    sha256 = digest('retained raw'),
    key = `v1/p/project/o/${sha256}`;
  // This fixture has no legacy receipt to reconcile.
  f.s.tables.projectObjectReceipts.clear();
  await f.migrate();
  await f.run(ctx =>
    storePointObjects(ctx, f.projectId, [
      {
        projectId: f.projectId,
        digest: sha256,
        size: 12,
        nonce: 'source',
        removed: false,
        sourceReferenced: true,
        location: 'r2',
        r2Key: key,
        r2Committed: true,
      },
    ]),
  );
  await f.run(ctx =>
    ctx.db.insert('projectObjects', {
      projectId: f.projectId,
      digest: sha256,
      size: 12,
      nonce: 'new-upload',
      removed: false,
      location: 'r2',
      r2Key: `${key}/u/11111111-1111-4111-8111-111111111111`,
      r2Committed: true,
    }),
  );
  assert(await f.run(ctx => sourceKeyReferenced(ctx, f.projectId, key)));
  assert.equal(
    await f.run(ctx =>
      sourceKeyReferenced(ctx, f.projectId, `${key}/u/22222222-2222-4222-8222-222222222222`),
    ),
    false,
  );
  await f.run(ctx =>
    ctx.db.insert('projectObjectReceipts', {
      projectId: f.projectId,
      key: `source-key:project:${key}`,
      value: sha256,
      size: 12,
      sourceBinding: { r2Key: `${key}/u/22222222-2222-4222-8222-222222222222` },
    }),
  );
  await assert.rejects(
    f.run(ctx => sourceKeyReferenced(ctx, f.projectId, key)),
    error => error.code === 'SOURCE_HASH_MISMATCH',
  );
});
