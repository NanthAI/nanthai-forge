// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// What happened on one Item (Issue 1c2ab97a): the Item's Lanes in every state through the Intent→Lane link, landed
// ones with their receipt (the landing note), paged past 20 with a total; the
// people rule per viewer; and the agent's `planning {id}` `work` section and `lanes {state:"all"}` over it.
// Incident: Items d4b68402 and 16093ed1 read open with no linked work although their Lanes had landed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { itemWorkFixture as fixture } from './item-work-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { liveLanes, liveLanesInput } = await import(moduleUrl('../src/hosted-live-lanes.ts'));
const other = 'b'.repeat(64);
const at = '2026-01-01T00:00:00.000Z';

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
    commit: 'c'.repeat(64),
    at,
    sequence: 42,
    landedBy: 'queue',
  });
  assert.deepEqual(byLane[s.stamped.id].receipt, {
    receiptId: s.stampReceipt,
    commit: 'd'.repeat(64),
    at,
    sequence: 41,
  });
  assert.equal(byLane[s.open.id].actor, 'synthetic-owner', 'writers see the handle, never the account id');
  const count = s.counts.at(-1);
  t.diagnostic(JSON.stringify(count));
  assert.equal(count.writes, 0);
  // Budget: chain head + one Lane range + 4 Lane records (project, head, record, body each) + one notes range + one
  // overlap point read: 30 documents, about 8 KB.
  assert(count.documents <= 32, JSON.stringify(count));
  assert(count.readBytes < 12 * 1024, JSON.stringify(count));
});

test('newest-first pages include older history without rereading it', async () => {
  const s = await fixture({ details: true, extra: 65 });
  const newest = { ...s.abandoned, id: randomUUID() };
  await s.put(newest);
  const first = await s.read({ limit: 7 });
  assert.equal(first.lanes[0].laneId, newest.id, 'a newer abandoned Lane appears before an older open Lane');
  assert.equal(first.atLeast, true);
  assert(first.nextCursor);
  const seen = first.lanes.map(lane => lane.laneId);
  let page = first;
  for (let step = 0; page.nextCursor && step < 15; step++) {
    page = await s.read({ limit: 7, cursor: page.nextCursor });
    seen.push(...page.lanes.map(lane => lane.laneId));
    assert(s.counts.at(-1).documents < 60, 'a page reads its own Lanes, never the history before it');
  }
  assert.equal(page.nextCursor, null);
  assert.equal(page.total, 70);
  assert.equal(new Set(seen).size, 70);
  assert.equal(seen.length, 70);
  assert(seen.includes(s.abandoned.id));
});

test('the released CLI and MCP Lane parser can resume a server-issued indexed Item Work cursor', async () => {
  const s = await fixture({ details: true, extra: 2 });
  const first = await s.read({ limit: 1 });
  assert(first.nextCursor);
  const input = { planningItemId: s.itemId, state: 'all', cursor: first.nextCursor, limit: 1 };
  assert(liveLanesInput.safeParse(input).success, 'released wire envelope accepted by the MCP parser');
  let calls = 0;
  const transport = {
    query: (fn, args) => {
      assert.equal(fn, 'projectItemWork:read');
      calls++;
      return s.read(args);
    },
  };
  const next = await liveLanes(transport, input);
  assert.equal(calls, 1);
  assert.equal(next.result.page.length, 1);
  assert.notEqual(next.result.page[0].laneId, first.lanes[0].laneId);
});

test('Item-page details link recorded saves, acceptance evidence and settled relation titles without writes', async () => {
  const s = await fixture({ details: true });
  const compact = await s.read();
  assert.equal(compact.lanes[0].saveCount, undefined);
  assert.equal(compact.related, undefined);
  const work = await s.read({ details: true });
  const [lane] = work.lanes;
  assert.deepEqual(
    [lane.title, lane.actor, lane.model],
    ['Synthetic outcome', 'synthetic-owner/cobalt-fox', 'gpt-6.2-sol'],
  );
  assert.deepEqual([lane.saveCount, lane.lastSaveAt], [1, at]);
  const noted = work.landings.find(landing => landing.receiptId === s.noteReceipt);
  assert.deepEqual([noted.check, noted.files], ['passed', 2]);
  const stamped = work.landings.find(landing => landing.receiptId === s.stampReceipt);
  assert.deepEqual([stamped.check, stamped.files], [null, null]);
  assert.deepEqual(
    work.related.map(({ kind, title }) => [kind, title]),
    [
      ['Initiative', 'Parser release'],
      ['Depends on', 'Define the wire format'],
      ['Split into', 'Cover retry cases'],
      ['Blocks', 'Cover retry cases'],
      ['Blocks', 'Document compatibility'],
    ],
  );
  const followUp = await s.read({ details: true, itemId: s.followUpId });
  assert.deepEqual(
    followUp.related.map(({ kind, title }) => [kind, title]),
    [
      ['Split from', 'Synthetic outcome'],
      ['Depends on', 'Synthetic outcome'],
    ],
  );
  assert.equal(s.counts.at(-1).writes, 0);
  await s.ctx.db.patch(s.auth.projectId, { visibility: 'public' });
  s.as('visitor');
  const visitor = await s.read({ details: true });
  assert.equal(visitor.related, undefined, 'visitor never receives member-only related titles');
});

async function addReverts(s, count) {
  for (let i = 0; i < count; i++)
    await s.addLandingNote(70 + i, {
      kind: 'reverted',
      revertOf: s.noteReceipt,
    });
}

test('Item Work fills its landing page past reverts and repeated receipts without skipping the next landing', async () => {
  const s = await fixture({ details: true });
  const receipts = Array.from({ length: 12 }, () => randomUUID());
  for (const [index, receiptId] of receipts.entries()) await s.addLandingNote(50 + index, { receiptId });
  await s.addLandingNote(61, { intentId: randomUUID(), receiptId: receipts.at(-1) });
  await addReverts(s, 8);
  const first = await s.read({ details: true, only: 'landings' });
  assert.deepEqual(
    first.landings.map(row => row.receiptId),
    receipts.slice(2).reverse(),
  );
  assert.equal(first.moreLandings, true);

  const second = await s.read({ details: true, only: 'landings', cursor: first.nextCursor });
  assert.deepEqual(
    second.landings.map(row => row.receiptId),
    [...receipts.slice(0, 2).reverse(), s.noteReceipt, s.stampReceipt],
  );
  assert.equal(second.moreLandings, false);
});

test('an empty landing scan retains a cursor through a long run of reverts', async () => {
  const s = await fixture({ details: true });
  await addReverts(s, 22);
  const first = await s.read({ details: true, only: 'landings' });
  assert.deepEqual(first.landings, []);
  assert.equal(first.moreLandings, true);
  assert(first.nextCursor);
  const second = await s.read({ details: true, only: 'landings', cursor: first.nextCursor });
  assert.deepEqual(
    second.landings.map(row => row.receiptId),
    [s.noteReceipt, s.stampReceipt],
  );
  assert.equal(second.moreLandings, false);
});

test('Item Work preserves earlier landings of a Lane that was kept open and pages their receipts', async () => {
  const s = await fixture({ details: true });
  const receipts = Array.from({ length: 12 }, () => randomUUID());
  for (const [index, receiptId] of receipts.entries()) {
    await s.ctx.db.insert('projectIntentLandingNotes', {
      projectId: s.auth.projectId,
      intentId: s.itemId,
      itemId: s.itemId,
      receiptId,
      kind: 'landed',
      at,
      laneIds: [s.open.id],
      commit: other,
      sequence: 43 + index,
      actor: 'owner',
    });
  }
  const first = await s.read({ details: true });
  assert.deepEqual(
    first.landings.map(landing => landing.receiptId),
    receipts.slice(2).reverse(),
  );
  assert.equal(first.lanes[0].receipt.receiptId, receipts.at(-1));
  assert(first.moreLandings);
  assert(first.nextCursor);
  const next = await s.read({ details: true, cursor: first.nextCursor });
  assert.deepEqual(next.lanes, []);
  assert.deepEqual(
    new Set(next.landings.map(landing => landing.receiptId)),
    new Set([receipts[1], receipts[0], s.noteReceipt, s.stampReceipt]),
  );
  assert.equal(next.nextCursor, null);
  assert.equal(next.moreLandings, false);
});

test('the landing history names the revert from the landing note itself, on any page', async () => {
  const s = await fixture({ details: true });
  const original = randomUUID();
  const revert = randomUUID();
  // A landing, ten newer landings, then the landing's revert: the revert note sits above the first page.
  await s.addLandingNote(70, { receiptId: original, revertedBy: revert });
  for (let sequence = 71; sequence < 81; sequence++) await s.addLandingNote(sequence);
  await s.addLandingNote(81, { kind: 'reverted', receiptId: revert, revertOf: original });
  const first = await s.read({ details: true });
  assert(!first.landings.some(landing => landing.receiptId === original), 'the original is on a later page');
  const next = await s.read({ details: true, cursor: first.nextCursor });
  const row = next.landings.find(landing => landing.receiptId === original);
  assert.equal(row.revertedBy, revert, 'the link survives the page boundary');
  assert(
    ![...first.landings, ...next.landings].some(landing => landing.receiptId === revert),
    'a revert is not a landing row',
  );
  assert.equal(
    next.landings.find(landing => landing.receiptId === s.noteReceipt)?.revertedBy,
    undefined,
    'a landing nothing reverted names no revert',
  );
});

test('landings written late sit at their landing time: a page shows the newest landings, not the newest rows', async () => {
  const s = await fixture({ details: true });
  for (const note of [...s.tables.projectIntentLandingNotes.values()]) await s.ctx.db.delete(note._id);
  // Twelve recent landings, then a conversion writes twelve older landings afterwards.
  for (let sequence = 200; sequence < 212; sequence++) await s.addLandingNote(sequence);
  for (let sequence = 1; sequence < 13; sequence++) await s.addLandingNote(sequence);
  const first = await s.read({ details: true });
  assert.deepEqual(
    first.landings.map(landing => landing.sequence),
    Array.from({ length: 10 }, (_, i) => 211 - i),
    'the first page holds the genuinely recent landings',
  );
  const second = await s.read({ details: true, cursor: first.nextCursor });
  assert.deepEqual(
    second.landings.map(landing => landing.sequence),
    [201, 200, ...Array.from({ length: 8 }, (_, i) => 12 - i)],
  );
});

test('the discussion pages landing notes by landing time, so notes written late for old landings never take a recent page', async () => {
  const { intentLandingComments } = await import(moduleUrl('../convex/projectIntentLandingNotes.ts'));
  const s = await fixture({ details: true });
  for (const note of [...s.tables.projectIntentLandingNotes.values()]) await s.ctx.db.delete(note._id);
  // Six recent landings, then a conversion writes six older ones afterwards (larger row creation times).
  for (let sequence = 200; sequence < 206; sequence++) await s.addLandingNote(sequence);
  for (let sequence = 1; sequence < 7; sequence++) await s.addLandingNote(sequence);
  const seen = [];
  let before;
  for (let pageIndex = 0; pageIndex < 6; pageIndex++) {
    const page = await intentLandingComments(s.ctx, s.auth.projectId, s.itemId, 4, [s.itemId], before);
    seen.push(page.comments.map(row => row.value.landing.sequence));
    before = page.before;
    if (!before) break;
  }
  assert.deepEqual(seen, [
    [205, 204, 203, 202],
    [201, 200, 6, 5],
    [4, 3, 2, 1],
  ]);
});

test('846c635b: Item Work and Discussion page one history across more than 24 bound Intents', async () => {
  const s = await fixture({ details: true });
  const { intentLandingComments } = await import(moduleUrl('../convex/projectIntentLandingNotes.ts'));
  for (const note of s.tables.projectIntentLandingNotes.values()) await s.ctx.db.delete(note._id);
  const followed = Array.from({ length: 30 }, () => randomUUID());
  for (const [i, intentId] of followed.entries()) {
    await s.put({
      kind: 'intent',
      id: intentId,
      version: 0,
      at,
      outcome: 'Completed fixture',
      constraints: '',
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base: { head: other, receiptId: randomUUID() },
      status: 'completed',
    });
    await s.addLandingNote(43 + i, { intentId, at });
  }
  const work = [];
  let cursor;
  do {
    const page = await s.read({ details: true, only: 'landings', cursor });
    work.push(...page.landings.map(landing => landing.sequence));
    assert(s.counts.at(-1).documents < 40);
    // Only the landing section advances. The other two sections retain their starting cursors.
    cursor = page.moreLandings ? page.nextCursor : null;
  } while (cursor);
  const discussion = [];
  let before;
  do {
    const page = await intentLandingComments(s.ctx, s.auth.projectId, s.itemId, 4, [s.itemId], before);
    discussion.push(...page.comments.map(comment => comment.value.landing.intentId));
    before = page.before;
  } while (before);
  assert.deepEqual(
    work,
    Array.from({ length: 30 }, (_, i) => 72 - i),
  );
  assert.deepEqual(discussion, followed.toReversed());
  await assert.rejects(
    s.read({
      details: true,
      cursor: 'forge-item-work-v2:' + JSON.stringify({ lane: null, history: { notes: [false] } }),
    }),
    /expected the nextCursor/,
  );
});

test('Item Work keeps Lane attribution and receipt history after a landing note moves to its capsule', async () => {
  const s = await fixture({ details: true });
  const { retainLandingNoteReference } = await import(
    moduleUrl('../convex/projectIntentLandingNoteArchive.ts')
  );
  const [note] = [...s.tables.projectIntentLandingNotes.values()];
  const receipt = [...s.tables.projectHostedAcceptances.values()].find(
    row => row.receiptId === note.receiptId,
  );
  const before = await s.read({ details: true });
  await retainLandingNoteReference(s.ctx, receipt.submissionId, note);
  const after = await s.read({ details: true });
  assert.deepEqual(after.landings, before.landings);
  assert.deepEqual(after.lanes, before.lanes);
});

test('landing history advances through 10,000 retained notes without offset reads or shifting on a new landing', async t => {
  const s = await fixture({ details: true });
  for (const note of [...s.tables.projectIntentLandingNotes.values()]) await s.ctx.db.delete(note._id);
  const measure = async (surface, history, read) => {
    const start = performance.now();
    const raw = await read();
    t.diagnostic(
      JSON.stringify({
        surface,
        history,
        replyBytes: Buffer.byteLength(raw),
        processPeakKiB: process.resourceUsage().maxRSS,
        handlerMs: +(performance.now() - start).toFixed(1),
        ...s.counts.at(-1),
      }),
    );
    return JSON.parse(raw);
  };
  assert.deepEqual((await measure('Item', 0, () => s.readRaw({ details: true }))).landings, []);
  for (let sequence = 43; sequence < 10_043; sequence++) await s.addLandingNote(sequence);
  let page = await measure('Item', 10_000, () => s.readRaw({ details: true }));
  assert.equal(s.counts.at(-1).writes, 0);
  assert.deepEqual(
    page.landings.map(x => x.sequence),
    Array.from({ length: 10 }, (_, i) => 10_042 - i),
  );
  await s.addLandingNote(10_043);
  for (let n = 1; n <= 6; n++) {
    page = await s.read({ details: true, cursor: page.nextCursor });
    assert.deepEqual(page.lanes, []);
    assert.deepEqual(
      page.landings.map(x => x.sequence),
      Array.from({ length: 10 }, (_, i) => 10_042 - n * 10 - i),
    );
    const cost = s.counts.at(-1);
    assert.equal(cost.writes, 0);
    assert(cost.documents < 45, JSON.stringify(cost));
    assert(cost.readBytes < 20 * 1024, JSON.stringify(cost));
  }
});

test('settled reverse links continue beyond the first planning page and keep shelved titles private', async () => {
  const s = await fixture({ details: true });
  const split = randomUUID();
  await s.planning(split, {
    title: 'A dropped split',
    status: 'abandoned',
    relations: [{ kind: 'related', id: s.itemId }],
    body: `Split from ${s.itemId.slice(0, 8)}.\n`,
  });
  await s.planning(randomUUID(), {
    title: 'Owner-only blocker',
    status: 'archived',
    relations: [{ kind: 'depends-on', id: s.itemId }],
  });
  const duplicate = randomUUID(),
    related = randomUUID();
  await s.planning(duplicate, {
    title: 'Dropped duplicate',
    status: 'abandoned',
    relations: [{ kind: 'duplicate-of', id: s.itemId }],
  });
  await s.planning(related, {
    title: 'Settled related work',
    status: 'closed',
    relations: [{ kind: 'related', id: s.itemId }],
  });
  for (let i = 0; i < 50; i++) await s.planning(randomUUID(), { title: `Unrelated Item ${i}` });
  await s.ctx.db.insert('projectReaders', { projectId: s.auth.projectId, reader: 'reader' });
  s.as('reader');
  const first = await s.read({ details: true });
  assert(!first.related.some(x => x.id === split));
  const next = await s.read({ details: true, cursor: first.nextCursor });
  assert(next.related.some(x => x.kind === 'Split into' && x.id === split));
  assert(next.related.some(x => x.kind === 'Blocks' && x.id === s.settledBlockerId));
  assert(next.related.some(x => x.kind === 'Duplicated by' && x.id === duplicate));
  assert(next.related.some(x => x.kind === 'Related' && x.id === related));
  assert(!next.related.some(x => x.title === 'Owner-only blocker'));
  assert.equal(next.nextCursor, null);
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
  assert.equal(first.total, 21);
  assert.equal(first.atLeast, true);
  assert.equal(first.lanes.length, 20);
  assert.ok(first.nextCursor);
  const second = await s.read({ cursor: first.nextCursor }, 'second');
  assert.equal(second.lanes.length, 6);
  assert.equal(second.total, 26);
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
      if (name === 'projectItemWork:read') return s.read(args, name);
      if (name === 'projectHostedLiveLanes:list') return { page: [], isDone: true, args };
      throw new Error(`unexpected ${name}`);
    },
  };
  const short = s.itemId.slice(0, 8);
  const first = (await liveLanes(transport, { planningItemId: short, state: 'all' })).result;
  assert.deepEqual(calls, ['projectHostedPlanning:resolveId', 'projectItemWork:read']);
  assert.equal(first.total, 21);
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
  // An empty open list reads the Issue's Lanes once more, to name a preserved Lane with unlanded work (986422c9).
  assert.deepEqual(calls, [
    'projectHostedPlanning:resolveId',
    'projectHostedLiveLanes:list',
    'projectItemWork:read',
  ]);
  await assert.rejects(liveLanes(transport, { intentId: s.itemId, state: 'all' }), /state "all"/);
});

test('the Initiative roll-up includes a settled Item, counts a shared receipt once and uses its member files', async () => {
  const s = await fixture({ details: true });
  const root = { sha256: other, size: 0 };
  const nextIntent = s.settledBlockerId;
  await s.put({
    kind: 'intent',
    id: nextIntent,
    version: 0,
    at,
    outcome: 'Settled parser work',
    constraints: '',
    creatorAccountId: 'owner',
    assigneeAccountIds: [],
    base: { head: other, receiptId: randomUUID() },
    status: 'active',
  });
  const member = { id: randomUUID(), head: 'e'.repeat(64) };
  await s.put({
    kind: 'candidate',
    intentId: nextIntent,
    id: member.id,
    version: 0,
    at,
    algorithm: 'fixture',
    base: { head: other, receiptId: randomUUID() },
    inputs: root,
    dependencies: root,
    result: { status: 'clean', head: member.head },
    governance: { version: 1, paths: ['src/parser.ts', 'docs/format.md'], ownerInputs: true },
  });
  await s.addLandingNote(42, { intentId: nextIntent, receiptId: s.noteReceipt, commit: 'c'.repeat(64) });
  const receiptId = randomUUID();
  await s.addLandingNote(43, { intentId: nextIntent, receiptId });
  await s.ctx.db.insert('projectHostedAcceptances', {
    projectId: s.auth.projectId,
    receiptId,
    submissionId: randomUUID(),
    attemptId: randomUUID(),
    sequence: 43,
    value: JSON.stringify({
      candidate: { id: randomUUID(), head: other },
      memberCandidate: member,
      check: null,
    }),
  });
  await s.rebuildInitiative();
  const page = JSON.parse(await s.readInitiativeRaw());
  assert.deepEqual(page, {
    role: true,
    openLanes: 1,
    openAtLeast: false,
    landings: 3,
    files: 3,
    missingFiles: 1,
  });
  assert.deepEqual(
    [...s.tables.projectInitiativeWorkMembers.values()]
      .filter(row => row.kind === 'receipt')
      .map(row => row.key)
      .sort(),
    [s.noteReceipt, s.stampReceipt, receiptId].sort(),
  );
  assert.deepEqual(
    [...s.tables.projectInitiativeWorkMembers.values()]
      .filter(row => row.kind === 'path')
      .map(row => row.key)
      .sort(),
    ['docs/format.md', 'src/parser.ts', 'tests/parser.test.mjs'],
  );
  assert.equal(s.counts.at(-1).writes, 0);
  await s.ctx.db.patch(s.auth.projectId, { visibility: 'public' });
  s.as('visitor');
  assert.deepEqual(JSON.parse(await s.readInitiativeRaw()), { role: false });
  s.as(null);
  assert.deepEqual(JSON.parse(await s.readInitiativeRaw()), { role: false });
});

test('large planning roots leave later reverse relations and Initiative work reachable', async () => {
  const s = await fixture({ details: true });
  const giant = 'legacy text '.repeat(16_000);
  const reverse = randomUUID();
  await s.planning(
    reverse,
    {
      title: 'Large blocker',
      initiativeId: s.initiativeId,
      relations: [{ kind: 'depends-on', id: s.itemId }],
      status: 'closed',
    },
    giant,
  );
  await s.planning(randomUUID(), { title: 'More recent large Item', initiativeId: s.initiativeId }, giant);
  const first = await s.read({ details: true });
  assert(!first.related.some(x => x.id === reverse));
  const second = await s.read({ details: true, cursor: first.nextCursor });
  assert(second.related.some(x => x.kind === 'Blocks' && x.id === reverse));
  await s.rebuildInitiative();
  const rollup = JSON.parse(await s.readInitiativeRaw());
  assert.equal(rollup.landings, 2);
  assert.equal(rollup.files, 2);
  assert.equal(rollup.missingFiles, 1);
  assert(s.counts.at(-1).readBytes < 10_000, 'the Work view does not read the large settled roots');
});

test('a reader loses access to detailed landing history when the selected Item is shelved', async () => {
  const s = await fixture({ details: true });
  for (let sequence = 43; sequence < 54; sequence++) await s.addLandingNote(sequence);
  await s.ctx.db.insert('projectReaders', { projectId: s.auth.projectId, reader: 'reader' });
  s.as('reader');
  const first = await s.read({ details: true });
  assert.equal(first.landings.length, 10);
  assert(first.nextCursor);
  for (const row of s.tables.projectPlanningRecords.values())
    if (row.key === s.itemId)
      await s.ctx.db.patch(row._id, {
        value: JSON.stringify({ ...JSON.parse(row.value), status: 'archived' }),
      });
  assert.equal((await s.read({ details: true, cursor: first.nextCursor })).landings, undefined);
  assert.equal((await s.read({ details: true })).landings, undefined);
  assert.equal((await s.read()).lanes.length, 4, 'the existing compact Lane read is preserved');
  s.as('owner');
  assert.equal((await s.read({ details: true })).landings.length, 10);
});

test('411727ba cursor: Lanes expand reads no landing or Related document and equals from-start limit 10', async () => {
  const s = await fixture({ details: true, extra: 8 });
  const receipts = [];
  for (let i = 0; i < 12; i++) {
    const receiptId = randomUUID();
    const candidateId = randomUUID();
    const commit = `${(i + 1).toString(16).padStart(2, '0')}`.repeat(32);
    const root = { sha256: 'a'.repeat(64), size: 0 };
    await s.put({
      kind: 'candidate',
      id: candidateId,
      intentId: s.itemId,
      version: 0,
      at,
      base: { head: 'a'.repeat(64), receiptId: randomUUID() },
      inputs: root,
      dependencies: root,
      algorithm: 'fixture',
      result: { status: 'clean', head: commit },
      governance: { version: 1, paths: [`src/f${i}.ts`, `tests/f${i}.test.mjs`], ownerInputs: true },
    });
    await s.addLandingNote(50 + i, { receiptId, commit });
    await s.ctx.db.insert('projectHostedAcceptances', {
      projectId: s.auth.projectId,
      receiptId,
      submissionId: randomUUID(),
      attemptId: randomUUID(),
      sequence: 50 + i,
      value: JSON.stringify({
        at,
        snapshot: { revision: 50 + i },
        candidate: { id: candidateId, head: commit },
        check: { runId: randomUUID() },
      }),
    });
    receipts.push(receiptId);
  }
  for (let i = 0; i < 60; i++) await s.planning(randomUUID(), { title: `Board item ${i}` });

  const fromStart = await s.read({ details: true, limit: 10 }, 'from-start');
  const open = await s.read({ details: true, limit: 3 }, 'open');
  assert.equal(open.lanes.length, 3);
  assert.equal(open.landings.length, 10, 'count label stays 10 on open');
  assert.equal(open.moreLandings, true);
  assert.equal(open.moreRelated, true);
  // Only the 3 visible landings are hydrated on open; the 7 hidden rows keep their receipt lines.
  for (const row of open.landings.slice(0, 3)) {
    assert.equal(row.check, 'passed');
    assert.equal(row.files, 2);
    assert.equal(row.detailsPending, undefined);
  }
  for (const row of open.landings.slice(3)) {
    assert.equal(row.check, null);
    assert.equal(row.files, null);
    assert.equal(row.detailsPending, true);
  }

  // Track tables read during `only: 'lanes'`.
  const tablesTouched = new Set();
  const origQuery = s.ctx.db.query.bind(s.ctx.db);
  s.ctx.db.query = table => {
    tablesTouched.add(table);
    return origQuery(table);
  };
  let expandLanes;
  try {
    expandLanes = await s.read(
      { details: true, cursor: open.nextCursor, limit: 7, only: 'lanes' },
      'expand-lanes',
    );
  } finally {
    s.ctx.db.query = origQuery;
  }
  assert.equal(expandLanes.lanes.length, 7);
  assert.equal(expandLanes.landings, undefined);
  assert.equal(expandLanes.related, undefined);
  assert.equal(tablesTouched.has('projectHostedAcceptances'), false, 'no landing receipt reads');
  assert.equal(tablesTouched.has('projectPlanningRecords'), false, 'no Related or planningSearch reads');
  assert.equal(tablesTouched.has('projectWorkDataRecords'), false, 'no Related data reads');
  const mergedLanes = [...open.lanes, ...expandLanes.lanes];
  assert.deepEqual(mergedLanes, fromStart.lanes, '3 + 7 Lanes equals from-start limit 10');
  // Other two cursor positions pass through unchanged.
  const openCursor = JSON.parse(open.nextCursor.slice('forge-item-work-v2:'.length));
  const expandCursor = JSON.parse(expandLanes.nextCursor.slice('forge-item-work-v2:'.length));
  assert.equal(expandCursor.lane.seen, 10);
  assert.deepEqual(expandCursor.history, openCursor.history);
  assert.deepEqual(expandCursor.related, openCursor.related);

  // Landings expand via `only: 'landings'` hydrates all 10 landings without reading Lanes or Related.
  const landingTables = new Set();
  s.ctx.db.query = table => {
    landingTables.add(table);
    return origQuery(table);
  };
  let expandLandings;
  try {
    expandLandings = await s.read(
      { details: true, cursor: null, limit: 10, only: 'landings' },
      'expand-landings',
    );
  } finally {
    s.ctx.db.query = origQuery;
  }
  assert.deepEqual(expandLandings.lanes, []);
  assert.equal(expandLandings.related, undefined);
  assert.equal(expandLandings.total, undefined);
  assert.deepEqual(expandLandings.landings, fromStart.landings, 'hydrated landings equal from-start');
  assert.equal(landingTables.has('projectHostedOverlapLanes'), false);

  // Related-only preserves lane and history cursors.
  const onlyRelated = await s.read(
    { details: true, cursor: expandLanes.nextCursor, limit: 10, only: 'related' },
    'only-related',
  );
  assert.deepEqual(onlyRelated.lanes, []);
  assert.equal(onlyRelated.landings, undefined);
  assert.ok(Array.isArray(onlyRelated.related));
  const afterRelated = JSON.parse(onlyRelated.nextCursor.slice('forge-item-work-v2:'.length));
  assert.equal(afterRelated.lane.seen, 10);
  assert.deepEqual(afterRelated.history, openCursor.history);
  assert.notEqual(afterRelated.related, openCursor.related);
});

test('a Lane older than the newest landing notes still reads its receipt, with its revert', async () => {
  const s = await fixture({ details: true });
  // Sixty newer landings push the noted Lane's note out of the Intent's newest-fifty window.
  for (let sequence = 100; sequence < 160; sequence++) await s.addLandingNote(sequence);
  const revert = randomUUID();
  const overlap = [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === s.noted.id);
  await s.ctx.db.patch(overlap._id, {
    landed: { receiptId: s.noteReceipt, commit: 'c'.repeat(64), laneHead: other, at },
  });
  const note = [...s.tables.projectIntentLandingNotes.values()].find(row => row.receiptId === s.noteReceipt);
  await s.ctx.db.patch(note._id, { revertedBy: revert });
  const work = await s.read({ limit: 20 });
  const lane = work.lanes.find(row => row.laneId === s.noted.id);
  assert.deepEqual(
    [lane.receipt.receiptId, lane.receipt.commit, lane.receipt.revertedBy],
    [s.noteReceipt, 'c'.repeat(64), revert],
  );
});

test('an Item is its bound Intents and Lanes: a head with no Item binding is not read as the Item’s', async () => {
  const s = await fixture({ details: true });
  for (const key of [s.itemId, s.open.id, s.noted.id, s.stamped.id, s.abandoned.id]) {
    const head = [...s.tables.projectHostedRecordHeads.values()].find(row => row.key === key);
    await s.ctx.db.patch(head._id, { planningItemId: undefined });
  }
  const work = await s.read();
  assert.deepEqual(work.lanes, [], 'an unbound Lane is not listed');
  assert.equal(work.intent, null, 'an unbound same-id Intent is not the Item’s state');
});
