// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const api = await import(moduleUrl('../convex/projectHostedLiveLanes.ts'));
const hash = 'a'.repeat(64),
  at = '2026-01-01T00:00:00.000Z';
async function fixture() {
  const s = recordsFixture(),
    auth = await s.setup();
  s.ctx.auth = { getUserIdentity: async () => ({ subject: 'owner' }) };
  const put = record =>
    s.run('put', () => records.writeHostedRecord(s.ctx, { ...auth, record, expectedVersion: null }));
  return { ...s, auth, put };
}
test('live Lanes are paged with joined Intent, actor, save and landing metadata; read cost stays O(page)', async t => {
  const s = await fixture();
  const intentId = randomUUID();
  await s.put({
    kind: 'intent',
    id: intentId,
    version: 0,
    at,
    outcome: 'Synthetic outcome',
    constraints: '',
    creatorAccountId: 'owner',
    assigneeAccountIds: [],
    base: { head: hash, receiptId: randomUUID() },
    status: 'active',
  });
  const lanes = [];
  // The record fixture enforces <=4096 documents and <16 MiB read bytes per transaction.
  for (let i = 0; i < 105; i++) {
    const lane = {
      kind: 'lane',
      id: randomUUID(),
      version: 0,
      at,
      intentId,
      actor: 'owner',
      base: { head: hash, receiptId: randomUUID() },
      head: hash,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: i === 0 ? 'completed' : 'active',
      authorityEpoch: 1,
    };
    await s.put(lane);
    lanes.push(lane);
  }
  const lane = lanes.at(-1);
  await s.put({
    kind: 'save',
    id: randomUUID(),
    version: 0,
    at,
    laneId: lane.id,
    actor: 'owner',
    operationId: randomUUID(),
    expectedHead: hash,
    expectedSourceVersion: 0,
    head: hash,
    sourceVersion: 1,
    changes: { sha256: hash, size: 1 },
  });
  const candidateId = randomUUID(),
    submissionId = randomUUID();
  await s.put({
    kind: 'candidate',
    id: candidateId,
    version: 0,
    at,
    intentId,
    base: lane.base,
    inputs: { sha256: hash, size: 1 },
    dependencies: { sha256: hash, size: 1 },
    algorithm: 'native-v1',
    result: { status: 'clean', head: hash },
  });
  await s.ctx.db.insert('projectHostedLandingRequests', {
    projectId: s.auth.projectId,
    channel: 'main',
    submissionId,
    operationId: randomUUID(),
    candidateId,
    actor: 'owner',
    sequence: 1,
    runnable: true,
    phase: 'checking',
    runId: null,
    attemptId: randomUUID(),
    value: '{}',
  });
  const first = JSON.parse(
    await s.call('list', api.list, { projectId: s.auth.projectId, cursor: null, limit: 50 }),
  );
  assert.equal(first.page.length, 50);
  assert.equal(first.isDone, false);
  assert.equal(first.page[0].laneId, lane.id);
  assert.equal(first.page[0].lastSaveAt, at);
  assert.equal(first.page[0].intent, 'Synthetic outcome');
  assert.equal(first.page[0].actor, 'owner');
  assert.deepEqual(first.page[0].landing, { submissionId, state: 'checking', scope: 'intent' });
  const count = s.counts.at(-1);
  assert.equal(count.writes, 0);
  assert(count.documents <= 1100, JSON.stringify(count));
  assert(count.readBytes < 2 * 1024 * 1024, JSON.stringify(count));
  t.diagnostic(JSON.stringify(count));
  const seen = [...first.page];
  let cursor = first.continueCursor;
  while (cursor) {
    const page = JSON.parse(
      await s.call('list-next', api.list, { projectId: s.auth.projectId, cursor, limit: 50 }),
    );
    seen.push(...page.page);
    cursor = page.continueCursor;
  }
  assert.equal(seen.length, 104);
  assert.equal(new Set(seen.map(row => row.laneId)).size, 104);
  assert(!seen.some(row => row.laneId === lanes[0].id));
});
test('live Lane reads require current access and validate page size', async () => {
  const s = await fixture();
  await assert.rejects(
    s.call('invalid', api.list, { projectId: s.auth.projectId, cursor: null, limit: 101 }),
    error => error.data?.code === 'BAD_ARGUMENT',
  );
  s.ctx.auth = { getUserIdentity: async () => null };
  await assert.rejects(
    s.call('anonymous', api.list, { projectId: s.auth.projectId, cursor: null, limit: 50 }),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  s.ctx.auth = { getUserIdentity: async () => ({ subject: 'outsider' }) };
  await assert.rejects(
    s.call('outsider', api.list, { projectId: s.auth.projectId, cursor: null, limit: 50 }),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
});
