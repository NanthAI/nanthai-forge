// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrationFixture, find, objects, nonce } from './source-point-migration-fixture.mjs';
import { digest } from '../dist/hash.js';
import { moduleUrl } from './convex-module.mjs';
const points = await import(moduleUrl('../convex/projectObjectPoints.ts'));
const commits = await import(moduleUrl('../convex/projectObjectCommit.ts'));
const absent = Array.from({ length: 1000 }, (_, index) => digest(`absent-${index}`));

for (const [name, lookup, expected] of [
  ['find', find.findObjects, 3001],
  ['stored', find.findStoredObjects, 3001],
  ['source', find.findSourceObjects, 2001],
  ['point', points.findPointObjects, 1001],
])
  test(`${name} lookup counts empty probes in a full mixed-migration window`, async t => {
    const f = migrationFixture(1);
    f.s.tables.projectObjectCatalog.clear();
    f.s.tables.projectObjectReceipts.set('header', {
      _id: 'header',
      _creationTime: 1,
      projectId: f.projectId,
      key: `source-points:${f.projectId}`,
      value: '1',
    });
    const result = await f.run(ctx => lookup(ctx, f.projectId, absent));
    assert(Array.isArray(result) ? result.every(row => row === null) : result.size === 0);
    const meter = f.measurements.at(-1);
    assert.equal(meter.queries, expected);
    assert.equal(meter.documents, 1, 'only the authority header exists; empty queries still spend budget');
    t.diagnostic(JSON.stringify({ lookup: name, ...meter }));
  });

test('pending primary rows retain source fallback within the same thousand-digest query budget', async t => {
  const f = migrationFixture(1000);
  for (const pin of f.pins)
    f.s.tables.projectObjects.set(pin.digest, {
      _id: pin.digest,
      _creationTime: 1,
      projectId: f.projectId,
      digest: pin.digest,
      size: pin.size,
      nonce,
      removed: false,
      location: 'r2',
      r2Key: `v1/p/${f.projectId}/o/${pin.digest}`,
    });
  f.s.tables.projectObjectReceipts.set('header', {
    _id: 'header',
    _creationTime: 1,
    projectId: f.projectId,
    key: `source-points:${f.projectId}`,
    value: '1',
  });
  const rows = await f.run(ctx =>
    find.findStoredObjects(
      ctx,
      f.projectId,
      f.pins.map(pin => pin.digest),
    ),
  );
  assert.deepEqual(
    rows.map(row => row.digest),
    f.pins.map(pin => pin.digest),
  );
  assert(
    rows.every(row => row.r2Committed && row.pack),
    'uncommitted rows use complete catalog bindings',
  );
  const meter = f.measurements.at(-1);
  assert(meter.queries <= 3001);
  t.diagnostic(JSON.stringify(meter));
});

test('original-ID retry pages count receipt and current-access reads without repeating uploads', async t => {
  const f = migrationFixture(100);
  await f.migrate();
  const ids = Array(100).fill('original-upload');
  assert.deepEqual(await f.call(commits.pendingRows, { actor: 'owner', ids }), []);
  const meter = f.measurements.at(-1);
  assert(meter.queries <= 1000);
  assert.equal(meter.writes, 0);
  t.diagnostic(JSON.stringify(meter));
});

test('internal recovery and clone metadata windows preserve every member after point retirement', async t => {
  const f = migrationFixture(1000);
  await f.migrate();
  const rows = await f.call(objects.resolve, {
    projectId: f.projectId,
    actor: 'owner',
    digests: f.pins.map(pin => pin.digest),
    pageSize: 1000,
  });
  assert.deepEqual(
    rows.map(row => row.digest),
    f.pins.map(pin => pin.digest),
  );
  const meter = f.measurements.at(-1);
  assert(meter.queries <= 2100);
  assert(meter.documents <= 2100);
  t.diagnostic(JSON.stringify(meter));
});
