// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  const put = (record, planningItemId) =>
    s.run('put', () =>
      records.writeHostedRecord(s.ctx, { ...auth, record, expectedVersion: null, planningItemId }),
    );
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
  await s.ctx.db.insert('forgeAccounts', { owner: 'teammate', handle: 'synthetic-teammate' });
  await s.ctx.db.insert('accountHandles', { owner: 'teammate', handle: 'synthetic-teammate' });
  const lanes = [];
  // The record fixture enforces <=4096 documents and <16 MiB read bytes per transaction.
  for (let i = 0; i < 105; i++) {
    const lane = {
      kind: 'lane',
      id: randomUUID(),
      version: 0,
      at,
      intentId,
      actor: i === 104 ? 'teammate' : 'owner',
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
    authorship: { kind: 'agent' },
    agentRun: 'amber-fox',
    agentClient: 'codex:gpt-example',
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
    await s.call('list', api.list, { projectId: s.auth.projectId, cursor: null, limit: 50, byline: true }),
  );
  assert.equal(first.page.length, 50);
  assert.equal(first.isDone, false);
  assert.equal(first.page[0].laneId, lane.id);
  assert.equal(first.page[0].lastSaveAt, at);
  assert.equal(first.page[0].intent, 'Synthetic outcome');
  // Members see the Forge handle, never the auth subject.
  assert.equal(first.page[0].actor, 'synthetic-owner');
  assert.equal(first.page[0].mine, false, 'the owner who saved it did not start the Lane');
  assert.deepEqual(first.page[0].landing, { submissionId, state: 'checking', scope: 'intent' });
  const count = s.counts.at(-1);
  assert.equal(count.writes, 0);
  const cli = JSON.parse(
    await s.call('legacy', api.list, { projectId: s.auth.projectId, cursor: null, limit: 50 }),
  );
  assert.equal(cli.page[0].actor, 'synthetic-teammate', 'CLI retains the starter contract');
  assert(s.counts.at(-1).documents >= count.documents, 'the byline does not also resolve the starter');
  const { agent, agentRun, agentClient } = first.page[0];
  assert.deepEqual(
    { agent, agentRun, agentClient },
    {
      agent: true,
      agentRun: 'amber-fox',
      agentClient: 'codex:gpt-example',
    },
  );
  const baseline = {
    ...first,
    page: first.page.map(({ agent, agentRun, agentClient, mine, ...row }) => row),
  };
  t.diagnostic(
    `50 Lane rows, one stamped save: ${Buffer.byteLength(JSON.stringify(baseline))} → ${Buffer.byteLength(JSON.stringify(first))} reply bytes`,
  );
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
test('a live Lane row carries lastActivityAt from the Lane record, with no extra read (f0d0fdd6)', async () => {
  const s = await fixture();
  const recent = new Date().toISOString();
  const intentId = randomUUID();
  await s.put({
    kind: 'intent',
    id: intentId,
    version: 0,
    at: recent,
    outcome: 'Synthetic live outcome',
    constraints: '',
    creatorAccountId: 'owner',
    assigneeAccountIds: [],
    base: { head: hash, receiptId: randomUUID() },
    status: 'active',
  });
  const lane = {
    kind: 'lane',
    id: randomUUID(),
    version: 0,
    at: recent,
    intentId,
    actor: 'owner',
    base: { head: hash, receiptId: randomUUID() },
    head: hash,
    sourceVersion: 0,
    lifecycleVersion: 0,
    state: 'active',
    authorityEpoch: 1,
  };
  await s.put(lane);
  const plain = JSON.parse(
    await s.call('list', api.list, { projectId: s.auth.projectId, cursor: null, limit: 50 }),
  );
  const live = JSON.parse(
    await s.call('live', api.list, { projectId: s.auth.projectId, cursor: null, limit: 50, view: 'live' }),
  );
  for (const page of [plain, live]) {
    const [row] = page.page.filter(item => item.laneId === lane.id);
    assert.equal(row.dormant, undefined);
    assert.equal(row.lastActivityAt, recent);
  }
  assert.equal(s.counts.at(-1).writes, 0);
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
    s.put(
      {
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
      },
      id,
    );
  await putIntent(intentId);
  await putIntent(other);
  const matching = [];
  for (let i = 0; i < 5; i++) {
    const id = randomUUID();
    matching.push(id);
    await s.put(
      {
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
      },
      intentId,
    );
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

test('indexed open Lane pages skip closed siblings, reach earlier Intents, and preserve exact-Intent cursors', async () => {
  const { successorIntentId } = await import('../dist/hosted-intent-chain.js');
  const s = await fixture(),
    issue = randomUUID(),
    successor = successorIntentId(issue);
  for (const id of [issue, successor])
    await s.put(
      {
        kind: 'intent',
        id,
        version: 0,
        at,
        outcome: 'Reopened Issue',
        constraints: '',
        creatorAccountId: 'owner',
        assigneeAccountIds: [],
        base: { head: hash, receiptId: randomUUID() },
        status: 'active',
      },
      issue,
    );
  const older = {
    kind: 'lane',
    id: randomUUID(),
    version: 0,
    at,
    intentId: issue,
    actor: 'owner',
    base: { head: hash, receiptId: randomUUID() },
    head: hash,
    sourceVersion: 0,
    lifecycleVersion: 0,
    state: 'active',
    authorityEpoch: 1,
  };
  const newer = { ...older, id: randomUUID(), intentId: successor };
  await s.put(older, issue);
  await s.put(newer, issue);
  const newest = { ...newer, id: randomUUID() };
  await s.put(newest, issue);
  for (let i = 0; i < 101; i++) await s.put({ ...newer, id: randomUUID(), state: 'completed' }, issue);
  const read = params =>
    s
      .call('reopened', api.list, { projectId: s.auth.projectId, cursor: null, limit: 1, ...params })
      .then(JSON.parse);
  const filter = { planningItemId: issue };
  const exact = { intentId: successor };
  const before = await read(exact);
  assert(before.continueCursor);
  assert.deepEqual(
    (await read({ ...exact, cursor: before.continueCursor })).page.map(row => row.laneId),
    [newer.id],
  );
  const current = await read({ ...filter, limit: 50 });
  assert.deepEqual(
    current.page.map(row => row.laneId),
    [newest.id, newer.id],
  );
  const first = await read(filter);
  assert.deepEqual(
    first.page.map(row => row.laneId),
    [newest.id],
  );
  assert(first.continueCursor);
  const second = await read({ ...filter, cursor: first.continueCursor });
  assert.deepEqual(
    second.page.map(row => row.laneId),
    [newer.id],
  );
  const third = await read({ ...filter, cursor: second.continueCursor });
  assert.deepEqual(
    third.page.map(row => row.laneId),
    [older.id],
  );
  assert.equal(third.continueCursor, null);
  assert.deepEqual(
    (await read({ ...filter, intentId: issue })).page.map(row => row.laneId),
    [older.id],
  );
  await assert.rejects(
    read({ ...filter, intentId: issue, cursor: first.continueCursor }),
    error => error.data?.code === 'BAD_ARGUMENT',
  );
});

test('the CLI Loose ends view reads the reply the hosted transport already decoded, and still accepts JSON text', async () => {
  const { liveLanes } = await import('../dist/hosted-live-lanes.js');
  const reply = { at: 1, setAside: null, groups: { stopped: { reported: true, rows: [], more: false } } };
  for (const sent of [reply, JSON.stringify(reply)]) {
    const calls = [];
    const transport = {
      query: async (name, args) => {
        calls.push([name, args]);
        return sent;
      },
    };
    const result = await liveLanes(transport, { view: 'loose-ends' });
    assert.deepEqual(result.result, reply);
    assert.deepEqual(calls, [['projectLooseEnds:read', { details: true }]]);
  }
});

test('a Loose ends cursor cannot restart the flat list or continue from a different view', async () => {
  const { liveLanes } = await import('../dist/hosted-live-lanes.js');
  const transport = {
    query: async () => assert.fail('a cursor from a different view must not query the server'),
  };
  for (const args of [
    { view: 'all', cursor: 'forge-loose-ends-stopped-v1:page' },
    { view: 'loose-ends', cursor: 'forge-lanes-v1:page' },
  ]) {
    await assert.rejects(liveLanes(transport, args), error => error.code === 'BAD_ARGUMENT');
  }
});

test('the Lanes page reads one page as wide as the line feed: bytes at 60 and at 100 open Lanes (6ebb58ab)', async t => {
  // At 60 a busy project's older Lanes had no title or person on the page ("Lane <id> · not reported"). The page now
  // reads the feed's 100; one bounded read, no extra call. Dogfood-shaped: each Lane saved once, one Intent each.
  const s = await fixture();
  for (let i = 0; i < 100; i++) {
    const intentId = randomUUID();
    await s.put({
      kind: 'intent',
      id: intentId,
      version: 0,
      at,
      outcome: `Synthetic outcome ${i} `.padEnd(120, 'x'),
      constraints: '',
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base: { head: hash, receiptId: randomUUID() },
      status: 'active',
    });
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
      state: 'active',
      authorityEpoch: 1,
    };
    await s.put(lane);
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
  }
  const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const LANE_PAGE = Number(
    /export const LANE_PAGE = (\d+);/.exec(source('../web/src/app/lanes/reads.ts'))[1],
  );
  const feedWindow = Number(/\.take\((\d+)\)/.exec(source('../convex/projectLiveLine.ts'))[1]);
  assert.equal(LANE_PAGE, feedWindow - 1, 'the page is the line feed window, so every mark has its title');
  const cost = {};
  for (const limit of [60, LANE_PAGE]) {
    const reply = await s.call(`list-${limit}`, api.list, {
      projectId: s.auth.projectId,
      cursor: null,
      limit,
    });
    const page = JSON.parse(reply).page;
    assert.equal(page.length, limit);
    assert.ok(page.every(lane => lane.intent && lane.actor === 'synthetic-owner' && lane.lastSaveAt === at));
    cost[limit] = { ...s.counts.at(-1), replyBytes: Buffer.byteLength(reply) };
  }
  t.diagnostic(JSON.stringify(cost));
  console.log(`lanes page: ${JSON.stringify(cost)}`);
  assert.equal(cost[LANE_PAGE].writes, 0);
  assert.ok(
    cost[LANE_PAGE].documents <= (cost[60].documents * LANE_PAGE) / 60 + 4,
    'documents grow with the page only',
  );
  assert.ok(cost[LANE_PAGE].readBytes < 2 * 1024 * 1024, JSON.stringify(cost[LANE_PAGE]));
});

test('lanes tree view (57c6f3ec): stack parents, holds and overlaps from the one page read, at most one presence read per Lane', async t => {
  const s = await fixture();
  const intentId = randomUUID();
  await s.put({
    kind: 'intent',
    id: intentId,
    version: 0,
    at,
    outcome: 'Synthetic tree outcome',
    constraints: '',
    creatorAccountId: 'owner',
    assigneeAccountIds: [],
    base: { head: hash, receiptId: randomUUID() },
    status: 'active',
  });
  const lane = (extra = {}) => ({
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
    ...extra,
  });
  const parent = lane(),
    child = lane({ stack: { laneId: parent.id, head: hash } }),
    peer = lane(),
    alone = lane();
  for (const row of [parent, child, peer, alone]) await s.put(row);
  // The Lane record write keeps each open Lane's slim presence row; give it saved paths.
  const presence = async (laneId, paths) => {
    const row = await s.ctx.db
      .query('projectHostedPresence')
      .withIndex('by_project_and_lane', q => q.eq('projectId', s.auth.projectId).eq('laneId', laneId))
      .first();
    if (row) await s.ctx.db.patch(row._id, { paths, pathCount: paths.length });
    else
      await s.ctx.db.insert('projectHostedPresence', {
        projectId: s.auth.projectId,
        laneId,
        intentId,
        actor: 'owner',
        goal: 'Synthetic tree outcome',
        paths,
        pathCount: paths.length,
        at: 1,
      });
  };
  await presence(parent.id, ['src/shared.ts', 'src/parent.ts']);
  await presence(child.id, ['src/shared.ts']);
  await presence(peer.id, ['src/shared.ts', 'src/peer.ts']);
  await presence(alone.id, ['src/alone.ts']);
  const list = view =>
    s.call(`list-${view}`, api.list, { projectId: s.auth.projectId, cursor: null, limit: 50, view });
  const plain = JSON.parse(await list('all')),
    plainCount = s.counts.at(-1);
  const tree = JSON.parse(await list('tree')),
    treeCount = s.counts.at(-1);
  assert.equal(tree.page.length, plain.page.length);
  const row = id => tree.page.find(entry => entry.laneId === id);
  assert.equal(row(child.id).stackOn, parent.id);
  assert.equal(row(parent.id).stackOn, null);
  // A Lane and the Lane it stacks on never overlap; a peer sharing a saved path does.
  assert.deepEqual(row(parent.id).overlaps, [{ laneId: peer.id, paths: ['src/shared.ts'] }]);
  assert.deepEqual(
    row(peer.id)
      .overlaps.map(o => o.laneId)
      .sort(),
    [parent.id, child.id].sort(),
  );
  assert.equal(row(alone.id).overlaps, undefined);
  // Cost guard: the same one query, no writes, at most one presence document per listed Lane.
  assert.equal(treeCount.writes, 0);
  assert(
    treeCount.documents <= plainCount.documents + tree.page.length,
    JSON.stringify({ plainCount, treeCount }),
  );
  t.diagnostic(JSON.stringify({ plainCount, treeCount }));
  assert(!('stackOn' in plain.page[0]), 'the default page is unchanged');
});

test('the CLI lanes tree is one transport query, renders children under their parent and names overlaps (57c6f3ec)', async () => {
  const { liveLanes } = await import('../dist/hosted-live-lanes.js');
  const parent = '11111111-1111-4111-8111-111111111111',
    child = '22222222-2222-4222-8222-222222222222',
    peer = '33333333-3333-4333-8333-333333333333';
  const page = [
    {
      laneId: parent,
      intent: 'Parent work',
      lastSaveAt: at,
      landing: null,
      stackOn: null,
      overlaps: [{ laneId: peer, paths: ['src/shared.ts'] }],
    },
    { laneId: child, intent: 'Child work', lastSaveAt: at, landing: null, stackOn: parent },
    {
      laneId: peer,
      intent: 'Peer work',
      lastSaveAt: at,
      landing: { state: 'checking' },
      stackOn: null,
      held: 'main-red',
    },
  ];
  const calls = [];
  const transport = {
    root: '/synthetic',
    query: async (name, args) => {
      calls.push([name, args]);
      return { page, isDone: true, continueCursor: null };
    },
  };
  const { result } = await liveLanes(transport, { view: 'tree' });
  assert.deepEqual(calls, [['projectHostedLiveLanes:list', { view: 'tree', cursor: null, limit: 50 }]]);
  assert.deepEqual(result.tree, [
    '11111111 [saved] Parent work · next: land --save',
    '│  overlaps: 33333333 (src/shared.ts)',
    '└─ 22222222 [saved] Child work · next: land after 11111111',
    `33333333 [held] Peer work · next: status {"laneId":"${peer}"} names its wait`,
  ]);
});

test('an Issue with no open Lane still names a preserved Lane that holds unlanded saved work (986422c9)', async () => {
  const { liveLanes } = await import('../dist/hosted-live-lanes.js');
  const issue = '44444444-4444-4444-8444-444444444444';
  const kept = { laneId: '55555555-5555-4555-8555-555555555555', state: 'open', run: 'x' };
  const landed = {
    laneId: '66666666-6666-4666-8666-666666666666',
    state: 'closed',
    receipt: { receiptId: 'r' },
  };
  const calls = [];
  const transport = {
    root: '/synthetic',
    query: async (name, args) => {
      calls.push(name);
      return name === 'projectItemWork:read'
        ? { lanes: [kept, landed], total: 2 }
        : { page: [], isDone: true, continueCursor: null };
    },
  };
  const { result } = await liveLanes(transport, { planningItemId: issue });
  assert.deepEqual(result.preserved, [kept]);
  assert.deepEqual(calls, ['projectHostedLiveLanes:list', 'projectItemWork:read']);
  calls.length = 0;
  const open = {
    query: async name => (calls.push(name), { page: [{ laneId: 'a' }], isDone: true }),
    root: '/s',
  };
  await liveLanes(open, { planningItemId: issue });
  assert.deepEqual(calls, ['projectHostedLiveLanes:list'], 'a non-empty open list costs no extra read');
});
