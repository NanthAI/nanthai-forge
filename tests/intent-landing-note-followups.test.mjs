// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { acceptanceFixture, control } from './hosted-acceptance-fixture.mjs';
import { batchesFixture, batchPublish, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import {
  setup as planningSetup,
  actions as workActions,
  pinIntent,
  beginRetainedWork,
} from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
import { mergeItems } from '../dist/planning-batch.js';
import { digest } from '../dist/hash.js';
import { landingNoteId, landingNoteText } from '../dist/intent-landing-note.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { landingFixture } from './hosted-landing-fixture.mjs';
import { ticketState } from './landing-ticket-fixture.mjs';
import { indexStorage } from './convex-index-cost.mjs';

const notes = await import(moduleUrl('../convex/projectIntentLandingNotes.ts'));
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
const workIndex = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const { read: archiveSelection } = await import(moduleUrl('../convex/projectJournalRead.ts'));
const { history: archiveReader } = await import(moduleUrl('../convex/projectJournalActions.ts'));
const { encodeLandingCapsule } = await import(moduleUrl('../convex/projectLandingCapsuleCodec.ts'));
const { retainLandingNoteReference } = await import(
  moduleUrl('../convex/projectIntentLandingNoteArchive.ts')
);
const { capsuleKind } = await import(moduleUrl('../convex/projectLandingCapsuleStore.ts'));
const hostedStart = await import(moduleUrl('../convex/projectHostedStart.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const stateOf = (f, id) => states(f).find(state => state.id === id);
const notesOf = (f, intentId) =>
  [...f.tables.projectIntentLandingNotes.values()].filter(row => row.intentId === intentId);
const AT = '2026-01-01T00:00:00.000Z';
const resolutionOf = (f, origin) => ({
  candidateId: null,
  conflicts: { sha256: f.state.sha256, size: f.state.size },
  left: f.state.sha256,
  right: f.state.sha256,
  draftHead: f.state.sha256,
  origin: { laneId: origin.laneId, head: origin.head, sourceVersion: origin.sourceVersion },
  status: 'resolved',
});

/** Review 66f9ed38: an explicit accept of one cohort member publishes the whole cohort in one CAS. Only the
 * accepted member was landed by the accepting run; the others landed with the cohort, as the queue lands
 * them. Replay: three batched members pass their shared check; the first member's agent accepts. */
test('an explicit accept that publishes a cohort labels only the accepted member with its run (66f9ed38)', async t => {
  let now = Date.parse(AT);
  const f = await batchesFixture(t, { count: 3, memberContracts: [[], [], []], startAt: now });
  // Planned Intents carry their Item marker; only a marked Intent posts a landing note (Item fc1831eb).
  for (const head of f.tables.projectHostedRecordHeads.values())
    if (head.kind === 'intent' && head.planningItemId === undefined)
      f.patch('projectHostedRecordHeads', head._id, { planningItemId: head.key });
  // The accepting agent retries while its cohort still stages completion evidence (publish releases main).
  const first = f.entries[0].state.id;
  let accepted = null;
  for (let tick = 0; ; tick++) {
    assert(tick < 800, JSON.stringify(states(f).map(s => [s.sequence, s.phase])));
    for (const run of f.runs().filter(run => run.status === 'queued'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    const ready = states(f).filter(s => s.phase === 'ready' && s.batchId && !s.batchSolo);
    if (!accepted && ready.length === f.entries.length) {
      const published = await f.runAcceptance(
        'explicitCohortAccept',
        async (ctx, input) => {
          const claim = await control.claimReadyLanding(
            ctx,
            { ...input, channel: 'main', owner: randomUUID() },
            now,
            false,
          );
          assert(claim && !('waitingFor' in claim), 'the oldest member holds main');
          return batchPublish.publishLandingBatch(ctx, claim, now, 'agent');
        },
        f.select(states(f).find(s => s.id === first)),
      );
      if (published.status === 'landed') accepted = first;
    }
    const task = f.pending()[0];
    if (!task) break;
    now = Math.max(now, task.scheduledTime);
    await f.execute(task);
  }
  assert(accepted, 'the explicit accept published the cohort');
  const receipts = new Set();
  for (const entry of f.entries) {
    assert.equal(stateOf(f, entry.state.id).phase, 'landed');
    const [note] = notesOf(f, entry.selection.request.intentId);
    assert(note, 'every member noted its Item');
    receipts.add(note.receiptId);
    assert.equal(
      note.landedBy.by,
      entry.state.id === accepted ? 'agent' : 'queue',
      `member ${entry.state.id.slice(0, 8)}`,
    );
  }
  assert.equal(receipts.size, f.entries.length, 'one receipt per member');
});

const seedIntent = async (f, linked = true) => {
  const intentId = randomUUID();
  await f.runAcceptance('acceptanceSeed', records.writeHostedRecord, {
    ...f.auth,
    expectedVersion: null,
    ...(linked ? { planningItemId: intentId } : {}),
    record: {
      kind: 'intent',
      id: intentId,
      version: 0,
      at: '2026-01-01T00:00:00.000Z',
      outcome: 'Planned Issue',
      constraints: '',
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base: { head: f.main.head, receiptId: f.main.receipt.id },
      status: 'active',
    },
  });
  return intentId;
};

test('an independent or unmarked legacy landing posts no Item note and schedules no fold; a marked one does both', async t => {
  for (const [name, request] of [
    ['completing', {}],
    ['notes only', { closes: false }],
  ]) {
    const result = {};
    let plannedNote;
    for (const kind of ['planned', 'legacy', 'independent']) {
      const f = await acceptanceFixture();
      const policy = policyPreset('supervised');
      f.patch('hostedProjects', f.projectId, {
        autonomyPolicy: { ...policy, lifecycle: { ...policy.lifecycle, completeOnAccept: true } },
      });
      let intentId, lane;
      if (kind === 'legacy') {
        intentId = await seedIntent(f, false);
        lane = await f.lane({ intentId });
      } else {
        const started = JSON.parse(
          await f.transaction('acceptanceStart', hostedStart.start, {
            projectId: f.projectId,
            operationId: randomUUID(),
            authorityEpoch: 1,
            expectedMain: { head: f.main.head, receiptId: f.main.receipt.id },
            initialHead: f.state.sha256,
            intent:
              kind === 'planned'
                ? { kind: 'planned', intentId: randomUUID(), outcome: 'Planned Issue', constraints: '' }
                : { kind: 'new', outcome: 'Independent Intent' },
          }),
        );
        assert(started.lane, JSON.stringify(started));
        intentId = started.intentId;
        const { laneId, head, version, sourceVersion, lifecycleVersion } = started.lane;
        lane = {
          laneId,
          head,
          version,
          sourceVersion,
          lifecycleVersion,
          state: { object: { sha256: head, size: f.state.size }, recipe: null },
        };
      }
      const { state } = await f.ready(await f.makeCandidate([lane], [], { intentId }), request);
      const { receipt } = await f.accept(state);
      await f.materialize(receipt.id);
      const meter = f.counts.at(-1);
      const stored = notesOf(f, intentId);
      if (kind === 'planned') [plannedNote] = stored;
      assert.deepEqual(
        stored.map(note => [note.receiptId, note.laneIds]),
        kind === 'planned' ? [[receipt.id, [lane.laneId]]] : [],
        `${name}: ${kind}`,
      );
      result[kind] = meter;
    }
    assert.equal(
      result.planned.writes - result.legacy.writes,
      2,
      `${name}: one scheduled Initiative fold and one note`,
    );
    assert.equal(
      result.legacy.writes,
      result.independent.writes,
      `${name}: an unmarked Intent writes like an independent one`,
    );
    assert.deepEqual(result.independent.written, result.legacy.written, name);
    assert.equal(result.planned.ranges - result.independent.ranges, 2, name);
    const { itemId, ...previousNote } = plannedNote;
    assert.equal(itemId, plannedNote.intentId);
    const before = Buffer.byteLength(JSON.stringify(previousNote));
    const after = result.planned.writeBytesByTable.projectIntentLandingNotes;
    const index = indexStorage(
      schema,
      { projectIntentLandingNotes: new Map([[plannedNote._id, plannedNote]]) },
      index => index.indexDescriptor === 'by_project_and_item_and_at',
    );
    assert.equal(index.entries, 1, 'the Item index adds one key per note');
    assert(after - before + index.keyBytes <= 300, 'the Item projection stays within twice its byte model');
    t.diagnostic(
      `${name}: ${result.planned.writes} → ${result.independent.writes} writes, ` +
        `completion read ${result.planned.documents} documents across ${result.planned.ranges} ranges ` +
        `(${result.planned.readBytes} B), wrote ${before} → ${after} B per note, ` +
        `Item index key +${index.keyBytes} B`,
    );
  }
});

/** Review 66f9ed38: a resolution Lane carries its conflicted original's work to main whether or not the
 * landing completes Lanes. The completing landing already noted the original's Item; keepOpen and
 * closes:false (Lanes stay open) now do too, through the resolution Lane, from the overlap rows the tick
 * reads anyway. */
test('a resolution Lane landed with keepOpen or closes:false notes its origin Item through it, as a completing landing does', async () => {
  for (const [name, request] of [
    ['keepOpen', { keepOpen: true }],
    ['closes:false', { closes: false }],
    ['completing', {}],
  ]) {
    const f = await acceptanceFixture();
    const policy = { ...policyPreset('supervised'), agentDefaults: { preflight: 'advise' } };
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: { ...policy, lifecycle: { ...policy.lifecycle, completeOnAccept: true } },
    });
    const originItem = await seedIntent(f),
      resolutionItem = await seedIntent(f);
    const origin = await f.lane({ intentId: originItem });
    const resolution = await f.lane({
      intentId: resolutionItem,
      resolution: resolutionOf(f, origin),
    });
    // The overlap rows every saved hosted Lane has; the resolution names its origin.
    const overlap = (lane, intentId, extra = {}) => {
      const old = [...f.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === lane.laneId);
      if (old) return f.patch('projectHostedOverlapLanes', old._id, { intentId, ...extra });
      return f.insert('projectHostedOverlapLanes', {
        projectId: f.projectId,
        laneId: lane.laneId,
        intentId,
        actor: 'owner',
        intent: 'Synthetic',
        head: lane.head,
        baseHead: f.main.head,
        baseReceiptId: f.main.receipt.id,
        baseSequence: 0,
        recordVersion: 0,
        open: true,
        pathSummary: { paths: [], pathCount: 0 },
        complete: false,
        lastActivityAt: Date.parse(AT),
        ...extra,
      });
    };
    overlap(origin, originItem);
    overlap(resolution, resolutionItem, { resolutionOrigin: origin.laneId });
    const { state } = await f.ready(await f.makeCandidate([resolution]), request);
    const { receipt } = await f.accept(state);
    await f.materialize(receipt.id);
    const [note, ...more] = notesOf(f, originItem);
    assert(note, `${name}: the origin's Item has the landing note`);
    assert.equal(more.length, 0, name);
    assert.deepEqual(
      { receiptId: note.receiptId, laneIds: note.laneIds, viaLaneId: note.viaLaneId },
      { receiptId: receipt.id, laneIds: [origin.laneId], viaLaneId: resolution.laneId },
      name,
    );
    assert.deepEqual(
      notesOf(f, resolutionItem).map(row => row.laneIds),
      [[resolution.laneId]],
      `${name}: the resolution's own Item`,
    );
  }
});

test('a later resolution on the same Lane does not change which origin Item the accepted receipt credits', async () => {
  const f = await acceptanceFixture();
  const originalItem = await seedIntent(f);
  const newerItem = await seedIntent(f);
  const resolutionItem = await seedIntent(f);
  const original = await f.lane({ intentId: originalItem });
  const newer = await f.lane({ intentId: newerItem });
  const resolution = await f.lane({ intentId: resolutionItem, resolution: resolutionOf(f, original) });
  const { state } = await f.ready(await f.makeCandidate([resolution]), { closes: false });
  const { receipt } = await f.accept(state);
  await f.changeLane(resolution.laneId, {
    head: 'a'.repeat(64),
    sourceVersion: resolution.sourceVersion + 1,
    resolution: resolutionOf(f, newer),
  });
  await f.materialize(receipt.id);
  assert.deepEqual(notesOf(f, newerItem), []);
  assert.deepEqual(
    notesOf(f, originalItem).map(note => [note.receiptId, note.laneIds, note.viaLaneId]),
    [[receipt.id, [original.laneId], resolution.laneId]],
  );
});

/** Review 66f9ed38: merging duplicates moves their Lane links to the survivor (each duplicate's Intent joins
 * its intentIds), so the survivor's comment read shows the duplicates' landing notes too. Both Work store
 * readers load the Item: the journal record, and on a records-store project `storeItem` (review 5b7fdb31). */
for (const retained of [false, true])
  test(`a merged Item shows the landing notes of its merged duplicates (${retained ? 'retained' : 'historical'} events)`, async t => {
    const s = await planningSetup(t);
    s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
    if (retained) beginRetainedWork(s);
    const survivor = s.item({ title: 'Survivor' }),
      duplicate = s.item({ title: 'Duplicate' });
    await s.send(survivor);
    await s.send(duplicate);
    const note = {
      intentId: duplicate.itemId,
      itemId: duplicate.itemId,
      receiptId: randomUUID(),
      kind: 'landed',
      at: AT,
      laneIds: [randomUUID()],
      commit: 'c'.repeat(64),
      sequence: 9,
      actor: 'owner',
      landedBy: { by: 'queue', review: 'none' },
    };
    // The duplicate's work landed on its own Intent (the Issue's id) before the merge. A records-store
    // project already holds that Intent's record from the Issue write.
    if (!(await records.recordHead(s.ctx, s.projectId, 'intent', duplicate.itemId)))
      await records.writeHostedRecord(s.ctx, {
        projectId: s.projectId,
        actor: 'owner',
        authorityEpoch: 1,
        expectedVersion: null,
        planningItemId: duplicate.itemId,
        record: {
          kind: 'intent',
          id: duplicate.itemId,
          version: 0,
          at: AT,
          outcome: 'Duplicate',
          constraints: '',
          creatorAccountId: 'owner',
          assigneeAccountIds: [],
          base: { head: 'a'.repeat(64), receiptId: 'receipt' },
          status: 'active',
        },
      });
    assert.equal(await notes.postIntentLandingNote(s.ctx, s.projectId, note), true);
    const shown = async itemId =>
      (
        await workIndex.records._handler(s.ctx, {
          projectId: s.projectId,
          collection: 'planningComments',
          parentId: itemId,
          newestFirst: true,
          paginationOpts: { cursor: null, numItems: 50 },
        })
      ).page.map(row => JSON.parse(row.value));
    assert.deepEqual(await shown(survivor.itemId), [], 'before the merge');
    const version = item => ({
      id: item.itemId,
      version: 1,
      title: item.title,
      kind: 'issue',
      intentIds: [],
    });
    for (const write of mergeItems(version(survivor), [version(duplicate)], await shown(duplicate.itemId)))
      await s.send({ ...write, operationId: randomUUID() });
    const merged = await shown(survivor.itemId);
    assert.equal(merged.length, 1, 'the merge does not copy the receipt as a member comment');
    assert.equal(merged[0].system, true);
    assert.deepEqual(
      merged.map(row => [row.itemId, row.landing.receiptId]),
      [[survivor.itemId, note.receiptId]],
      'the survivor shows the duplicate’s receipt as its own comment',
    );
    assert.deepEqual(
      (await shown(duplicate.itemId)).map(row => row.landing.receiptId),
      [note.receiptId],
      'the duplicate keeps its note',
    );
  });

test('linked landing notes use bounded comment continuations without dropping notes or member comments', async t => {
  const s = await planningSetup(t);
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  const linked = Array.from({ length: 18 }, randomUUID).sort();
  const item = s.item({ intentIds: linked });
  for (const id of linked) {
    await s.send(s.item({ itemId: id, title: 'Duplicate' }));
    await pinIntent(s.ctx, {
      projectId: s.projectId,
      actor: 'owner',
      authorityEpoch: 1,
      planningItemId: id,
      record: {
        kind: 'intent',
        id,
        at: AT,
        outcome: 'Linked work',
        constraints: '',
        creatorAccountId: 'owner',
        assigneeAccountIds: [],
        base: { head: 'a'.repeat(64), receiptId: 'receipt' },
        status: 'active',
      },
    });
    await notes.postIntentLandingNote(s.ctx, s.projectId, {
      intentId: id,
      itemId: id,
      receiptId: randomUUID(),
      kind: 'landed',
      at: AT,
      laneIds: [randomUUID()],
      commit: 'b'.repeat(64),
      sequence: 1,
      actor: 'owner',
    });
  }
  await s.send(item);
  for (const text of ['First comment', 'Second comment'])
    await s.send({ action: 'comment-planning-item', operationId: randomUUID(), itemId: item.itemId, text });
  await assert.rejects(
    workIndex.records._handler(s.ctx, {
      projectId: s.projectId,
      collection: 'planningComments',
      parentId: item.itemId,
      newestFirst: true,
      paginationOpts: {
        cursor:
          'forge-linked-landing-notes:' +
          JSON.stringify({
            itemId: item.itemId,
            newestFirst: true,
            offset: 8,
            recordsCursor: '',
            recordsDone: true,
          }),
        numItems: 1,
      },
    }),
    /Use the returned cursor/,
  );
  for (const newestFirst of [true, false]) {
    const values = [];
    let cursor = null;
    for (let step = 0; ; step++) {
      assert(step < 5, 'the comment and linked-note cursors both finish');
      const result = await workIndex.records._handler(s.ctx, {
        projectId: s.projectId,
        collection: 'planningComments',
        parentId: item.itemId,
        newestFirst,
        paginationOpts: { cursor, numItems: 1 },
      });
      const shown = result.page.map(row => JSON.parse(row.value));
      assert(shown.filter(comment => comment.system).length <= 8, 'one linked-note range per page');
      values.push(...shown);
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    assert.deepEqual(
      values
        .filter(comment => comment.system)
        .map(row => row.landing.intentId)
        .sort(),
      linked,
    );
    assert.deepEqual(
      values
        .filter(comment => !comment.system)
        .map(row => row.text)
        .sort(),
      ['First comment', 'Second comment'],
    );
  }
});

/** Item 7e5f0ad3: the owner's planning export carries the Items' landing receipts, paged (200 per call). */
test('the planning export carries every landing note, across export pages', async t => {
  const s = await planningSetup(t);
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  const item = s.item({ title: 'Exported' });
  await s.send(item);
  const account = 'user_fixtureOwner123';
  s.tables.forgeAccounts.set(account, { owner: account, handle: 'fixture-user' });
  const posted = [];
  for (let i = 0; i < 201; i++) {
    const note = {
      intentId: item.itemId,
      itemId: item.itemId,
      receiptId: randomUUID(),
      kind: 'landed',
      at: AT,
      laneIds: [randomUUID()],
      commit: 'd'.repeat(64),
      sequence: i + 1,
      actor: account,
      landedBy: { by: 'queue', review: 'none' },
    };
    assert.equal(await notes.postIntentLandingNote(s.ctx, s.projectId, note), true);
    posted.push(note);
  }
  let pages = 0;
  const query = s.ctx.runQuery;
  s.ctx.runQuery = (ref, args) => {
    if (getFunctionName(ref) === 'projectIntentLandingNotes:exportPage') pages++;
    return query(ref, args);
  };
  s.caller('reader');
  await assert.rejects(
    workActions.exportPlanning._handler(s.ctx, { projectId: s.projectId }),
    /unavailable/i,
  );
  assert.equal(pages, 0, 'a non-owner never reads note pages');
  s.caller('owner');
  const exported = JSON.parse(await workActions.exportPlanning._handler(s.ctx, { projectId: s.projectId }));
  s.ctx.runQuery = query;
  const manifest = JSON.parse(exported.json);
  assert.equal(pages, 2, '201 notes, 200 per page');
  assert.equal(manifest.landingNotes.length, posted.length);
  const byId = new Map(manifest.landingNotes.map(row => [row.id, row]));
  for (const note of posted) {
    const row = byId.get(landingNoteId(note));
    assert(row, 'every note exported once');
    assert.equal(row.intentId, note.intentId);
    assert.equal(row.text, landingNoteText(note));
    assert.equal(row.landing.receiptId, note.receiptId);
    assert.equal(row.system, true);
    assert.equal(row.landing.actor, 'fixture-user');
    assert(!('itemId' in row), 'keyed by Intent: one Intent can show on several Items');
  }
  assert.equal(exported.sha256, digest(exported.json));
  assert.match(manifest.coverage, /system landing notes/);
});

test('merged Item discussion and owner export retain hot, legacy and verified capsule notes', async t => {
  const s = await planningSetup(t);
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  beginRetainedWork(s);
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const duplicate = s.item({ itemId: id(1), title: 'Duplicate' });
  const survivor = s.item({ itemId: id(2), title: 'Survivor', intentIds: [duplicate.itemId] });
  await s.send(duplicate);
  await s.send(survivor);
  await s.send({
    action: 'comment-planning-item',
    operationId: id(3),
    itemId: survivor.itemId,
    text: 'Member comment',
  });
  const makeNote = (sequence, receiptId, kind = 'landed') => ({
    intentId: duplicate.itemId,
    itemId: duplicate.itemId,
    receiptId,
    kind,
    at: AT,
    laneIds: [id(4)],
    commit: 'd'.repeat(64),
    sequence,
    actor: 'owner',
    ...(kind === 'reverted' ? { revertOf: id(5) } : {}),
  });
  const cold = [makeNote(1, id(6)), makeNote(1, id(6), 'reverted')];
  const legacy = makeNote(2, id(7));
  const all = [...cold, legacy, ...Array.from({ length: 48 }, (_, i) => makeNote(i + 3, id(i + 100)))];
  for (const note of all) await notes.postIntentLandingNote(s.ctx, s.projectId, note);
  const landing = await landingFixture();
  const submitted = await landing.enqueue(landing.request());
  const source = [...landing.tables.projectHostedLandingRequests.values()].find(
    row => row.submissionId === submitted.id,
  );
  const anchor = { ...ticketState(landing, source), phase: 'landed' };
  const objects = new Map();
  const requests = [];
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, init) => {
    const path = new URL(url).pathname;
    if (!path.includes('/landing-capsules/')) return originalFetch(url, init);
    requests.push(init?.method ?? 'GET');
    const body = objects.get(path.split('/').at(-1));
    return new Response(body, { status: body ? 200 : 404 });
  });
  async function publish(submissionId, receiptId, rows) {
    const capsule = {
      protocol: 1,
      projectId: s.projectId,
      submissionId,
      anchor: {
        ...anchor,
        id: submissionId,
        projectId: s.projectId,
        acceptance: { receiptId, head: 'd'.repeat(64) },
      },
      tables: rows.length ? { projectIntentLandingNotes: rows.map(canonicalPayload) } : {},
    };
    const { body, pointer } = encodeLandingCapsule(capsule);
    objects.set(pointer.sha256, body);
    await s.ctx.db.insert('projectFinishReadRows', {
      kind: capsuleKind,
      sourceId: submissionId,
      projectId: s.projectId,
      submissionId,
      value: canonicalPayload(pointer),
    });
    for (const row of rows) {
      await retainLandingNoteReference(s.ctx, submissionId, row);
    }
    return pointer.size;
  }
  const hotExport = JSON.parse(await workActions.exportPlanning._handler(s.ctx, { projectId: s.projectId }));
  const coldRows = [...s.tables.projectIntentLandingNotes.values()].filter(row => row.receiptId === id(6));
  const capsuleBytes = await publish(id(8), id(6), coldRows);
  await publish(id(9), id(7), []);
  const query = s.ctx.runQuery;
  let selectionCalls = 0;
  let revoke = false;
  s.ctx.runQuery = async (ref, args) => {
    if (getFunctionName(ref) !== 'projectJournalRead:read') return query(ref, args);
    selectionCalls++;
    const result = await archiveSelection._handler(s.ctx, args);
    if (revoke) s.caller('visitor');
    return result;
  };
  const request = {
    projectId: s.projectId,
    collection: 'planningComments',
    parentId: survivor.itemId,
    newestFirst: true,
    paginationOpts: { cursor: null, numItems: 50 },
  };
  const marker = await workIndex.records._handler(s.ctx, request);
  assert.equal(marker.journalHistory, true);
  assert.equal(marker.landingNotePins, undefined, 'capsule selection stays private');
  assert.equal(requests.length, 0, 'the live query makes no object-store request');
  const read = async cursor =>
    JSON.parse(
      await archiveReader._handler(s.ctx, {
        projectId: s.projectId,
        query: 'projectWorkIndex:records',
        request: JSON.stringify({ ...request, paginationOpts: { ...request.paginationOpts, cursor } }),
      }),
    );
  const first = await read(null);
  assert.equal(first.isDone, false);
  const last = await read(first.continueCursor);
  assert.equal(last.isDone, true);
  const discussion = [...first.page, ...last.page].map(row => JSON.parse(row.value));
  assert.deepEqual(
    discussion.filter(row => !row.system).map(row => row.text),
    ['Member comment'],
  );
  const system = discussion.filter(row => row.system);
  assert.deepEqual(system.map(row => row.id).sort(), all.map(landingNoteId).sort());
  assert(system.every(row => row.itemId === survivor.itemId && row.landing.intentId === duplicate.itemId));
  assert(requests.every(method => method === 'GET'));
  const after = JSON.parse(await workActions.exportPlanning._handler(s.ctx, { projectId: s.projectId }));
  assert.equal(after.sha256, hotExport.sha256, 'the export and its digest survive relocation');
  const db = s.ctx.db;
  let dbDocuments = 0;
  let dbReadBytes = 0;
  const countReads =
    method =>
    async (...args) => {
      const result = await method(...args);
      const documents = Array.isArray(result) ? result : (result?.page ?? (result ? [result] : []));
      dbDocuments += documents.length;
      dbReadBytes += documents.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row)), 0);
      return result;
    };
  s.ctx.db = {
    ...db,
    get: countReads(db.get),
    query: table => {
      const query = db.query(table);
      for (const operation of ['unique', 'first', 'take', 'paginate', 'collect'])
        query[operation] = countReads(query[operation]);
      return query;
    },
  };
  let historySize = all.length;
  for (const history of [2148, 4296]) {
    while (historySize < history) {
      historySize++;
      await s.ctx.db.insert('projectIntentLandingNotes', {
        ...makeNote(historySize, id(20_000 + historySize)),
        intentId: id(30_000 + historySize),
        itemId: id(30_000 + historySize),
        projectId: s.projectId,
      });
    }
    const samples = [];
    const beforeCalls = selectionCalls;
    const beforeGets = requests.length;
    dbDocuments = 0;
    dbReadBytes = 0;
    for (let sample = 0; sample < 20; sample++) {
      const start = performance.now();
      await workIndex.records._handler(s.ctx, request);
      await read(null);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    t.diagnostic(
      JSON.stringify({
        history,
        fixtureColdReadP90Ms: +samples[17].toFixed(2),
        functionCalls: 2 + (selectionCalls - beforeCalls) / samples.length,
        dbDocumentsPerPage: dbDocuments / samples.length,
        dbReadBytesPerPage: dbReadBytes / samples.length,
        objectGetsPerPage: (requests.length - beforeGets) / samples.length,
        objectBytesPerPage: capsuleBytes,
        peakRssKiB: process.resourceUsage().maxRSS,
      }),
    );
  }
  s.ctx.db = db;
  revoke = true;
  await assert.rejects(read(null), error => (error.code ?? error.data?.code) === 'PROJECT_UNAVAILABLE');
});

test('later input pages merge Lane IDs into the same note using the existing completion ticks', async t => {
  const f = await acceptanceFixture();
  const spread = await seedIntent(f);
  const other = await seedIntent(f);
  const lanes = [];
  for (let i = 0; i <= 100; i++)
    lanes.push(await f.lane({ intentId: [0, 20, 100].includes(i) ? spread : other }));
  const { state, item } = await f.ready(await f.makeCandidate(lanes), { closes: false });
  assert.deepEqual(
    item.pages.inputs.map(page => page.value.entries.length),
    [100, 1],
  );
  const { receipt } = await f.accept(state);
  const plan = () =>
    [...f.tables.projectHostedAcceptancePlans.values()].find(row => row.receiptId === receipt.id);
  const start = f.counts.length;
  while (plan().appliedPage < 2) {
    assert(f.counts.length - start < 6, 'one tick for every 20 entries and one tick for the second page');
    await f.materialize(receipt.id);
  }
  assert.deepEqual(
    notesOf(f, spread).map(note => note.laneIds),
    [[lanes[0].laneId, lanes[20].laneId, lanes[100].laneId]],
    'one note includes Lanes from a later tick and from a later input page',
  );
  assert.equal(notesOf(f, other)[0].laneIds.length, 5, 'existing five-Lane display bound');
  const ticks = f.counts.slice(start);
  const overlapTable = 'projectHostedOverlapLanes';
  const overlapReads = ticks.map(row => row.readRangesByTable[overlapTable] ?? 0);
  // 101 -> 100 (Item c0af6cfa): the first tick no longer reads the range of rows with no lastActivityAt.
  assert.deepEqual(overlapReads, [100, 0, 0, 0, 0, 1], 'only the existing overlap retirement reads');
  t.diagnostic(
    JSON.stringify({
      overlapReads,
      overlapReadBytes: ticks.map(row => row.readBytesByTable[overlapTable] ?? 0),
      completionCalls: ticks.length,
    }),
  );

  f.patch('projectHostedAcceptancePlans', plan()._id, { appliedPage: 1, appliedEntry: 0 });
  await f.materialize(receipt.id);
  assert.equal(f.counts.at(-1).writeBytesByTable.projectIntentLandingNotes ?? 0, 0);
  assert.deepEqual(
    notesOf(f, spread).map(note => note.laneIds),
    [[lanes[0].laneId, lanes[20].laneId, lanes[100].laneId]],
    'replaying the later page adds no duplicate Lane or note',
  );
});
