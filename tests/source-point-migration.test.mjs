// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../dist/hash.js';
import { moduleUrl } from './convex-module.mjs';
import {
  migrationFixture,
  find,
  compact,
  commits,
  objects,
  nonce,
} from './source-point-migration-fixture.mjs';
const store = await import(moduleUrl('../convex/projectObjectCatalogStore.ts'));
const catalog = await import(moduleUrl('../convex/projectGithubImportCatalog.ts'));
const pointRows = f =>
  [...f.s.tables.projectObjectReceipts.values()].filter(row => row.key.startsWith('source-point:'));
for (const count of [402, 1387])
  test(`Done-when7: bounded retirement keeps stored, absent and original-id whole-row reads below1KB at${count}`, async t => {
    const f = migrationFixture(count),
      sorted = [...f.pins].sort((a, b) => a.digest.localeCompare(b.digest));
    await f.run(ctx => find.findObject(ctx, f.projectId, sorted[100].digest));
    const before = f.measurements.at(-1).readBytes;
    assert.equal(
      before,
      count === 402 ? 48542 : 48919,
      'same full dense-row fixture as the existing zoo ratchet',
    );
    f.beforeDelete(row => {
      assert(
        f.s.tables.projectObjectReceipts.get(f.alias._id).sourceBinding,
        'original-id binding precedes dense retirement',
      );
      const points = new Set(pointRows(f).map(row => row.value));
      for (let at = 0; at < row.digests.length; at += 64)
        assert(
          points.has(row.digests.slice(at, at + 64)),
          'every page entry is authoritative before removal',
        );
    });
    const { result, steps } = await f.migrate();
    assert.equal(result.moved, count);
    assert.equal(f.s.tables.projectObjectCatalog.size, 0);
    assert.equal(pointRows(f).length, count);
    assert(
      steps.every(
        step => (step.reads.projectObjectCatalog ?? 0) <= 2 && (step.reads.projectObjectReceipts ?? 0) <= 260,
      ),
    );
    assert(
      steps.every(step => step.writeBytes < 200000 && step.readBytes < 150000),
      'fixture migration pages remain byte bounded',
    );
    const header = [...f.s.tables.projectObjectReceipts.values()].find(
      row => row.key === 'source-points:project',
    );
    assert.equal(header.value, '2');
    const selected = await f.run(ctx => find.findObject(ctx, f.projectId, sorted[100].digest));
    assert.equal(selected.size, sorted[100].size);
    assert.deepEqual(selected.pack, sorted[100].pack);
    const stored = f.measurements.at(-1);
    assert(stored.readBytes < 1000, JSON.stringify(stored));
    assert.equal(stored.reads.projectObjectCatalog ?? 0, 0);
    assert.equal(await f.run(ctx => find.findObject(ctx, f.projectId, digest('absent'))), null);
    const absent = f.measurements.at(-1);
    assert(absent.readBytes < 1000);
    assert.equal(absent.reads.projectObjectCatalog ?? 0, 0);
    assert.deepEqual(await f.call(commits.pendingRows, { actor: 'owner', ids: ['original-upload'] }), []);
    const retry = f.measurements.at(-1);
    assert(retry.readBytes < 1000, JSON.stringify(retry));
    assert.equal(retry.reads.projectObjectCatalog ?? 0, 0);
    assert.deepEqual(await f.call(objects.reconcile, { id: 'original-upload', cursor: null }), {
      stored: true,
      isDone: true,
      cursor: '',
    });
    const reconciled = f.measurements.at(-1);
    assert(reconciled.readBytes < 1000);
    assert.equal(f.s.scheduled.length, 0);
    t.diagnostic(
      JSON.stringify({
        count,
        denseBytes: before,
        storedBytes: stored.readBytes,
        absentBytes: absent.readBytes,
        originalIdBytes: retry.readBytes,
        reconcileBytes: reconciled.readBytes,
        steps: steps.length,
        maxStepReadBytes: Math.max(...steps.map(row => row.readBytes)),
        maxStepWriteBytes: Math.max(...steps.map(row => row.writeBytes)),
        result,
      }),
    );
  });

test('Done-when5: catalog stores and compaction use point authority, while a bulk import reopens complete mixed fallback', async () => {
  const f = migrationFixture(10);
  await f.migrate();
  const pin = { digest: digest('later pin'), size: 9 };
  await f.run(ctx => store.storeCatalogObjects(ctx, f.projectId, [pin], 'later-source'));
  assert.equal(f.s.tables.projectObjectCatalog.size, 0);
  assert.equal((await f.run(ctx => find.findObject(ctx, f.projectId, pin.digest))).size, 9);
  f.s.tables.projectGithubImports.set('import', {
    _id: 'import',
    projectId: f.projectId,
    owner: 'owner',
    protocol: 3,
    phase: 'importing',
    step: 1,
  });
  const imported = { digest: digest('late import'), size: 11 };
  await f.call(catalog.publish, {
    id: 'import',
    actor: 'owner',
    step: 1,
    pages: find.catalogPages([imported]),
  });
  assert.equal(
    [...f.s.tables.projectObjectReceipts.values()].find(row => row.key === 'source-points:project').value,
    '1',
  );
  assert.equal(
    (await f.run(ctx => find.findObject(ctx, f.projectId, imported.digest))).size,
    11,
    'a later dense writer cannot make an existing point miss mean absence',
  );
  await f.migrate('after-import');
  assert.equal(f.s.tables.projectObjectCatalog.size, 0);
  assert.equal((await f.run(ctx => find.findObject(ctx, f.projectId, imported.digest))).size, 11);
});

test('Done-when6: point qualification preserves client policy, refuses changed operation modes and keeps complete fallback on conflicting bindings', async () => {
  const f = migrationFixture(10),
    project = f.s.tables.hostedProjects.get(f.projectId);
  delete project.sourceManifestVersion;
  const first = JSON.parse(
    await f.call(compact.step, {
      projectId: f.projectId,
      actor: 'owner',
      operationId: 'point-original',
      points: true,
      after: null,
    }),
  );
  assert.equal(
    project.sourceManifestVersion,
    undefined,
    'point authority never adds a client protocol restriction',
  );
  await assert.rejects(
    f.call(compact.step, {
      projectId: f.projectId,
      actor: 'owner',
      operationId: 'point-original',
      after: first.after,
    }),
    error => error.code === 'WORK_OPERATION_CHANGED',
  );
  const bad = f.pins[3];
  f.s.tables.projectObjectReceipts.set('conflicting', {
    _id: 'conflicting',
    _creationTime: 1,
    projectId: f.projectId,
    key: `source-point:${f.projectId}:${bad.digest}`,
    value: bad.digest,
    size: 99,
    sourceBinding: { r2Key: `v1/p/project/o/${bad.digest}` },
  });
  await assert.rejects(
    f.call(compact.step, {
      projectId: f.projectId,
      actor: 'owner',
      operationId: 'point-original',
      points: true,
      after: first.after,
    }),
    error => error.code === 'SOURCE_HASH_MISMATCH',
  );
  assert.equal(f.s.tables.projectObjectCatalog.size, 1, 'failed page publication removes nothing');
  assert.equal(pointRows(f).length, 1, 'the transaction rolls back partial point writes');
});

test('Done-when5: bounded original-id pages finish before retirement and a concurrent earlier import cannot escape the final completeness check', async () => {
  const f = migrationFixture(402);
  for (let index = 1; index <= 150; index++) {
    const pin = f.pins[index],
      id = `old-id-${index}`;
    f.s.tables.projectObjectReceipts.set(id, {
      _id: id,
      _creationTime: 1,
      projectId: f.projectId,
      key: id,
      value: pin.digest,
      nonce: `old-nonce-${index}`,
      size: pin.size,
    });
  }
  f.beforeDelete(() =>
    assert(
      [...f.s.tables.projectObjectReceipts.values()]
        .filter(row => row.key === 'original-upload' || row.key.startsWith('old-id-'))
        .every(row => row.sourceBinding),
      'all original-id pages precede the first catalog deletion',
    ),
  );
  let after = null,
    result,
    imported = false;
  const earlier = { digest: '0'.repeat(64), size: 1 };
  do {
    result = JSON.parse(
      await f.call(compact.step, {
        projectId: f.projectId,
        actor: 'owner',
        operationId: 'concurrent-earlier',
        points: true,
        after,
      }),
    );
    after = result.after;
    if (result.pages === 1 && !imported) {
      imported = true;
      f.s.tables.projectGithubImports.set('concurrent', {
        _id: 'concurrent',
        projectId: f.projectId,
        owner: 'owner',
        protocol: 3,
        phase: 'importing',
        step: 1,
      });
      await f.call(catalog.publish, {
        id: 'concurrent',
        actor: 'owner',
        step: 1,
        pages: find.catalogPages([earlier]),
      });
    }
  } while (!result.done);
  assert.equal(result.receipts, 151);
  assert.equal(result.moved, 403);
  assert.equal(f.s.tables.projectObjectCatalog.size, 0);
  assert.equal((await f.run(ctx => find.findObject(ctx, f.projectId, earlier.digest))).size, 1);
});

test('Done-when5: imported State dimensions and unknown generation repair survive complete point authority and row promotion', async () => {
  const f = migrationFixture(10),
    state = {
      digest: digest('imported-state'),
      size: 321,
      stateSize: { fileCount: 29000, manifestBytes: 321 },
    };
  for (const page of find.catalogPages([state]))
    f.s.tables.projectObjectCatalog.set('imported-state', {
      _id: 'imported-state',
      _creationTime: 1,
      projectId: f.projectId,
      origin: 'state',
      ...page,
    });
  await f.migrate();
  const api = await import(moduleUrl('../convex/projectStateGeneration.ts'));
  assert.deepEqual(
    (await f.run(ctx => find.findObject(ctx, f.projectId, state.digest))).stateSize,
    state.stateSize,
  );
  assert.deepEqual(
    JSON.parse(
      await f.call(api.commit, {
        projectId: f.projectId,
        actor: 'owner',
        operationId: 'state-level',
        states: [{ head: state.digest, size: state.size, generation: 3 }],
      }),
    ),
    { assigned: 1 },
  );
  const row = await f.run(ctx => find.findObject(ctx, f.projectId, state.digest));
  assert.equal(row.stateGeneration, 3);
  assert.deepEqual(row.stateSize, state.stateSize);
  assert(row._id, 'mutable State metadata has its own row');
  const promoted = await f.run(ctx =>
    find.objectRow(ctx, {
      ...row,
      _id: undefined,
      _creationTime: undefined,
      digest: digest('promoted-state'),
      r2Key: `v1/p/${f.projectId}/o/${digest('promoted-state')}`,
      nonce,
      stateParents: [digest('parent')],
      statePhysical: { sha256: digest('root'), size: 123 },
      recipeClosure: [{ sha256: digest('leaf'), size: 1 }],
    }),
  );
  assert.deepEqual(promoted.stateParents, [digest('parent')]);
  assert.equal(promoted.statePhysical.sha256, digest('root'));
  assert.equal(promoted.recipeClosure[0].sha256, digest('leaf'));
  assert.equal(promoted.nonce, nonce);
});
