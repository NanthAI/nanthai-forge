// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Items 4bc460aa and 52235fbf: the Lane review screen's one read declares the page's data up front from rows that every
// save already writes. It names the pinned saved head and every changed path with its exact blobs, and reads no State
// object, file body or history, so the reads per view stay a handful of documents whatever the repository's size.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { api as saves, saveFixture } from './hosted-saves-fixture.mjs';
import { digest } from '../dist/hash.js';

const review = await import(moduleUrl('../convex/projectLaneReview.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const lanes = await import(moduleUrl('../convex/projectHostedLiveLanes.ts'));
const overlapBuckets = await import(moduleUrl('../convex/projectHostedOverlapChanges.ts'));

async function lane(changes, extra = {}, savedBy) {
  const s = await saveFixture('original', 'a.txt');
  const base = JSON.parse(
    [...s.tables.projectHostedRecordBodies.values()].find(row => JSON.parse(row.value).kind === 'lane').value,
  );
  const write = (record, overlap, expectedVersion = null, planningItemId) =>
    s.transaction(
      'write',
      {
        _handler: ctx =>
          records.writeHostedRecord(ctx, {
            projectId: s.projectId,
            actor: 'owner',
            authorityEpoch: 1,
            expectedVersion,
            record,
            overlap,
            planningItemId,
          }),
      },
      {},
    );
  const first = {
    ...base,
    id: randomUUID(),
    intentId: randomUUID(),
    version: 0,
    at: new Date().toISOString(),
    ...extra,
  };
  await write(first, { baseSequence: 0, intent: first.intentId });
  const saved = { ...first, head: digest(first.id), version: 1, sourceVersion: 1 };
  await write(
    saved,
    {
      baseSequence: 0,
      intent: first.intentId,
      changes,
      ...(savedBy ? { savedBy } : {}),
    },
    0,
  );
  const read = (args = {}, actor = 'owner') =>
    s
      .transaction(
        'projectLaneReview:read',
        review.read,
        { projectId: s.projectId, laneId: saved.id, ...args },
        actor,
      )
      .then(JSON.parse);
  return { s, saved, read, write };
}

const side = (seed, mode = 'file') => ({ blob: digest(seed), mode });

test('one read names the pinned head and every changed path with its exact blobs, in a handful of documents', async t => {
  const changes = [
    { path: 'src/parser.ts', before: side('p0'), after: side('p1') },
    { path: 'tests/parser.test.ts', before: null, after: side('t1') },
    { path: 'docs/old.md', before: side('d0'), after: null },
  ];
  const { s, saved, read } = await lane(changes);
  const reply = await read();
  assert.equal(reply.lane.head, saved.head);
  assert.equal(reply.lane.goal, null, 'the saved overlap placeholder is not a title');
  assert.equal(reply.lane.saveFailure, undefined);
  assert.equal(reply.files.current, true);
  assert.equal(reply.files.total, 3);
  assert.deepEqual(
    reply.files.items.map(item => [
      item.path,
      item.status,
      item.before?.blob ?? null,
      item.after?.blob ?? null,
    ]),
    // The row keeps changed paths in path order.
    [...changes]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map(change => [
        change.path,
        !change.before ? 'added' : !change.after ? 'deleted' : 'modified',
        change.before?.blob ?? null,
        change.after?.blob ?? null,
      ]),
  );
  assert.equal(reply.files.nextOffset, null);
  assert.deepEqual(reply.conflicts, []);
  const meter = s.counts.filter(c => c.name === 'projectLaneReview:read').at(-1);
  t.diagnostic(`per view: ${meter.documents} documents, ${meter.ranges} ranges, ${meter.readBytes} bytes`);
  // The saved list is read whole: one bucket document per distinct path hash, beside the handful of Lane documents.
  const bucketDocuments = new Set(changes.map(change => overlapBuckets.overlapBucket(change.path))).size;
  assert(meter.documents <= 10 + bucketDocuments, `reads ${meter.documents} documents`);
  assert(meter.readBytes < 64 * 1024, `reads ${meter.readBytes} bytes`);
  assert.equal(meter.workEventReads, 0, 'does not read Work event history');
  for (const table of ['projectBackups', 'projectWorkRecords', 'projectHostedSaveJobs'])
    assert(!meter.touched.includes(table), `does not read ${table}`);
});

test('Lane review and the Lanes list project dismissal permission with the same database reads', async () => {
  const { s, saved, read } = await lane([]);
  const { projectId } = s;
  const laneId = saved.id;
  s.insert('projectContributors', { projectId, contributor: 'writer' });
  s.insert('projectContributors', { projectId, contributor: 'other-writer' });
  s.insert('projectReaders', { projectId, reader: 'reader' });
  const credentialId = randomUUID();
  s.insert('cliCredentials', {
    credentialId,
    owner: 'owner',
    name: 'Synthetic read-only device',
    scope: 'cli',
    tokenHash: 'synthetic',
    issuedAt: 1,
    expiresAt: 8_000_000_000_000,
    revoked: false,
    settings: { source: 'read', projects: { kind: 'all' } },
  });
  const device = { subject: 'owner', forgeCredential: credentialId };
  const head = [...s.tables.projectHostedRecordHeads.values()].find(row => row.key === saved.id);
  const saveFailure = {
    operationId: randomUUID(),
    attemptId: randomUUID(),
    code: 'WORK_STALE',
    at: 1_790_000_000_000,
  };
  const boardRowId = s.insert('projectFinishReadRows', {
    kind: 'projectHostedSaveFailure',
    projectId,
    sourceId: laneId,
    sourceCreatedAt: saveFailure.at,
    value: JSON.stringify(saveFailure),
  });
  const setFailure = actor =>
    s.patch('projectHostedRecordHeads', head._id, {
      saveFailure: actor ? { ...saveFailure, actor, boardRowId } : undefined,
    });
  const list = async actor => {
    const value = await s.transaction(
      'projectHostedLiveLanes:list',
      lanes.list,
      { projectId, cursor: null, limit: 10, byline: true },
      actor,
    );
    return JSON.parse(value).page.find(lane => lane.laneId === laneId);
  };
  const { operationId, attemptId } = saveFailure;
  const dismiss = actor =>
    s.transaction(
      'dismissFailure',
      saves.dismissFailure,
      { projectId, laneId, operationId, attemptId },
      actor,
    );

  for (const visibility of ['private', 'public']) {
    s.patch('hostedProjects', projectId, { visibility });
    for (const [viewer, failingActor, canDismiss] of [
      ['owner', 'writer', true],
      ['writer', 'writer', true],
      ['other-writer', 'writer', false],
      ['reader', 'reader', false],
      [device, 'writer', false],
      ...(visibility === 'public' ? [['former-writer', 'former-writer', false]] : []),
    ]) {
      for (const readLane of [async actor => (await read({}, actor)).lane, list]) {
        setFailure();
        assert.equal((await readLane(viewer)).saveFailure, undefined);
        const healthy = s.counts.at(-1);
        setFailure(failingActor);
        assert.deepEqual((await readLane(viewer)).saveFailure, { ...saveFailure, canDismiss });
        const failed = s.counts.at(-1);
        assert.deepEqual(failed.readDocumentsByTable, healthy.readDocumentsByTable);
        assert.deepEqual(failed.readRangesByTable, healthy.readRangesByTable);
      }
    }
  }
  setFailure('reader');
  await assert.rejects(dismiss('reader'), error => error.data?.code === 'PROJECT_UNAVAILABLE');
  assert.deepEqual((await read({}, 'reader')).lane.saveFailure, { ...saveFailure, canDismiss: false });
  setFailure('writer');
  await assert.rejects(dismiss(device), error => error.data?.code === 'AUTH_SCOPE_DENIED');
  assert.equal(await dismiss('other-writer'), false);
  assert.equal((await read({ offset: 400 })).lane.saveFailure, undefined);
  assert.equal(await dismiss('writer'), true);
  assert.equal((await read()).lane.saveFailure, undefined);
  assert.equal((await list('writer')).saveFailure, undefined);
});

test('the Lane title comes from its Intent even with UUID-only overlap metadata, and a failed read leaves the files', async t => {
  const { s, saved, read, write } = await lane([
    { path: 'src/parser.ts', before: side('p0'), after: side('p1') },
  ]);
  const itemId = randomUUID();
  const title = 'Stream parser: handle split UTF-8';
  await write(
    {
      kind: 'intent',
      id: saved.intentId,
      version: 0,
      at: saved.at,
      outcome: title,
      constraints: '',
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base: saved.base,
      status: 'active',
    },
    undefined,
    null,
    itemId,
  );
  const reply = await read();
  assert.equal(reply.lane.goal, title);
  assert.equal(reply.lane.itemId, itemId);
  const meter = s.counts.at(-1);
  t.diagnostic(
    `view with a title: ${meter.documents} documents, ${meter.ranges} ranges, ${meter.readBytes} bytes`,
  );
  const composeReads = meter.readDocumentsByTable.projectHostedComposeSelections ?? 0;
  assert(composeReads <= 1, 'the direct Lane performs one Candidate selection lookup');
  assert(
    meter.documents - composeReads <= 12,
    `reads ${meter.documents} documents, including ${composeReads} for the selection`,
  );

  const header = [...s.tables.projectHostedRecords.values()].find(
    row => row.kind === 'intent' && row.key === saved.intentId,
  );
  header.digest = digest('unavailable record');
  const unavailable = await read();
  assert.equal(unavailable.lane.goal, null);
  assert.equal(unavailable.lane.itemId, itemId, 'the Item id comes from the readable Intent header');
  assert.deepEqual(unavailable.files, reply.files);
});

test('review attributes a takeover save to its recorded author and omits uncertain historical attribution', async t => {
  const stamp = { authorship: { kind: 'agent' }, agentRun: 'amber-fox', agentClient: 'codex:gpt-example' };
  const holder = { actor: 'other-writer', since: 1, lastSeen: 1, agent: stamp.agentRun };
  const { s, saved, read } = await lane([], { ...stamp, holder }, 'same-save-author');
  const before = await read();
  const meter = s.counts.at(-1);
  const { agent, agentClient, agentAuthored, ...laneFields } = before.lane;
  assert.deepEqual(
    { actor: before.lane.actor, agent, agentClient, agentAuthored },
    {
      actor: 'same-save-author',
      agent: 'amber-fox',
      agentClient: 'codex:gpt-example',
      agentAuthored: true,
    },
  );
  t.diagnostic(
    `Lane detail: ${Buffer.byteLength(JSON.stringify({ ...before, lane: { ...laneFields, agent: null } }))} → ${Buffer.byteLength(JSON.stringify(before))} reply bytes`,
  );
  const row = [...s.tables.projectHostedOverlapLanes.values()].find(entry => entry.laneId === saved.id);
  // Stale projections and historical saves without the author projection must not supply the wrong person.
  row.head = digest('another save');
  assert.equal((await read()).lane.actor, null);
  row.head = saved.head;
  delete row.savedBy;
  const historical = await read();
  assert.equal(historical.lane.actor, null);
  assert.equal(historical.lane.agent, 'amber-fox');
  assert.equal(historical.lane.agentClient, 'codex:gpt-example');
  assert(s.counts.at(-1).documents <= meter.documents);
});

test('a row written for another head is not shown as this save; pages are bounded', async () => {
  const many = Array.from({ length: 450 }, (_, i) => ({
    path: `src/file-${String(i).padStart(3, '0')}.ts`,
    before: side(`b${i}`),
    after: side(`a${i}`),
  }));
  const { s, saved, read } = await lane(many);
  const first = await read();
  assert.equal(first.files.items.length, review.REVIEW_PAGE);
  assert.equal(first.files.nextOffset, review.REVIEW_PAGE);
  const second = await read({ offset: first.files.nextOffset });
  assert.equal(second.files.items.length, 450 - review.REVIEW_PAGE);
  assert.equal(second.files.nextOffset, null);
  // The overlap row moves on to another head: the page says the save is not recorded rather than show other files.
  const row = [...s.tables.projectHostedOverlapLanes.values()].find(entry => entry.laneId === saved.id);
  row.head = digest('another save');
  const stale = await read();
  assert.equal(stale.files.current, false);
  assert.deepEqual(stale.files.items, []);
});

test('an approval link shows its pinned Candidate summary and never substitutes another Lane’s Candidate', async t => {
  const { s, saved, read, write } = await lane([]);
  const { projectId } = s;
  const candidateId = randomUUID();
  const submission = randomUUID();
  const attemptId = randomUUID();
  const operationId = randomUUID();
  const composeOperationId = randomUUID();
  const head = digest('composed separately from the Lane');
  const base = { head: digest('main advanced'), receiptId: 'main-1' };
  const itemId = randomUUID();
  await write(
    {
      kind: 'intent',
      id: saved.intentId,
      version: 0,
      at: saved.at,
      outcome: 'Review the submitted change',
      constraints: '',
      creatorAccountId: 'owner',
      assigneeAccountIds: [],
      base: saved.base,
      status: 'active',
    },
    undefined,
    null,
    itemId,
  );
  await write({
    kind: 'candidate',
    id: candidateId,
    version: 0,
    at: saved.at,
    intentId: saved.intentId,
    base,
    inputs: { sha256: digest('inputs'), size: 10 },
    dependencies: { sha256: digest('dependencies'), size: 10 },
    algorithm: 'native@fixture',
    result: { status: 'clean', head },
  });
  const state = {
    schema: 1,
    id: submission,
    projectId,
    operationId,
    actor: 'owner',
    at: saved.at,
    attemptId,
    firstAttemptId: attemptId,
    sequence: 1,
    version: 1,
    phase: 'ready',
    observation: { state: 'pending', pendingReason: 'waiting-for-review', cause: null },
    error: null,
    request: {
      operationId,
      authorityEpoch: 1,
      candidateId,
      expectedHead: head,
      expectedMain: base,
      channel: 'main',
      agent: true,
      check: null,
      message: 'Split input safely',
      notVerified: ['Device runner'],
      finish: { composeOperationId, after: null },
    },
  };
  const landing = s.insert('projectHostedLandingRequests', {
    projectId,
    candidateId,
    channel: 'main',
    submissionId: submission,
    operationId,
    actor: 'owner',
    attemptId,
    sequence: 1,
    runnable: false,
    phase: 'ready',
    runId: null,
    value: JSON.stringify(state),
  });
  const wrong = await read({ submission });
  assert.equal(wrong.candidate, undefined);
  assert.equal(wrong.candidateUnavailable, true);
  s.insert('projectHostedComposeSelections', {
    projectId,
    actor: 'owner',
    operationId: composeOperationId,
    kind: 'inputs',
    key: saved.id,
    head: saved.head,
  });
  const exact = await read({ submission });
  assert.equal(exact.lane.head, saved.head);
  assert.deepEqual(exact.candidate, {
    candidateId,
    base: base.head,
    head,
    files: null,
    summary: 'Split input safely',
    notVerified: ['Device runner'],
    check: 'not-run',
  });
  const meter = s.counts.at(-1);
  t.diagnostic(`Candidate review: ${meter.documents} documents, ${meter.readBytes} bytes`);
  // One exact landing and compose selection plus the access-checked Candidate Work record.
  assert(meter.documents <= 20);
  assert(meter.readBytes < 64 * 1024);
  assert.equal(meter.writes, 0);
  assert(!meter.touched.includes('projectObjects'));
  s.insert('projectHostedComposes', {
    projectId,
    actor: 'owner',
    jobId: randomUUID(),
    operationId: composeOperationId,
    value: JSON.stringify({ candidateId }),
  });
  s.insert('projectContributors', { projectId, contributor: 'writer' });
  s.insert('projectReaders', { projectId, reader: 'reader' });
  const direct = await read({}, 'writer');
  assert.equal(
    direct.candidate.head,
    head,
    'the Lane selects its live Candidate without the frame feed or a link',
  );
  assert.equal(direct.noteItemId, itemId);
  assert.equal((await read({}, 'reader')).noteItemId, undefined);

  const { lineReviewText } = await import(moduleUrl('../src/candidate-line-note.ts'));
  const { memberPlanningWrite, requireCandidateLineNote } = await import(
    moduleUrl('../convex/projectPlanningWriteAccess.ts')
  );
  const work = await import(moduleUrl('../convex/projectWorkCommand.ts'));
  const pin = {
    candidateId,
    laneId: saved.id,
    base: base.head,
    head,
    path: 'src/exact.ts',
    side: 'head',
    blob: digest('file'),
    line: 1,
    changed: true,
  };
  const command = {
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId,
    text: lineReviewText(pin, 'Check this case.'),
    authorLabel: '',
  };
  assert.equal(memberPlanningWrite(command, false), true);
  assert.equal(memberPlanningWrite({ ...command, text: 'An ordinary comment' }, false), false);
  assert.equal(memberPlanningWrite({ ...command, decision: true }, false), false);
  const authorize = command =>
    s.transaction(
      'writerNote',
      {
        _handler: ctx => requireCandidateLineNote(ctx, { projectId, actor: 'writer' }, command),
      },
      {},
      'writer',
    );
  await authorize(command);
  await assert.rejects(
    authorize({ ...command, itemId: randomUUID() }),
    error => error.code === 'PROJECT_UNAVAILABLE',
  );
  await assert.rejects(
    authorize({ ...command, text: lineReviewText({ ...pin, head: saved.head }, 'Wrong head') }),
    error => error.code === 'PROJECT_UNAVAILABLE',
  );
  await assert.rejects(
    s.transaction(
      'readerNote',
      work.command,
      {
        projectId,
        operationId: command.operationId,
        command: JSON.stringify(command),
      },
      'reader',
    ),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );

  s.patch('projectHostedLandingRequests', landing, {
    value: JSON.stringify({ ...state, request: { ...state.request, expectedHead: saved.head } }),
  });
  const mismatched = await read({ submission });
  assert.equal(mismatched.candidate, undefined);
  assert.equal(mismatched.candidateUnavailable, true);
});

test('a landed Lane names its own time to main and stops, from its receipt and landing row only', async t => {
  const { s, saved, read } = await lane([{ path: 'src/parser.ts', before: side('p0'), after: side('p1') }]);
  const before = await read();
  assert.equal(before.lane.landed, null, 'an open Lane carries no timing and reads no landing');
  const receiptId = randomUUID(),
    submissionId = randomUUID(),
    landingAttempt = randomUUID();
  const at = Date.parse('2026-11-18T10:00:00.000Z');
  const iso = seconds => new Date(at + seconds * 1000).toISOString();
  await s.transaction(
    'seed',
    {
      _handler: async ctx => {
        const row = await ctx.db
          .query('projectHostedOverlapLanes')
          .withIndex('by_project_and_lane', q => q.eq('projectId', s.projectId).eq('laneId', saved.id))
          .unique();
        await ctx.db.patch(row._id, {
          landed: { receiptId, commit: digest('c1'), laneHead: saved.head, at: iso(477) },
        });
        await ctx.db.insert('projectHostedAcceptances', {
          projectId: s.projectId,
          receiptId,
          submissionId,
          attemptId: randomUUID(),
          sequence: 1,
          value: JSON.stringify({ id: receiptId, submissionId, at: iso(477) }),
        });
        await ctx.db.insert('projectHostedLandingRequests', {
          projectId: s.projectId,
          channel: 'main',
          submissionId,
          operationId: randomUUID(),
          actor: 'owner',
          sequence: 1,
          runnable: false,
          phase: 'landed',
          runId: null,
          attemptId: landingAttempt,
          value: JSON.stringify({
            id: submissionId,
            attemptId: landingAttempt,
            at: iso(0),
            timing: {
              submittedAt: iso(0),
              checkReservedAt: iso(42),
              ciEndedAt: iso(472),
              committedAt: iso(477),
            },
          }),
        });
      },
    },
    {},
  );
  const reply = await read();
  assert.deepEqual(reply.lane.landed.timing, { toMain: 477, queue: 42, check: 430, land: 5 });
  const meter = s.counts.filter(c => c.name === 'projectLaneReview:read').at(-1);
  t.diagnostic(`landed view: ${meter.documents} documents, ${meter.readBytes} bytes`);
  assert(meter.documents <= 12, `reads ${meter.documents} documents`);
});
