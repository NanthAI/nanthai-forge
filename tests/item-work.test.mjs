// SPDX-License-Identifier: Apache-2.0
// What happened on one Item (Issue 1c2ab97a): the Item's Lanes in every state through the Intent→Lane link, landed
// ones with their receipt (landing note first, overlap stamp for older landings), paged past 20 with a total; the
// people rule per viewer; and the agent's `planning {id}` `work` section and `lanes {state:"all"}` over it.
// Incident: Items d4b68402 and 16093ed1 read open with no linked work although their Lanes had landed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { itemWorkFixture as fixture } from './item-work-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { liveLanes } = await import(moduleUrl('../src/hosted-live-lanes.ts'));
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
  assert.deepEqual(byLane[s.stamped.id].receipt, { receiptId: s.stampReceipt, commit: 'd'.repeat(64), at });
  assert.equal(byLane[s.open.id].actor, 'synthetic-owner', 'writers see the handle, never the account id');
  const count = s.counts.at(-1);
  t.diagnostic(JSON.stringify(count));
  assert.equal(count.writes, 0);
  // Budget: chain head + one Lane range + 4 Lane records (project, head, record, body each) + one notes range + one
  // overlap point read: 30 documents, about 8 KB.
  assert(count.documents <= 32, JSON.stringify(count));
  assert(count.readBytes < 12 * 1024, JSON.stringify(count));
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

test('Item Work preserves earlier landings of a Lane that was kept open and pages their receipts', async () => {
  const s = await fixture({ details: true });
  const receipts = Array.from({ length: 12 }, () => randomUUID());
  for (const [index, receiptId] of receipts.entries()) {
    await s.ctx.db.insert('projectIntentLandingNotes', {
      projectId: s.auth.projectId,
      intentId: s.itemId,
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

test('landing history advances through 10,000 retained notes without offset reads or shifting on a new landing', async t => {
  const s = await fixture({ details: true });
  const [note] = [...s.tables.projectIntentLandingNotes.values()];
  await s.ctx.db.delete(note._id);
  const stamp = [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === s.stamped.id);
  await s.ctx.db.patch(stamp._id, { landed: undefined });
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
      if (name === 'projectItemWork:read') return s.read(args, name);
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
