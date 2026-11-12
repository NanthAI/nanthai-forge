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

test('Done-when5: page retries are byte stable and keep pending uploads, State provenance, nonce placements and recipe closures', async () => {
  const f = migrationFixture(402),
    preserved = [];
  for (const [index, extra] of [
    { r2Committed: false },
    { r2Committed: false, packMembers: [{ digest: digest('pending member'), size: 1 }] },
    {
      stateGeneration: 2,
      stateParents: [digest('parent')],
      statePhysical: { sha256: digest('root'), size: 123 },
      stateSize: { fileCount: 29000, manifestBytes: 321 },
    },
    { recipe: { digest: digest('recipe'), size: 10 }, recipeClosure: [{ sha256: digest('leaf'), size: 1 }] },
    { r2Key: `v1/p/project/o/${digest('retained-4')}/u/${nonce}` },
  ].entries()) {
    const id = `retained-${index}`,
      row = {
        _id: id,
        _creationTime: 1,
        projectId: f.projectId,
        digest: digest(id),
        size: index === 2 ? 321 : 7,
        nonce,
        removed: false,
        sourceReferenced: true,
        location: 'r2',
        r2Key: `v1/p/project/o/${digest(id)}`,
        r2Committed: true,
        ...extra,
      };
    f.s.tables.projectObjects.set(id, row);
    preserved.push([id, structuredClone(row)]);
  }
  let after = null,
    result;
  do {
    const input = { projectId: f.projectId, actor: 'owner', operationId: 'retry-page', points: true, after };
    const value = await f.call(compact.step, input);
    assert.equal(await f.call(compact.step, input), value);
    assert.equal(f.measurements.at(-1).writes, 0, 'lost page result reconciles without another write');
    result = JSON.parse(value);
    after = result.after;
  } while (!result.done);
  for (const [id, row] of preserved) assert.deepEqual(f.s.tables.projectObjects.get(id), row);
  const pending = await f.call(commits.pendingRows, { actor: 'owner', ids: ['retained-0', 'retained-1'] });
  assert.equal(pending.length, 2);
  assert.equal(pending[1].members.length, 1);
  await assert.rejects(
    f.call(commits.pendingRows, { actor: 'stranger', ids: ['original-upload'] }),
    error => (error.code ?? error.data?.code) === 'PROJECT_UNAVAILABLE',
  );
});

test('Done-when5: retained reads borrow complete bindings without consuming overlapping pending raw or pack upload identities', async () => {
  const f = migrationFixture(10);
  await f.migrate();
  const downloads = await import(moduleUrl('../convex/projectObjectDownloads.ts'));
  const saves = await import(moduleUrl('../convex/projectHostedSaveStore.ts'));
  const output = await import(moduleUrl('../convex/projectConvexSourceOutput.ts'));
  const pack = f.pins[0].pack;
  const carrier = {
    _id: 'carrier',
    _creationTime: 1,
    projectId: f.projectId,
    digest: pack.digest,
    size: pack.size,
    nonce,
    removed: false,
    sourceReferenced: true,
    location: 'r2',
    r2Key: `v1/p/project/o/${pack.digest}`,
    r2Committed: true,
  };
  f.s.tables.projectObjects.set(carrier._id, carrier);
  for (const pendingPack of [false, true]) {
    const pin = f.pins[pendingPack ? 1 : 0],
      id = pendingPack ? 'pending-pack' : 'pending-raw';
    const row = {
      _id: id,
      _creationTime: 1,
      projectId: f.projectId,
      digest: pin.digest,
      size: pin.size,
      nonce,
      removed: false,
      sourceReferenced: false,
      location: 'r2',
      r2Key: `v1/p/project/o/${pin.digest}`,
      r2Committed: false,
      ...(pendingPack
        ? {
            packMembers: [
              { digest: digest('first fragment'), size: 512 },
              { digest: digest('second fragment'), size: 512 },
            ],
          }
        : {}),
    };
    f.s.tables.projectObjects.set(id, row);
    const before = structuredClone(row);
    assert.equal(
      (await f.run(ctx => find.findObject(ctx, f.projectId, pin.digest)))._id,
      id,
      'upload authority still sees its primary pending row',
    );
    const [read] = await f.call(objects.resolve, {
      projectId: f.projectId,
      actor: 'owner',
      digests: [pin.digest],
    });
    assert.deepEqual(read.pack, pin.pack);
    assert(read.r2Committed && read.sourceReferenced);
    const signed = await f.call(downloads.describe, {
      projectId: f.projectId,
      digests: [pin.digest],
      signed: true,
    });
    assert(new URL(signed[0].url).pathname.endsWith(`/o/${pack.digest}`));
    assert.deepEqual(
      await f.run(ctx => saves.saveObjects(ctx, f.projectId, [{ sha256: pin.digest, size: pin.size }])),
      [{ object: { sha256: pin.digest, size: pin.size }, recipe: null }],
    );
    assert.deepEqual(
      f.s.tables.projectObjects.get(id),
      before,
      'reads and source staging do not commit or relayout the pending upload',
    );
    assert.equal((await f.call(commits.pendingRows, { actor: 'owner', ids: [id] }))[0].key, row.r2Key);
    if (pendingPack) {
      await f.run(ctx =>
        output.storeSourceOutputs(ctx, f.projectId, 'trusted-source', [
          { sha256: pin.digest, size: pin.size, r2Key: carrier.r2Key, pack: pin.pack },
        ]),
      );
      assert.deepEqual(
        f.s.tables.projectObjects.get(id),
        before,
        'source publication cannot skip pending pack member verification',
      );
      assert.equal((await f.call(commits.pendingRows, { actor: 'owner', ids: [id] }))[0].members.length, 2);
      const { sourceKeyReferenced } = await import(moduleUrl('../convex/projectSourceKeyProtection.ts'));
      assert.equal(await f.run(ctx => sourceKeyReferenced(ctx, f.projectId, row.r2Key)), false);
      await f.run(ctx =>
        output.storeSourceOutputs(ctx, f.projectId, 'trusted-new-placement', [
          { sha256: pin.digest, size: pin.size, r2Key: row.r2Key },
        ]),
      );
      assert(
        await f.run(ctx => sourceKeyReferenced(ctx, f.projectId, row.r2Key)),
        'the additional verified source key stays live',
      );
      assert.deepEqual(
        f.s.tables.projectObjects.get(id),
        before,
        'retaining a source key never verifies pending members',
      );
      assert.equal((await f.call(commits.pendingRows, { actor: 'owner', ids: [id] }))[0].members.length, 2);
      const verified = JSON.parse(
        await f.call(compact.verify, { projectId: f.projectId, actor: 'owner', cursor: null }),
      );
      assert(verified.checked > 0);
    }
  }
});
