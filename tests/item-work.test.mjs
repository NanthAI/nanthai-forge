// SPDX-License-Identifier: Apache-2.0
// What happened on one Item (Issue 1c2ab97a): the Item's Lanes in every state through the Intent→Lane link, landed
// ones with their receipt (landing note first, overlap stamp for older landings), paged past 20 with a total; the
// people rule per viewer; and the agent's `planning {id}` `work` section and `lanes {state:"all"}` over it.
// Incident: Items d4b68402 and 16093ed1 read open with no linked work although their Lanes had landed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const work = await import(moduleUrl('../convex/projectItemWork.ts'));
const { liveLanes } = await import(moduleUrl('../src/hosted-live-lanes.ts'));
const hash = 'a'.repeat(64),
  other = 'b'.repeat(64),
  at = '2026-01-01T00:00:00.000Z';

async function fixture({ extra = 0 } = {}) {
  const s = recordsFixture(),
    auth = await s.setup();
  const as = subject => {
    s.ctx.auth = { getUserIdentity: async () => (subject ? { subject } : null) };
  };
  as('owner');
  await s.ctx.db.insert('forgeAccounts', { owner: 'owner', handle: 'synthetic-owner' });
  await s.ctx.db.insert('accountHandles', { owner: 'owner', handle: 'synthetic-owner' });
  const put = record =>
    s.run('put', () => records.writeHostedRecord(s.ctx, { ...auth, record, expectedVersion: null }));
  const itemId = randomUUID();
  await put({
    kind: 'intent',
    id: itemId,
    version: 0,
    at,
    outcome: 'Synthetic outcome',
    constraints: '',
    creatorAccountId: 'owner',
    assigneeAccountIds: [],
    base: { head: hash, receiptId: randomUUID() },
    status: 'active',
  });
  const lane = async state => {
    const record = {
      kind: 'lane',
      id: randomUUID(),
      version: 0,
      at,
      intentId: itemId,
      actor: 'owner',
      base: { head: hash, receiptId: randomUUID() },
      head: other,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state,
      authorityEpoch: 1,
    };
    await put(record);
    return record;
  };
  const abandoned = await lane('abandoned');
  const stamped = await lane('completed');
  for (let i = 0; i < extra; i++) await lane('abandoned');
  const noted = await lane('completed');
  const open = await lane('active');
  // A landing since 3a733ee8 writes a note per Intent; an older one left only the overlap row's stamp.
  const noteReceipt = randomUUID(),
    stampReceipt = randomUUID();
  await s.ctx.db.insert('projectIntentLandingNotes', {
    projectId: auth.projectId,
    intentId: itemId,
    receiptId: noteReceipt,
    kind: 'landed',
    at,
    laneIds: [noted.id],
    commit: 'c'.repeat(40),
    sequence: 42,
    actor: 'owner',
    landedBy: { by: 'queue', review: 'none' },
  });
  const overlap = [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === stamped.id);
  const stamp = { landed: { receiptId: stampReceipt, commit: 'd'.repeat(40), laneHead: other, at } };
  if (overlap) await s.ctx.db.patch(overlap._id, stamp);
  else
    await s.ctx.db.insert('projectHostedOverlapLanes', {
      projectId: auth.projectId,
      laneId: stamped.id,
      intentId: itemId,
      actor: 'owner',
      head: other,
      baseHead: hash,
      baseReceiptId: randomUUID(),
      baseSequence: 1,
      recordVersion: 0,
      open: false,
      changes: '[]',
      complete: true,
      ...stamp,
    });
  const read = async (args = {}, name = 'read') =>
    JSON.parse(await s.call(name, work.read, { projectId: auth.projectId, itemId, ...args }));
  return { ...s, auth, as, itemId, open, noted, stamped, abandoned, noteReceipt, stampReceipt, read };
}

/** A live submission of the Item's Intent: its newest Candidate head and that Candidate's landing request. */
async function submit(s, patch = {}) {
  const candidateId = randomUUID();
  const recordId = [...s.tables.projectHostedRecords.keys()][0];
  await s.ctx.db.insert('projectHostedRecordHeads', {
    projectId: s.auth.projectId,
    kind: 'candidate',
    key: candidateId,
    parent: s.itemId,
    status: 'clean',
    version: 0,
    recordId,
  });
  await s.ctx.db.insert('projectHostedLandingRequests', {
    projectId: s.auth.projectId,
    channel: 'main',
    candidateId,
    submissionId: 'submission-1',
    operationId: randomUUID(),
    actor: 'owner',
    phase: 'queued',
    sequence: 1,
    runnable: true,
    runId: null,
    attemptId: randomUUID(),
    value: '{}',
    ...patch,
  });
}

test('an Item read lists its Lanes in every state, landed ones with receipt, commit and time; no writes', async t => {
  const s = await fixture();
  const seen = await s.read();
  assert.equal(seen.role, true);
  assert.equal(seen.intent, 'active', 'the Item Intent state rides on the same read');
  assert.equal(seen.total, 4);
  assert.equal(seen.nextCursor, null);
  assert.equal(seen.lanes[0].laneId, s.open.id, 'open Lanes come first');
  const byLane = Object.fromEntries(seen.lanes.map(lane => [lane.laneId, lane]));
  assert.equal(byLane[s.open.id].state, 'open');
  assert.equal(byLane[s.open.id].head, other, 'the saved head');
  assert.equal(byLane[s.open.id].lastActivityAt, at);
  assert.equal(byLane[s.abandoned.id].state, 'abandoned');
  assert.equal(byLane[s.abandoned.id].receipt, undefined);
  assert.deepEqual(byLane[s.noted.id].receipt, {
    receiptId: s.noteReceipt,
    commit: 'c'.repeat(40),
    at,
    sequence: 42,
    landedBy: 'queue',
  });
  assert.deepEqual(byLane[s.stamped.id].receipt, { receiptId: s.stampReceipt, commit: 'd'.repeat(40), at });
  assert.equal(byLane[s.open.id].actor, 'synthetic-owner', 'writers see the handle, never the account id');
  const count = s.counts.at(-1);
  t.diagnostic(JSON.stringify(count));
  assert.equal(count.writes, 0);
  // Budget: chain head + one Lane range + 4 Lane records (project, head, record, body each) + one notes range + one
  // overlap point read: 30 documents, about 8 KB.
  assert(count.documents <= 32, JSON.stringify(count));
  assert(count.readBytes < 12 * 1024, JSON.stringify(count));
});

test('an open Lane reads queued while its Intent has a live submission, parked while it waits', async () => {
  const s = await fixture();
  await submit(s);
  assert.equal((await s.read()).lanes[0].state, 'queued');
  const [request] = [...s.tables.projectHostedLandingRequests.values()];
  await s.ctx.db.patch(request._id, { orderWait: 'older-submission' });
  const parked = (await s.read({}, 'parked')).lanes[0];
  assert.equal(parked.state, 'parked');
  assert.deepEqual(parked.landing, { submissionId: 'submission-1', phase: 'queued' });
  await s.ctx.db.patch(request._id, { phase: 'terminal-failed' });
  assert.equal(
    (await s.read({}, 'failed')).lanes[0].state,
    'open',
    'a failed submission leaves the Lane open',
  );
  const red = await fixture();
  await submit(red, { phase: 'ready', hold: 'main-red' });
  assert.equal((await red.read()).lanes[0].state, 'parked', 'a ready entry held for a red main is parked');
});

test('past 20 Lanes the read pages with a total and a cursor, without repeats', async () => {
  const s = await fixture({ extra: 22 });
  const first = await s.read();
  assert.equal(first.total, 26);
  assert.equal(first.lanes.length, 20);
  assert.ok(first.nextCursor);
  const second = await s.read({ cursor: first.nextCursor }, 'second');
  assert.equal(second.lanes.length, 6);
  assert.equal(second.nextCursor, null);
  const ids = [...first.lanes, ...second.lanes].map(lane => lane.laneId);
  assert.equal(new Set(ids).size, 26);
  await assert.rejects(s.read({ cursor: 'forge-item-work-v1:x' }, 'bad'), error =>
    (error.data?.code ?? error.code ?? error.message).includes('BAD_ARGUMENT'),
  );
});

test('owner, teammate, reader and public visitors see the Lanes by the people rule; strangers and signed out see none', async () => {
  const s = await fixture();
  const forbidden = error =>
    (error.data?.code ?? error.code ?? error.message).includes('PROJECT_UNAVAILABLE');
  await s.ctx.db.insert('projectContributors', { projectId: s.auth.projectId, contributor: 'mate' });
  s.as('mate');
  const mate = await s.read({}, 'mate');
  assert.equal(mate.total, 4);
  assert.equal(mate.lanes[0].actor, 'synthetic-owner', 'a teammate sees the handle');
  await s.ctx.db.insert('projectReaders', { projectId: s.auth.projectId, reader: 'reader' });
  s.as('reader');
  const reader = await s.read({}, 'reader');
  assert.equal(reader.total, 4);
  assert.ok(!JSON.stringify(reader).includes('owner'), 'no account id or handle reaches a reader');
  s.as('stranger');
  await assert.rejects(s.read({}, 'stranger'), forbidden);
  s.as(null);
  assert.deepEqual(await s.read({}, 'signed-out'), { role: false });
  // A public project: any signed-in visitor reads the Lanes of a public Item, with no person named.
  await s.ctx.db.patch(s.auth.projectId, { visibility: 'public' });
  s.as('visitor');
  // The Intent has no plan Item yet: a visitor's selection the plan rule cannot tie to a visible Item answers as
  // absent (Item 76be0714).
  assert.equal((await s.read({}, 'visitor')).total, 0, 'an Intent with no visible plan Item');
  const project = await s.ctx.db.get(s.auth.projectId);
  const backupId = project.work?.backupId ?? 'backup';
  const generationId = await s.ctx.db.insert('projectWorkGenerations', {
    projectId: s.auth.projectId,
    backupId,
    format: 11,
    status: 'ready',
    initialRevision: 0,
    revision: 0,
    nextBatch: 0,
    metadata: '{"schema":24}',
  });
  await s.ctx.db.patch(s.auth.projectId, {
    work: {
      operationId: randomUUID(),
      initialRevision: 0,
      revision: 0,
      ...project.work,
      generationId,
      backupId,
    },
  });
  await s.ctx.db.insert('projectPlanningRecords', {
    projectId: s.auth.projectId,
    generationId,
    collection: 'planningSearch',
    key: s.itemId,
    parent: '',
    position: 0,
    value: JSON.stringify({
      id: s.itemId,
      kind: 'issue',
      status: 'open',
      title: 'Synthetic outcome',
      initiativeId: null,
    }),
    planning: { text: 'Synthetic outcome', kind: 'issue', status: 'open', initiativeId: '', open: true },
  });
  const visitor = await s.read({}, 'visitor');
  assert.equal(visitor.total, 4);
  assert.ok(!JSON.stringify(visitor).includes('owner'));
  s.as(null);
  assert.deepEqual(await s.read({}, 'public-signed-out'), { role: false });
});

test('lanes {state:"all"} pages the same read and accepts the 8-character Item id', async () => {
  const s = await fixture({ extra: 22 });
  const calls = [];
  const transport = {
    // The open-Lane list names its recovery command from the transport's folder (7da396ed).
    root: process.cwd(),
    query: async (name, args) => {
      calls.push(name);
      if (name === 'projectHostedPlanning:resolveId')
        return { ids: args.prefix === s.itemId.slice(0, 8) ? [s.itemId] : [], more: false };
      if (name === 'projectItemWork:read')
        return JSON.parse(await s.call(name, work.read, { projectId: s.auth.projectId, ...args }));
      if (name === 'projectHostedLiveLanes:list') return { page: [], isDone: true, args };
      throw new Error(`unexpected ${name}`);
    },
  };
  const short = s.itemId.slice(0, 8);
  const first = (await liveLanes(transport, { planningItemId: short, state: 'all' })).result;
  assert.deepEqual(calls, ['projectHostedPlanning:resolveId', 'projectItemWork:read']);
  assert.equal(first.total, 26);
  assert.equal(first.page.length, 20);
  assert.equal(first.isDone, false);
  assert.ok(
    first.page.some(lane => lane.state === 'landed'),
    'landed Lanes are listed',
  );
  const rest = (
    await liveLanes(transport, { planningItemId: s.itemId, state: 'all', cursor: first.continueCursor })
  ).result;
  assert.equal(rest.page.length, 6);
  assert.equal(rest.isDone, true);
  // The open-Lane list takes the short id too, resolved before the server sees it.
  calls.length = 0;
  const open = (await liveLanes(transport, { planningItemId: short })).result;
  assert.equal(open.args.planningItemId, s.itemId);
  assert.equal(open.args.state, undefined);
  assert.deepEqual(calls, ['projectHostedPlanning:resolveId', 'projectHostedLiveLanes:list']);
  await assert.rejects(liveLanes(transport, { intentId: s.itemId, state: 'all' }), /state "all"/);
});
