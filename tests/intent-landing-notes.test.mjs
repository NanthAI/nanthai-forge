// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Issue 3a733ee8: every landing posts its receipt to its Item as a system comment, including landings the
// queue makes after the agent stopped (incident 2bf85ddf, 2026-11-17).
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { revertFixture } from './hosted-revert-fixture.mjs';
import { setup as planningSetup } from './hosted-planning-fixture.mjs';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import {
  landingNoteComment,
  landingNoteId,
  landingNoteText,
  SYSTEM_COMMENT_AUTHOR,
} from '../dist/intent-landing-note.js';
import { successorIntentId } from '../dist/hosted-intent-chain.js';
const notes = await import(moduleUrl('../convex/projectIntentLandingNotes.ts'));
const completion = await import(moduleUrl('../convex/projectHostedAcceptanceCompletion.ts'));
const revertNotice = await import(moduleUrl('../convex/projectHostedRevertNotice.ts'));
const workIndex = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const itemWork = await import(moduleUrl('../convex/projectItemWork.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const stateOf = (f, id) => states(f).find(s => s.id === id);
const requestRow = (f, id) =>
  [...f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === id);
const runOwner = (f, run) =>
  [...f.tables.projectHostedLandingAttempts.values()].find(
    row => JSON.parse(row.value).check?.runId === run.id,
  )?.submissionId;
const notesOf = (f, intentId) =>
  [...f.tables.projectIntentLandingNotes.values()].filter(row => row.intentId === intentId);

/** What the planning path writes for an Intent that belongs to an Item: its marker. Fixture Intents are written
 * without one; only a marked Intent posts a landing note (Item fc1831eb removed the legacy no-marker fallback). */
const markLinked = (f, keys) => {
  const marked = new Set();
  for (const head of f.tables.projectHostedRecordHeads.values())
    if (head.kind === 'intent' && head.planningItemId === undefined && (!keys || keys.includes(head.key))) {
      f.patch('projectHostedRecordHeads', head._id, { planningItemId: head.key });
      marked.add(head.key);
    }
  // Lane heads carry their Item too: the Item read lists Lanes only through that binding.
  for (const head of f.tables.projectHostedRecordHeads.values())
    if (head.kind === 'lane' && head.planningItemId === undefined && marked.has(head.parent))
      f.patch('projectHostedRecordHeads', head._id, { planningItemId: head.parent });
};

/** Incident 2bf85ddf (2026-11-17): the builder submitted, its landing parked behind an older entry, the
 * builder stopped ("needs sync"), the older entry landed and the queue landed the parked Lane at 21:46
 * (receipt 1bc84170) with no agent attached. Nothing reached its Item, so the lead briefed a takeover and a
 * review for work already on main. Replay: two Lanes on two Items; the newer passes first and parks behind
 * the older; only scheduled queue steps run after submission (no agent call). */
async function parkedQueueLanding(t, failFold = false, markedItems = (older, parked) => [older, parked]) {
  const f = await batchesFixture(t, {
    count: 2,
    batching: false,
    requestCheck: true,
    memberContracts: [[], []],
  });
  const [older, parked] = f.entries.map(entry => entry.state.id);
  const [olderItem, parkedItem] = f.entries.map(entry => entry.selection.request.intentId);
  assert.notEqual(olderItem, parkedItem, 'two Lanes on two Items');
  // With a failing fold only the parked Lane's Item is marked: the older Lane's receipt stays independent.
  markLinked(f, failFold ? [parkedItem] : markedItems(olderItem, parkedItem));
  let wasParked = false;
  for (let tick = 0; ; tick++) {
    assert(tick < 800, JSON.stringify(states(f).map(s => [s.sequence, s.phase])));
    for (const run of f.runs().filter(run => run.status === 'queued')) {
      const owner = runOwner(f, run);
      if (owner !== older) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
      else if (requestRow(f, parked)?.orderWait === older) {
        wasParked = true;
        await f.rawChecks.pass(await f.rawChecks.activate(run.id));
      }
    }
    const task = f.pending()[0];
    if (!task) break;
    if (failFold && task.name === 'projectInitiativeWorkFold:fold') {
      const plan = [...f.tables.projectHostedAcceptancePlans.values()].find(
        row => row.receiptId === task.args[0].receiptId,
      );
      assert.equal(
        plan.appliedPage,
        plan.inputPages,
        'acceptance completion already processed its final page',
      );
      assert.equal(plan.completion, undefined);
      assert.deepEqual(task.args[0].itemIds, [parkedItem]);
      await assert.rejects(f.execute(task, 'initiative-fold-failed'), /synthetic Initiative fold failure/);
    } else await f.execute(task);
  }
  assert(wasParked, 'the newer Lane parked behind the older one');
  assert.equal(stateOf(f, older).phase, 'landed');
  assert.equal(stateOf(f, parked).phase, 'landed', 'the queue landed the parked Lane');
  return { f, older, parked, olderItem, parkedItem };
}

test('an Initiative fold failure leaves the accepted landing and its completion settled', async t => {
  const { f, parked, older } = await parkedQueueLanding(t, true);
  const folds = [...f.tables._scheduled_functions.values()].filter(
    task => task.name === 'projectInitiativeWorkFold:fold',
  );
  assert.equal(
    folds.length,
    1,
    'one scheduled fold for the Item-linked receipt and none for the independent receipt',
  );
  assert.equal(folds[0].state.kind, 'failed');
  assert.equal(folds[0].args[0].receiptId, stateOf(f, parked).acceptance.receiptId);
  assert.equal(stateOf(f, older).phase, 'landed');
  assert.equal(stateOf(f, parked).phase, 'landed');
});

test('incident replay 2bf85ddf: a parked Lane the queue lands after its agent stopped posts its receipt to its Item', async t => {
  const { f, parked, parkedItem, olderItem } = await parkedQueueLanding(t);
  const receiptId = stateOf(f, parked).acceptance.receiptId;
  const receipt = JSON.parse(
    [...f.tables.projectHostedAcceptances.values()].find(row => row.receiptId === receiptId).value,
  );
  const laneId = f.entries[1].lane.laneId;
  // What the Item read shows (projectWorkIndex:records merges exactly these rows into the Item's comments).
  const { comments: shown } = await f.c.run(
    'itemComments',
    (ctx, input) => notes.intentLandingComments(ctx, ...input),
    [f.projectId, parkedItem],
  );
  assert.equal(shown.length, 1, 'one system comment on the parked Lane’s Item');
  const comment = shown[0].value;
  assert.equal(comment.system, true);
  assert.equal(comment.authorLabel, SYSTEM_COMMENT_AUTHOR);
  assert.equal(comment.itemId, parkedItem);
  assert.equal(comment.provenance, 'forge-receipt');
  assert.deepEqual(
    {
      receiptId: comment.landing.receiptId,
      laneIds: comment.landing.laneIds,
      commit: comment.landing.commit,
      sequence: comment.landing.sequence,
      landedBy: comment.landing.landedBy,
      accepted: comment.landing.accepted,
    },
    {
      receiptId,
      laneIds: [laneId],
      commit: receipt.candidate.head,
      sequence: receipt.snapshot.revision,
      landedBy: 'queue',
      accepted: 'policy',
    },
  );
  assert.match(comment.text, /^Landed by the queue/);
  assert.match(comment.text, /Project policy accepted it after its check passed\.$/);
  assert(comment.text.includes(`receipt ${receiptId.slice(0, 8)}`));
  assert(comment.text.includes(`Lane ${laneId.slice(0, 8)}`));
  assert(!comment.text.includes(receipt.actor.id), 'the text names no account');
  // The same queue acceptance produces the completed Intent, landed Lane and Work evidence.
  // This fixture seeds the link, not a planning Item version; reconcile itself is tested separately.
  const work = JSON.parse(
    await f.c.run('itemWork', (ctx, input) => itemWork.read._handler(ctx, input), {
      projectId: f.projectId,
      itemId: parkedItem,
    }),
  );
  assert.equal(work.intent, 'completed');
  const lane = work.lanes.find(row => row.laneId === laneId);
  assert.deepEqual(
    [lane?.intentId, lane?.state, lane?.receipt?.receiptId, lane?.receipt?.commit],
    [parkedItem, 'landed', receiptId, receipt.candidate.head],
  );
  // The predecessor's Item gets its own note; each Item exactly one.
  assert.equal(notesOf(f, olderItem).length, 1);
  assert.equal(notesOf(f, parkedItem).length, 1);
});

test('fails without: only an Intent marked with its Item posts a landing note; an unmarked legacy Intent posts none', async t => {
  const { f, parked, older, olderItem, parkedItem } = await parkedQueueLanding(t, false, (_older, p) => [p]);
  assert.equal(stateOf(f, older).phase, 'landed');
  assert.equal(stateOf(f, parked).phase, 'landed');
  assert.equal(
    notesOf(f, parkedItem).length,
    1,
    'the marked Intent still notes its Item through the normal path',
  );
  assert.equal(notesOf(f, olderItem).length, 0, 'the unmarked Intent has no Item to note');
});

test('landing notes are idempotent per receipt: a replayed completion tick or a repeated post writes nothing', async t => {
  const { f, parked, parkedItem } = await parkedQueueLanding(t);
  const receiptId = stateOf(f, parked).acceptance.receiptId;
  const before = f.tables.projectIntentLandingNotes.size;
  // A guard replay of the finished tick: the plan is complete, nothing is posted again.
  await f.c.run('replayTick', completion.completeAcceptedHeads, { projectId: f.projectId, receiptId });
  // A resumed tick that re-runs its page from the start (position rewound): the probe finds the note.
  const plan = [...f.tables.projectHostedAcceptancePlans.values()].find(row => row.receiptId === receiptId);
  f.patch('projectHostedAcceptancePlans', plan._id, { appliedPage: 0, appliedEntry: 0 });
  await f.c.run('resumedTick', completion.completeAcceptedHeads, { projectId: f.projectId, receiptId });
  const row = notesOf(f, parkedItem)[0];
  const again = await f.c.run('repost', (ctx, input) => notes.postIntentLandingNote(ctx, ...input), [
    f.projectId,
    { ...row, laneIds: row.laneIds },
  ]);
  assert.equal(again, false);
  assert.equal(f.tables.projectIntentLandingNotes.size, before, 'one note per Intent and receipt');
});

test('an Item reopened onto a successor Intent shows the notes of every Intent in its chain, newest first', async t => {
  const { f, parkedItem } = await parkedQueueLanding(t);
  // The Item continued on its next Intent (e4a71127); a landing there notes the successor Intent.
  const successor = successorIntentId(parkedItem);
  const template = notesOf(f, parkedItem)[0];
  const head = [...f.tables.projectHostedRecordHeads.values()].find(
    row => row.kind === 'intent' && row.key === parkedItem,
  );
  assert.equal(head.status, 'completed', 'the landing completed the Item’s first Intent');
  const { _id, _creationTime, ...copy } = head;
  f.insert('projectHostedRecordHeads', { ...copy, key: successor, status: 'active' });
  f.advanceClock(1000);
  await f.c.run('successorNote', (ctx, input) => notes.postIntentLandingNote(ctx, ...input), [
    f.projectId,
    {
      ...template,
      intentId: successor,
      receiptId: 'later-receipt',
      at: new Date(Date.parse(template.at) + 1000).toISOString(),
    },
  ]);
  const { comments: shown } = await f.c.run(
    'itemComments',
    (ctx, input) => notes.intentLandingComments(ctx, ...input),
    [f.projectId, parkedItem],
  );
  assert.deepEqual(
    shown.map(row => row.value.landing.receiptId),
    ['later-receipt', template.receiptId],
  );
  assert(
    shown.every(row => row.value.itemId === parkedItem),
    'every note reads as the Item’s comment',
  );
});

/** The Item's retained records-store tombstone and the receipt window after twenty further purges. */
async function evictedPurge(f, itemId) {
  const intent = [...f.tables.projectHostedRecordHeads.values()].find(
    row => row.kind === 'intent' && row.key === itemId,
  );
  await f.c.run(
    'evictedPurge',
    async ctx => {
      await ctx.db.insert('projectHostedRecordHeads', {
        projectId: f.projectId,
        kind: 'issue',
        key: itemId,
        parent: '',
        status: 'deleted',
        version: 2,
        recordId: intent.recordId,
        value: JSON.stringify({ id: itemId, title: 'Deleted Item', status: 'deleted', purged: true }),
      });
    },
    {},
  );
  f.patch('hostedProjects', f.projectId, {
    workStore: 'records',
    itemPurges: Array.from({ length: 20 }, (_, i) => ({
      operationId: randomUUID(),
      itemId: randomUUID(),
      ids: [],
      version: 2,
      decisions: [],
      rows: 0,
      startedAt: Date.parse('2025-11-30T00:00:00.000Z') + i,
      purgedAt: Date.parse('2025-12-01T00:00:00.000Z') + i,
    })),
  });
}

test('a pre-existing Lane can land after its Item purge receipt was evicted without recreating a hot note', async t => {
  const f = await revertFixture(t);
  const itemId = f.c.intentId;
  markLinked(f);
  await evictedPurge(f, itemId);
  const intent = [...f.tables.projectHostedRecordHeads.values()].find(row => row.key === itemId);
  const version = f.tables.projectHostedRecords.get(intent.recordId);
  const body = f.tables.projectHostedRecordBodies.get(version.bodyId);
  await f.c.run('redactedIntentHead', records.writeHostedRecord, {
    projectId: f.projectId,
    actor: 'owner',
    authorityEpoch: 1,
    expectedVersion: intent.version,
    record: {
      ...JSON.parse(body.value),
      version: intent.version + 1,
      outcome: 'Deleted Item',
      constraints: '',
    },
  });

  const receipt = await f.landOriginal();
  assert(Date.parse(receipt.at) > f.tables.hostedProjects.get(f.projectId).itemPurges[19].purgedAt);
  assert(f.receipt(receipt.id), 'canonical acceptance is still available');
  assert.deepEqual(notesOf(f, itemId), []);
});

test('a revert after purge-receipt eviction follows the Item tombstone even if the Intent title changed', async t => {
  const f = await revertFixture(t);
  markLinked(f);
  const original = await f.landOriginal();
  const note = [...f.tables.projectIntentLandingNotes.values()].find(row => row.receiptId === original.id);
  assert(note);
  await evictedPurge(f, note.itemId);
  await f.c.run('removePurgedNote', ctx => ctx.db.delete(note._id), {});

  const reverse = await f.reverse(f.revertRequest({ kind: 'receipt', receiptId: original.id }));
  const selection = f.selectRevert([reverse.entry], reverse.lane.intentId);
  const state = await f.finishRevert(await f.composeRevert(selection), selection);
  let final = await f.settleRevert(state.id);
  for (let i = 0; final.phase !== 'landed' && i < 5; i++) final = await f.settleRevert(state.id);
  assert.equal(final.phase, 'landed');
  await f.c.run('delayedRevertNotice', revertNotice.noticeRevert, {
    projectId: f.projectId,
    receiptId: final.acceptance.receiptId,
    revertOf: original.id,
    actor: 'owner',
  });
  assert.deepEqual(notesOf(f, note.intentId), []);
  assert(f.receipt(original.id));
  assert(f.receipt(final.acceptance.receiptId));
});

test('the first revert of a recovered landing records its Item even with an unmarked Intent', async t => {
  const f = await revertFixture(t);
  markLinked(f);
  const receipt = await f.landOriginal();
  const r = f.revertRequest({ kind: 'receipt', receiptId: receipt.id }),
    reverse = await f.reverse(r);
  const selection = f.selectRevert([reverse.entry], reverse.lane.intentId),
    candidate = await f.composeRevert(selection);
  const state = await f.finishRevert(candidate, selection);
  let final = await f.settleRevert(state.id);
  for (let i = 0; final.phase !== 'landed' && i < 5; i++) final = await f.settleRevert(state.id);
  assert.equal(final.phase, 'landed');
  // The original landing noted its Item. The independent compensation has no Item note.
  const landedNotes = [...f.tables.projectIntentLandingNotes.values()].filter(row => row.kind === 'landed');
  assert.equal(
    landedNotes.some(row => row.receiptId === final.acceptance.receiptId),
    false,
  );
  const originalNote = landedNotes.find(row => row.receiptId === receipt.id);
  assert(originalNote, 'the original landing noted its Item');
  assert.equal(originalNote.itemId, originalNote.intentId, 'completion records the Item binding');
  const intentHead = [...f.tables.projectHostedRecordHeads.values()].find(
    row => row.kind === 'intent' && row.key === originalNote.intentId,
  );
  f.patch('projectHostedRecordHeads', intentHead._id, { planningItemId: undefined });
  assert(![...f.tables.projectIntentLandingNotes.values()].some(row => row.kind === 'reverted'));
  // The compensating landing's scheduled notice (state.request.revertOf in production), run twice.
  const input = {
    projectId: f.projectId,
    receiptId: final.acceptance.receiptId,
    revertOf: receipt.id,
    actor: 'owner',
  };
  for (const name of ['revertNotice', 'revertNoticeReplay'])
    await f.c.run(name, revertNotice.noticeRevert, input);
  const reverted = [...f.tables.projectIntentLandingNotes.values()].filter(row => row.kind === 'reverted');
  assert.equal(reverted.length, 1, 'one reverted note; a replayed notice posts nothing new');
  assert.equal(reverted[0].intentId, originalNote.intentId, 'on the reverted landing’s Item');
  assert.equal(reverted[0].itemId, originalNote.itemId, 'the revert retains the original Item binding');
  assert.equal(reverted[0].revertOf, receipt.id);
  assert.equal(reverted[0].receiptId, final.acceptance.receiptId);
  assert.deepEqual(reverted[0].laneIds, originalNote.laneIds);
  assert.equal(
    [...f.tables.projectIntentLandingNotes.values()].find(row => row._id === originalNote._id).revertedBy,
    final.acceptance.receiptId,
    'the original landing note names its revert, so no page has to find the revert note',
  );
  // J08: the project's notice also names the Lane and who took it out, so the web can word its card; the summary and
  // undo the agents read are the same text as before.
  const entry = Object.values(f.tables.hostedProjects.get(f.projectId).needsFix ?? {}).map(JSON.parse)[0];
  assert.equal(entry?.by, 'owner');
  assert.equal(entry?.lane, originalNote.laneIds[0]);
  assert.match(entry?.summary ?? '', /^Reverted receipt /);
  const text = landingNoteText(reverted[0]);
  assert.match(text, /^Reverted: receipt /);
  assert(text.includes(receipt.id.slice(0, 8)));
  assert(text.includes(final.acceptance.receiptId.slice(0, 8)));

  // A markerless legacy Intent still gets its existing receipt link repaired on notice replay.
  f.patch('projectHostedRecordHeads', intentHead._id, { planningItemId: undefined });
  f.patch('projectIntentLandingNotes', originalNote._id, { revertedBy: undefined });
  await f.c.run('legacyRevertNoticeReplay', revertNotice.noticeRevert, input);
  assert.equal(
    f.tables.projectIntentLandingNotes.get(originalNote._id).revertedBy,
    final.acceptance.receiptId,
  );
});

test('a landing note reads as a system comment with a stable UUID id and no person in its text', () => {
  const note = {
    intentId: '11111111-1111-4111-8111-111111111111',
    receiptId: '22222222-2222-4222-8222-222222222222',
    kind: 'landed',
    at: '2026-11-17T21:46:00.000Z',
    laneIds: ['33333333-3333-4333-8333-333333333333'],
    commit: 'a'.repeat(64),
    sequence: 1234,
    actor: 'account-id',
    agentRun: 'bronze-oriole',
    agentClient: 'claude-code:claude-opus-5-5',
    landedBy: { by: 'agent', review: 'person' },
  };
  const comment = landingNoteComment('11111111-1111-4111-8111-111111111111', note);
  assert.match(comment.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(comment.id, landingNoteId(note));
  assert.notEqual(comment.id, landingNoteId({ ...note, kind: 'reverted' }));
  assert.equal(comment.landing.actor, 'account-id/bronze-oriole', 'mapped to a handle per viewer on read');
  assert.equal(
    comment.text,
    'Landed by its agent run: Lane 33333333, receipt 22222222, commit aaaaaaaa, main #1234. A person accepted it.',
  );
  assert.equal(comment.landing.accepted, 'person');
  assert(!comment.text.includes('account-id'));
});

test('the Item comment read shows its landing notes once, at the newest end, between the comments around them', async t => {
  const s = await planningSetup(t);
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  const item = s.item({ title: 'Planned' });
  await s.send(item);
  const comment = async text =>
    s.send({
      action: 'comment-planning-item',
      operationId: randomUUID(),
      itemId: item.itemId,
      text,
      authorLabel: 'Owner',
    });
  // The Item's first Intent shares its id (a planned start).
  await records.writeHostedRecord(s.ctx, {
    projectId: s.projectId,
    actor: 'owner',
    authorityEpoch: 1,
    expectedVersion: null,
    planningItemId: item.itemId,
    record: {
      kind: 'intent',
      id: item.itemId,
      version: 0,
      at: new Date().toISOString(),
      outcome: 'Planned',
      constraints: '',
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base: { head: 'a'.repeat(64), receiptId: 'receipt' },
      status: 'active',
    },
  });
  // An injected clock: each step is 5 ms after the last, so comment, note and comment order by time.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const tick = async () => t.mock.timers.tick(5);
  await comment('Before the landing');
  await tick();
  const note = {
    intentId: item.itemId,
    itemId: item.itemId,
    receiptId: randomUUID(),
    kind: 'landed',
    at: new Date().toISOString(),
    laneIds: [randomUUID()],
    commit: 'b'.repeat(64),
    sequence: 7,
    actor: 'owner',
    landedBy: { by: 'queue', review: 'none' },
  };
  assert.equal(await notes.postIntentLandingNote(s.ctx, s.projectId, note), true);
  await tick();
  await comment('After the landing');
  const page = extra =>
    workIndex.records._handler(s.ctx, {
      projectId: s.projectId,
      collection: 'planningComments',
      parentId: item.itemId,
      ...extra,
    });
  const texts = result => result.page.map(row => JSON.parse(row.value).text);
  const newest = await page({ newestFirst: true, paginationOpts: { cursor: null, numItems: 50 } });
  assert.deepEqual(texts(newest), ['After the landing', landingNoteText(note), 'Before the landing']);
  const system = JSON.parse(newest.page[1].value);
  assert.equal(system.system, true);
  assert.equal(system.authorLabel, 'Forge');
  assert.equal(newest.page[1].id, landingNoteId(note));
  // Ascending (the web reads every page): only the last page carries the note, so it shows once.
  const first = await page({ paginationOpts: { cursor: null, numItems: 1 } });
  assert.equal(first.isDone, false);
  assert.deepEqual(texts(first), ['Before the landing']);
  const last = await page({ paginationOpts: { cursor: first.continueCursor, numItems: 10 } });
  assert.equal(last.isDone, true);
  assert.deepEqual(texts(last), [landingNoteText(note), 'After the landing']);
  assert(last.page[0].position > first.page[0].position, 'sorted between the comments around it');
  // A converted landing (Item c0af6cfa) is a new row for an old landing: its position is its landing time, so the
  // record-store read (which positions comments by creation time) sorts it below the comments written after it landed.
  const old = {
    ...note,
    receiptId: randomUUID(),
    at: new Date(Date.parse(note.at) - 60_000).toISOString(),
    sequence: 3,
  };
  assert.equal(await notes.postIntentLandingNote(s.ctx, s.projectId, old), true);
  const { comments } = await notes.intentLandingComments(s.ctx, s.projectId, item.itemId);
  const position = receiptId => comments.find(row => row.value.landing.receiptId === receiptId).position;
  assert.equal(position(old.receiptId), Date.parse(old.at));
  assert(position(old.receiptId) < position(note.receiptId), 'the converted note sorts by its landing time');
  // An Item without a started Intent reads exactly as before.
  const other = s.item({ title: 'Unstarted' });
  await s.send(other);
  const none = await workIndex.records._handler(s.ctx, {
    projectId: s.projectId,
    collection: 'planningComments',
    parentId: other.itemId,
    newestFirst: true,
    paginationOpts: { cursor: null, numItems: 50 },
  });
  assert.deepEqual(none.page, []);
});

test('the identity mapper leaves a note publisher alone even when an account once held the handle "queue" (66f9ed38)', async () => {
  const people = await import(moduleUrl('../convex/publicPeople.ts'));
  const owner = 'user_ownerAAAAAAAA';
  const squatter = 'user_squatterBBBBBBBB';
  // The account registered `queue`, then renamed itself: the old handle still resolves to it.
  const tables = {
    hostedProjects: new Map([['project-1', { _id: 'project-1', owner }]]),
    projectContributors: new Map(),
    forgeAccounts: new Map([
      [owner, { owner, handle: 'lead' }],
      [squatter, { owner: squatter, handle: 'renamed-x' }],
    ]),
    accountHandles: new Map([
      ['lead', { owner, handle: 'lead' }],
      ['renamed-x', { owner: squatter, handle: 'renamed-x' }],
      ['queue', { owner: squatter, handle: 'queue' }],
    ]),
  };
  const view = viewer => {
    let reads = 0;
    const ctx = {
      auth: { getUserIdentity: async () => (viewer ? { subject: viewer } : null) },
      db: {
        normalizeId: (table, id) => (tables[table]?.has(id) ? id : null),
        get: async id => (reads++, tables.hostedProjects.get(id) ?? null),
        query: table => ({
          withIndex: (_name, build) => {
            const filters = {};
            const q = { eq: (field, value) => ((filters[field] = value), q) };
            build(q);
            const rows = () =>
              [...tables[table].values()].filter(row =>
                Object.entries(filters).every(([k, v]) => row[k] === v),
              );
            return {
              unique: async () => (reads++, rows()[0] ?? null),
              take: async n => (reads++, rows().slice(0, n)),
            };
          },
        }),
      },
    };
    return { ctx, reads: () => reads };
  };
  const comment = landingNoteComment('11111111-1111-4111-8111-111111111111', {
    intentId: '11111111-1111-4111-8111-111111111111',
    receiptId: '22222222-2222-4222-8222-222222222222',
    kind: 'landed',
    at: '2026-11-18T12:00:00.000Z',
    laneIds: ['33333333-3333-4333-8333-333333333333'],
    commit: 'a'.repeat(64),
    sequence: 7,
    actor: owner,
    landedBy: { by: 'queue', review: 'none' },
  });
  // The Item comment read returns each row's value as JSON inside the page.
  const page = value =>
    JSON.stringify({ page: [{ position: 1, value: JSON.stringify(value) }], isDone: true });
  const read = async (viewer, value) => {
    const v = view(viewer);
    const out = JSON.parse(await people.publicPeople(v.ctx, { projectId: 'project-1' }, page(value)));
    return { landing: JSON.parse(out.page[0].value).landing, reads: v.reads() };
  };
  const { landedBy: _landedBy, review: _review, ...withoutPublisher } = comment.landing;
  for (const viewer of [owner, null]) {
    const shown = await read(viewer, comment);
    assert.equal(shown.landing.landedBy, 'queue', `viewer ${viewer}: the publisher passes unchanged`);
    assert.equal(shown.landing.review, 'none');
    const baseline = await read(viewer, { ...comment, landing: withoutPublisher });
    assert.equal(shown.reads, baseline.reads, `viewer ${viewer}: the publisher adds no index read`);
  }
  // The fixture does resolve the alias: the old `by` key was rewritten to the squatter's handle.
  const old = await read(owner, { ...comment, landing: { ...withoutPublisher, by: 'queue' } });
  assert.equal(old.landing.by, 'renamed-x');
});

test('a link that names one Intent shows that Intent’s landing notes even when another Item owns it', async t => {
  const s = await planningSetup(t);
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  const [owner, reader] = [s.item({ title: 'Owner' }), s.item({ title: 'Reader' })];
  await s.send(owner);
  await s.send(reader);
  const followUp = successorIntentId(owner.itemId);
  await records.writeHostedRecord(s.ctx, {
    projectId: s.projectId,
    actor: 'owner',
    authorityEpoch: 1,
    expectedVersion: null,
    planningItemId: owner.itemId,
    record: {
      kind: 'intent',
      id: followUp,
      version: 0,
      at: '2026-01-01T00:00:00.000Z',
      outcome: 'Follow-up',
      constraints: '',
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base: { head: 'a'.repeat(64), receiptId: 'receipt' },
      status: 'active',
    },
  });
  await notes.postIntentLandingNote(s.ctx, s.projectId, {
    intentId: followUp,
    itemId: owner.itemId,
    receiptId: randomUUID(),
    kind: 'landed',
    at: '2026-01-01T00:00:00.000Z',
    laneIds: [randomUUID()],
    commit: 'b'.repeat(64),
    sequence: 9,
    actor: 'owner',
  });
  const { comments } = await notes.intentLandingComments(s.ctx, s.projectId, reader.itemId, 50, [followUp]);
  assert.equal(comments.length, 1, 'the exact linked Intent is read');
});
