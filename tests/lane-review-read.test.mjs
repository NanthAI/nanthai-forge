// SPDX-License-Identifier: Apache-2.0
// Items 4bc460aa and 52235fbf: the Lane review screen's one read declares the page's data up front from rows that every
// save already writes. It names the pinned saved head and every changed path with its exact blobs, and reads no State
// object, file body or history, so the reads per view stay a handful of documents whatever the repository's size.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { saveFixture } from './hosted-saves-fixture.mjs';
import { digest } from '../dist/hash.js';

const review = await import(moduleUrl('../convex/projectLaneReview.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));

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
  const read = (args = {}) =>
    s
      .transaction(
        'projectLaneReview:read',
        review.read,
        { projectId: s.projectId, laneId: saved.id, ...args },
        'owner',
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
  assert(meter.documents <= 10, `reads ${meter.documents} documents`);
  assert(meter.readBytes < 64 * 1024, `reads ${meter.readBytes} bytes`);
  for (const table of ['projectBackups', 'projectWorkRecords', 'projectWorkEvents', 'projectHostedSaveJobs'])
    assert(!meter.touched.includes(table), `does not read ${table}`);
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
  assert(meter.documents <= 12, `reads ${meter.documents} documents`);

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
