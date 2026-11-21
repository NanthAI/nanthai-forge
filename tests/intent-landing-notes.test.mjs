// SPDX-License-Identifier: Apache-2.0
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

/** Incident 2bf85ddf (2026-11-17): the builder submitted, its landing parked behind an older entry, the
 * builder stopped ("needs sync"), the older entry landed and the queue landed the parked Lane at 21:46
 * (receipt 1bc84170) with no agent attached. Nothing reached its Item, so the lead briefed a takeover and a
 * review for work already on main. Replay: two Lanes on two Items; the newer passes first and parks behind
 * the older; only scheduled queue steps run after submission (no agent call). */
async function parkedQueueLanding(t) {
  const f = await batchesFixture(t, {
    count: 2,
    batching: false,
    requestCheck: true,
    memberContracts: [[], []],
  });
  const [older, parked] = f.entries.map(entry => entry.state.id);
  const [olderItem, parkedItem] = f.entries.map(entry => entry.selection.request.intentId);
  assert.notEqual(olderItem, parkedItem, 'two Lanes on two Items');
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
    await f.execute(task);
  }
  assert(wasParked, 'the newer Lane parked behind the older one');
  assert.equal(stateOf(f, older).phase, 'landed');
  assert.equal(stateOf(f, parked).phase, 'landed', 'the queue landed the parked Lane');
  return { f, older, parked, olderItem, parkedItem };
}

test('incident replay 2bf85ddf: a parked Lane the queue lands after its agent stopped posts its receipt to its Item', async t => {
  const { f, parked, parkedItem, olderItem } = await parkedQueueLanding(t);
  const receiptId = stateOf(f, parked).acceptance.receiptId;
  const receipt = JSON.parse(
    [...f.tables.projectHostedAcceptances.values()].find(row => row.receiptId === receiptId).value,
  );
  const laneId = f.entries[1].lane.laneId;
  // What the Item read shows (projectWorkIndex:records merges exactly these rows into the Item's comments).
  const shown = await f.c.run('itemComments', (ctx, input) => notes.intentLandingComments(ctx, ...input), [
    f.projectId,
    parkedItem,
  ]);
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
  // The predecessor's Item gets its own note; each Item exactly one.
  assert.equal(notesOf(f, olderItem).length, 1);
  assert.equal(notesOf(f, parkedItem).length, 1);
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
    { ...template, intentId: successor, receiptId: 'later-receipt', at: new Date().toISOString() },
  ]);
  const shown = await f.c.run('itemComments', (ctx, input) => notes.intentLandingComments(ctx, ...input), [
    f.projectId,
    parkedItem,
  ]);
  assert.deepEqual(
    shown.map(row => row.value.landing.receiptId),
    ['later-receipt', template.receiptId],
  );
  assert(
    shown.every(row => row.value.itemId === parkedItem),
    'every note reads as the Item’s comment',
  );
});

test('a revert posts a matching reverted note on the reverted Item, once', async t => {
  const f = await revertFixture(t),
    receipt = await f.landOriginal();
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
  assert.equal(reverted[0].revertOf, receipt.id);
  assert.equal(reverted[0].receiptId, final.acceptance.receiptId);
  assert.deepEqual(reverted[0].laneIds, originalNote.laneIds);
  const text = landingNoteText(reverted[0]);
  assert.match(text, /^Reverted: receipt /);
  assert(text.includes(receipt.id.slice(0, 8)));
  assert(text.includes(final.acceptance.receiptId.slice(0, 8)));
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
