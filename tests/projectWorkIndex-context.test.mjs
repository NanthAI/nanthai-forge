// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { fixture } from './project-exchange-fixture.mjs';
const { rows, rowBatch } = await import(moduleUrl('../convex/projectWorkIndexBuildStore.ts'));
const selected = { projectId: 'project', owner: 'owner', generationId: 'generation' };
const code = expected => e => (e.data?.code ?? e.code) === expected;

test('summary context windows retain row order, paging, current authority and generation identity', async () => {
  const s = fixture();
  s.tables.projectWorkGenerations.set('generation', { _id: 'generation', projectId: 'project' });
  for (let i = 0; i < 102; i++)
    s.tables.projectWorkRecords.set(`row-${i}`, {
      _id: `row-${i}`,
      generationId: 'generation',
      projectId: 'project',
      collection: '_buildSubmission',
      key: `key-${i}`,
      parent: 'lane',
      position: i,
      value: JSON.stringify({ head: `${i}` }),
    });
  const requests = [
    { collection: '_buildSubmission', parent: 'lane' },
    { collection: '_buildSubmission', parent: 'lane', offset: 100 },
    { collection: '_buildSubmission', parent: 'lane', last: true },
  ];
  const batch = await rowBatch._handler(s.ctx, { ...selected, requests });
  assert.deepEqual(
    batch.map(r => r.length),
    [100, 2, 1],
  );
  for (const [i, request] of requests.entries())
    assert.deepEqual(batch[i], await rows._handler(s.ctx, { ...selected, ...request }));
  await assert.rejects(
    rowBatch._handler(s.ctx, { ...selected, owner: 'stranger', requests }),
    code('PROJECT_UNAVAILABLE'),
  );
  s.tables.projectWorkGenerations.get('generation').projectId = 'other';
  await assert.rejects(rowBatch._handler(s.ctx, { ...selected, requests }), code('WORK_STALE'));
});

test('large summary context returns a complete prefix so remaining requests can fall back', async () => {
  const s = fixture();
  s.tables.projectWorkGenerations.set('generation', { _id: 'generation', projectId: 'project' });
  s.tables.projectWorkRecords.set('large', {
    _id: 'large',
    generationId: 'generation',
    projectId: 'project',
    collection: '_buildLocalAcceptance',
    key: 'large',
    parent: 'view',
    position: 0,
    value: 'x'.repeat(510000),
  });
  const request = { collection: '_buildLocalAcceptance', parent: 'view' };
  const batch = await rowBatch._handler(s.ctx, { ...selected, requests: [request, request] });
  assert.equal(batch.length, 1);
  assert.equal(batch[0][0].value.length, 510000);
  assert.deepEqual(await rows._handler(s.ctx, { ...selected, ...request }), batch[0]);
});
