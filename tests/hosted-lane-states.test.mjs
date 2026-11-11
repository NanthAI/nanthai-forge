// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
const start = await import(moduleUrl('../convex/projectHostedStart.ts'));
const reads = await import(moduleUrl('../convex/projectHostedLanes.ts'));
const channels = await import(moduleUrl('../convex/projectHostedChannels.ts'));
const head = 'a'.repeat(64);

test('Lane states: one call reads 100 Lane heads without bodies, bounded per Lane', async () => {
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  const main = {
    schema: 2,
    projectId,
    snapshotId: randomUUID(),
    sourceRevision: 0,
    channel: 'main',
    head,
    authority: { mode: 'server', epoch: 1 },
    receipt: { id: 'main-0', kind: 'server', previousHead: null, previousReceiptId: null },
  };
  await s.call('seed', channels.seed, {
    projectId,
    actor: 'owner',
    operationId: randomUUID(),
    selection: JSON.stringify(main),
  });
  const laneIds = [];
  for (let index = 0; index < 99; index++) {
    const started = JSON.parse(
      await s.call('start', start.start, {
        projectId,
        operationId: randomUUID(),
        authorityEpoch: 1,
        expectedMain: { head, receiptId: 'main-0' },
        intent: { kind: 'new', outcome: `Lane ${index}` },
      }),
    );
    laneIds.push(started.lane.laneId);
  }
  const missing = randomUUID();
  const result = await s.call('states', reads.states, { projectId, laneIds: [...laneIds, missing] });
  assert.equal(result.length, 100);
  assert(result.slice(0, 99).every(row => row.state === 'active' && row.version === 0));
  assert.deepEqual(result.at(-1), { laneId: missing, state: 'missing', version: 0 });
  // Budget: project access plus head, record and lifecycle overlay per Lane; never record bodies.
  const count = s.counts.at(-1);
  assert(count.documents <= 4 * 100 + 5, `documents ${count.documents}`);
  await assert.rejects(
    s.call('states', reads.states, { projectId, laneIds: [...laneIds, missing, randomUUID()] }),
    error => (error.data?.code ?? error.code) === 'BAD_ARGUMENT',
  );
});

test('92f4bf04: one bounded prune read classifies retained terminal/open headers across projects and isolates unavailable access', async t => {
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    key: 'prune-fixture',
    name: 'Prune',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
  });
  const inaccessible = s.insert('hostedProjects', {
    key: 'private-fixture',
    name: 'Private',
    currentBackup: null,
    revision: 0,
    owner: 'other',
    visibility: 'private',
  });
  const laneIds = Array.from({ length: 165 }, () => randomUUID());
  // These are the existing small canonical headers. No source/record bodies need hydration.
  for (const [index, laneId] of laneIds.entries()) {
    const status = index < 72 ? 'completed' : index < 144 ? 'abandoned' : 'active';
    const recordId = s.insert('projectHostedRecords', {
      projectId,
      kind: 'lane',
      key: laneId,
      parent: 'intent',
      status,
      version: 1,
      digest: head,
      bytes: 0,
      inline: '',
      bodyId: s.insert('projectHostedRecordBodies', { projectId, value: '' }),
    });
    s.insert('projectHostedRecordHeads', {
      projectId,
      kind: 'lane',
      key: laneId,
      parent: 'intent',
      status,
      version: 1,
      recordId,
    });
  }
  const hidden = randomUUID(),
    missing = randomUUID();
  const started = performance.now();
  const result = await s.call('pruneStates', reads.states, {
    projectId,
    laneIds: [...laneIds, missing],
    additionalProjects: [{ projectId: inaccessible, laneIds: [hidden] }],
  });
  assert.deepEqual(
    result.slice(0, 165).map(row => row.state),
    laneIds.map((_, index) => (index < 72 ? 'completed' : index < 144 ? 'abandoned' : 'active')),
  );
  assert.match(
    result.find(row => row.laneId === hidden).reason,
    /PROJECT_UNAVAILABLE.*restore project access/,
  );
  assert.match(result.find(row => row.laneId === missing).reason, /Lane record missing/);
  const count = s.counts.at(-1);
  t.diagnostic(
    `165 retained headers: one query, ${count.documents} DB reads, ${count.readBytes} serialized DB bytes, ${Buffer.byteLength(JSON.stringify(result))} response bytes; fake wall ${(performance.now() - started).toFixed(1)}ms; provider billing unmeasured`,
  );
  assert.equal(count.writes, 0);
  assert.equal(count.readDocumentsByTable.projectHostedRecordBodies ?? 0, 0);
  assert(count.documents < 4 * 167 + 10, `bounded header reads: ${count.documents}`);
  await assert.rejects(
    s.call('unauthorized', reads.states, { projectId: inaccessible, laneIds: [hidden] }),
    error => (error.data?.code ?? error.code) === 'PROJECT_UNAVAILABLE',
  );
  await assert.rejects(
    s.call('tooMany', reads.states, {
      projectId,
      laneIds: Array.from({ length: 251 }, () => randomUUID()),
      additionalProjects: [],
    }),
    error => (error.data?.code ?? error.code) === 'BAD_ARGUMENT',
  );
});

test('92f4bf04: empty project selections cannot bypass the bounded prune read page', async () => {
  const s = lanesFixture();
  await assert.rejects(
    s.call('emptyGroups', reads.states, {
      projectId: 'missing',
      laneIds: [],
      additionalProjects: Array.from({ length: 250 }, () => ({ projectId: 'missing', laneIds: [] })),
    }),
    error => (error.data?.code ?? error.code) === 'BAD_ARGUMENT',
  );
  assert.equal(s.counts.at(-1).documents, 0, 'reject before any DB access');
});
