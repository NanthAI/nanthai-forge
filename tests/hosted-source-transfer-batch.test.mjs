// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeFixture, code } from './hosted-compose-fixture.mjs';
import { environment, controls } from './hosted-source-efficiency-fixture.mjs';
import { sourceDispatch } from '../dist/hosted-source-job-controller.js';
import { digest } from '../dist/hash.js';
import { randomUUID } from 'node:crypto';
import { savePin } from '../dist/hosted-save.js';
import { moduleUrl } from './convex-module.mjs';
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));

async function running(t) {
  environment(t);
  const s = await composeFixture(),
    entry = await s.lane(s.baseline),
    selection = s.selection([entry]);
  await s.prepare(selection);
  await s.stage(selection);
  const submitted = await s.submit(selection),
    job = await s.activate(submitted.jobId);
  await s.callback(job, { status: 'heartbeat', sequence: 1 });
  s.patch('hostedProjects', s.projectId, { r2Writes: true });
  const c = controls(t, s),
    dispatch = sourceDispatch(s.projectId, job);
  const args = {
    projectId: s.projectId,
    input: JSON.stringify(dispatch),
    executionId: 'synthetic-execution',
  };
  return { s, c, args, dispatch, entry };
}
test('batch descriptors/grants retain exact pins, current execution, lease, epoch and project access', async t => {
  const { s, c, args } = await running(t);
  const name = 'projectHostedSourceTransferBatch:';
  const refs = JSON.parse(
    await c.call(name + 'describe', { ...args, digests: [s.baseline.sha256, s.baseline.sha256] }),
  );
  assert.deepEqual(refs, [
    { object: s.baseline, recipe: null },
    { object: s.baseline, recipe: null },
  ]);
  const grants = await c.call(name + 'grant', { ...args, action: 'read', pins: [s.baseline, s.baseline] });
  assert.equal(grants.length, 2);
  await assert.rejects(
    c.call(name + 'grant', { ...args, executionId: 'foreign', action: 'read', pins: [s.baseline] }),
    code('SOURCE_JOB_FENCED'),
  );
  await assert.rejects(
    c.call(name + 'describe', { ...args, digests: [digest('foreign')] }),
    code('SOURCE_UNAVAILABLE'),
  );
  await assert.rejects(
    c.call(name + 'grant', { ...args, action: 'read', pins: [{ ...s.baseline, size: s.baseline.size + 1 }] }),
    code('SOURCE_UNAVAILABLE'),
  );
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(
    c.call(name + 'describe', { ...args, digests: [s.baseline.sha256] }),
    code('SOURCE_AUTHORITY_CHANGED'),
  );
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 1 }, removal: 'trash' });
  await assert.rejects(
    c.call(name + 'grant', { ...args, action: 'read', pins: [s.baseline] }),
    code('PROJECT_UNAVAILABLE'),
  );
  s.patch('hostedProjects', s.projectId, { removal: undefined });
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 120000);
  await assert.rejects(
    c.call(name + 'describe', { ...args, digests: [s.baseline.sha256] }),
    code('SOURCE_JOB_FENCED'),
  );
});
test('batched output commits reconcile a lost reply and reject changed epoch/key after HEAD', async t => {
  const { s, c, args, dispatch } = await running(t),
    http = c.http(dispatch);
  const bytes = Buffer.from('new output'),
    pin = { sha256: digest(bytes), size: bytes.length };
  await http.uploadBatch([{ pin, bytes: [bytes] }]);
  const pending = await c.call('projectHostedSourceTransferBatch:pending', { ...args, pins: [pin] });
  assert(pending[0].stored);
  await c.call('projectHostedSourceTransferBatch:commit', { ...args, pins: [pin] });
  const row = [...s.tables.projectObjects.values()].find(row => row.digest === pin.sha256);
  s.patch('projectObjects', row._id, { r2Key: row.r2Key + '/changed' });
  await assert.rejects(
    c.call('projectHostedSourceTransferBatch:verified', { ...args, objects: pending }),
    code('SOURCE_UNAVAILABLE'),
  );
  s.patch('projectObjects', row._id, { r2Key: pending[0].key });
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(
    c.call('projectHostedSourceTransferBatch:verified', { ...args, objects: pending }),
    code('SOURCE_AUTHORITY_CHANGED'),
  );
});
test('batched selection uses canonical lifecycle pins and never returns a foreign or stale selection', async t => {
  const { s, c, entry } = await running(t),
    name = 'projectHostedComposeSelection:page';
  const entries = [entry];
  for (let i = 1; i < 20; i++) entries.push(await s.lane(s.baseline));
  const inputs = entries.map(entry => ({ laneId: entry.laneId }));
  s.counts.length = 0;
  const page = JSON.parse(await c.call(name, { projectId: s.projectId, inputs, dependencies: [] }));
  assert.equal(page.inputs.length, 20);
  assert.deepEqual(page.inputs[0].entry, entry);
  assert.equal(c.stats().calls, 1);
  assert(c.stats().documents <= 300);
  t.diagnostic(JSON.stringify({ selectedRecords: 20, ...c.stats() }));
  const candidate = {
    kind: 'candidate',
    id: randomUUID(),
    version: 0,
    at: '2026-01-01T00:00:00.000Z',
    intentId: s.intentId,
    base: { head: s.baseline.sha256, receiptId: 'main-0' },
    inputs: savePin([]),
    dependencies: savePin([]),
    algorithm: 'forge-native-compose-v1',
    result: { status: 'clean', head: s.baseline.sha256 },
  };
  await s.run('seedCandidate', records.writeHostedRecord, {
    ...s.auth,
    expectedVersion: null,
    record: candidate,
  });
  const dependency = JSON.parse(
    await c.call(name, {
      projectId: s.projectId,
      inputs: [],
      dependencies: [{ candidateId: candidate.id, head: s.baseline.sha256 }],
    }),
  );
  assert.equal(dependency.dependencies[0].entry.head, s.baseline.sha256);
  await assert.rejects(
    c.call(name, {
      projectId: s.projectId,
      inputs: [],
      dependencies: [{ candidateId: candidate.id, head: digest('wrong head') }],
    }),
    code('VIEW_STALE'),
  );
  await assert.rejects(
    c.call(name, {
      projectId: s.projectId,
      inputs: [
        {
          laneId: entry.laneId,
          expected: { head: entry.head, version: 0, sourceVersion: 0, lifecycleVersion: 1 },
        },
      ],
      dependencies: [],
    }),
    code('WORK_STALE'),
  );
  await assert.rejects(
    c.call(name, { projectId: s.projectId, inputs: [{ laneId: 'foreign' }], dependencies: [] }),
    code('NOT_FOUND'),
  );
  s.patch('hostedProjects', s.projectId, { owner: 'another', visibility: 'private' });
  await assert.rejects(
    c.call(name, { projectId: s.projectId, inputs, dependencies: [] }),
    code('PROJECT_UNAVAILABLE'),
  );
});
