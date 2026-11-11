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
  await s.ctx.db.insert('forgeAccounts', { owner: 'owner', handle: 'synthetic-owner' });
  await s.ctx.db.insert('accountHandles', { owner: 'owner', handle: 'synthetic-owner' });
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
  // Members see the Forge handle, never the auth subject.
  assert.equal(first.page[0].actor, 'synthetic-owner');
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
test('a public reader of a public project sees live Lanes with no person', async () => {
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
  await s.put({
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
    state: 'active',
    authorityEpoch: 1,
  });
  await s.ctx.db.patch(s.auth.projectId, { visibility: 'public' });
  s.ctx.auth = { getUserIdentity: async () => ({ subject: 'user_publicReader0001' }) };
  const text = await s.call('public', api.list, { projectId: s.auth.projectId, cursor: null, limit: 50 });
  const page = JSON.parse(text).page;
  assert.equal(page.length, 1);
  assert.equal('actor' in page[0], false);
  assert(!text.includes('"owner"') && !text.includes('synthetic-owner'), text);
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

test('Issue and Intent filters page only indexed matching Lanes at project scale, with no writes or source reads', async t => {
  const s = await fixture(),
    intentId = randomUUID(),
    other = randomUUID();
  const putIntent = id =>
    s.put({
      kind: 'intent',
      id,
      version: 0,
      at,
      outcome: 'Filtered task',
      constraints: '',
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base: { head: hash, receiptId: randomUUID() },
      status: 'active',
    });
  await putIntent(intentId);
  await putIntent(other);
  const matching = [];
  for (let i = 0; i < 5; i++) {
    const id = randomUUID();
    matching.push(id);
    await s.put({
      kind: 'lane',
      id,
      version: 0,
      at,
      intentId,
      actor: 'owner',
      base: { head: hash, receiptId: randomUUID() },
      head: hash,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: 'active',
      authorityEpoch: 1,
    });
  }
  const read = params =>
    s
      .call('filtered', api.list, { projectId: s.auth.projectId, cursor: null, limit: 2, ...params })
      .then(JSON.parse);
  const first = await read({ intentId });
  const before = s.counts.at(-1);
  // These records deliberately have no body: touching one proves the filter scanned unrelated work.
  for (let i = 0; i < 10000; i++)
    await s.ctx.db.insert('projectHostedRecordHeads', {
      projectId: s.auth.projectId,
      kind: 'lane',
      key: `unrelated-${i}`,
      parent: other,
      status: 'active',
      version: 0,
      recordId: 'missing-body',
    });
  const again = await read({ intentId });
  assert.deepEqual(again, first);
  assert.deepEqual(s.counts.at(-1), before, 'unrelated project growth adds zero DB I/O');
  assert.equal(before.writes, 0);
  assert(before.documents < 100 && before.readBytes < 32000, JSON.stringify(before));
  const seen = [...first.page];
  let cursor = first.continueCursor;
  while (cursor) {
    const page = await read({ intentId, cursor });
    seen.push(...page.page);
    cursor = page.continueCursor;
  }
  assert.deepEqual(seen.map(row => row.laneId).sort(), matching.sort());
  const byIssue = await read({ planningItemId: intentId });
  assert.deepEqual(byIssue.page, first.page);
  assert.deepEqual((await read({ intentId: randomUUID() })).page, []);
  for (const params of [
    { planningItemId: intentId, intentId: other },
    { intentId: other, cursor: first.continueCursor },
    { cursor: first.continueCursor },
    { planningItemId: 'short' },
  ])
    await assert.rejects(read(params), error => error.data?.code === 'BAD_ARGUMENT');
  t.diagnostic(JSON.stringify({ unrelatedLanes: 10000, page: 2, callsPerPage: 1, ...before }));
});

test('Issue filtering follows the same bounded successor Intent chain as planned start', async () => {
  const { successorIntentId } = await import('../dist/hosted-intent-chain.js');
  const s = await fixture(),
    issue = randomUUID(),
    successor = successorIntentId(issue);
  for (const id of [issue, successor])
    await s.put({
      kind: 'intent',
      id,
      version: 0,
      at,
      outcome: 'Reopened Issue',
      constraints: '',
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base: { head: hash, receiptId: randomUUID() },
      status: id === issue ? 'completed' : 'active',
    });
  const lane = randomUUID();
  await s.put({
    kind: 'lane',
    id: lane,
    version: 0,
    at,
    intentId: successor,
    actor: 'owner',
    base: { head: hash, receiptId: randomUUID() },
    head: hash,
    sourceVersion: 0,
    lifecycleVersion: 0,
    state: 'active',
    authorityEpoch: 1,
  });
  const read = params =>
    s
      .call('reopened', api.list, { projectId: s.auth.projectId, cursor: null, limit: 10, ...params })
      .then(JSON.parse);
  assert.deepEqual(
    (await read({ planningItemId: issue })).page.map(row => row.laneId),
    [lane],
  );
  assert.deepEqual((await read({ intentId: issue })).page, []);
  assert.deepEqual(
    (await read({ planningItemId: issue, intentId: successor })).page.map(row => row.laneId),
    [lane],
  );
});
