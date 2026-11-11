// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { encodeArchiveBytes, decodeArchiveBytes } from '../dist/landing-capsule-bytes.js';
import { journalSegmentText, journalTablePins, readJournalSegment } from '../dist/journal-segment.js';
import { hydrateLandingHistory } from '../dist/landing-capsule-client.js';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const reads = await import(moduleUrl('../convex/projectHostedRecordReads.ts'));
const store = await import(moduleUrl('../convex/projectJournalStore.ts'));
const internalReads = await import(moduleUrl('../convex/projectJournalRead.ts'));
const actions = await import(moduleUrl('../convex/projectJournalActions.ts'));
const people = await import(moduleUrl('../convex/publicPeople.ts'));
const code = expected => error => (error.code ?? error.data?.code) === expected;
async function fixture(t) {
  const f = recordsFixture(),
    auth = await f.setup();
  let actor = 'owner';
  f.ctx.auth = { getUserIdentity: async () => ({ subject: actor }) };
  const old = {
    kind: 'job',
    id: randomUUID(),
    version: 0,
    at: '2026-01-01T00:00:00.000Z',
    operationId: randomUUID(),
    jobKind: 'save',
    input: { sha256: 'a'.repeat(64), size: 1 },
    inputDigest: 'a'.repeat(64),
    authorityEpoch: 1,
    attempt: 0,
    fence: 0,
    status: 'pending',
    executionId: null,
    output: null,
  };
  const first = await f.run('old version', () =>
    records.writeHostedRecord(f.ctx, { ...auth, record: old, expectedVersion: null }),
  );
  await f.run('current version', () =>
    records.writeHostedRecord(f.ctx, {
      ...auth,
      record: { ...old, version: 1, status: 'failed' },
      expectedVersion: 0,
    }),
  );
  const request = {
    projectId: auth.projectId,
    request: canonicalPayload({ collection: 'jobs', id: old.id, version: 0 }),
  };
  const before = await reads.read._handler(f.ctx, request);
  const header = f.tables.projectHostedRecords.get(first._id),
    body = f.tables.projectHostedRecordBodies.get(first.bodyId);
  const segment = {
    protocol: 1,
    kind: 'forge-journal-segment',
    projectId: auth.projectId,
    scope: store.journalScope('job', old.id),
    from: 0,
    through: 0,
    tables: {
      projectHostedRecords: [canonicalPayload(header)],
      projectHostedRecordBodies: [canonicalPayload(body)],
    },
  };
  const encoded = encodeArchiveBytes(journalSegmentText(segment), 0, journalTablePins(segment.tables));
  const index = {
    scope: segment.scope,
    from: 0,
    through: 0,
    pointer: encoded.pointer,
    records: [
      [
        0,
        header._id,
        header._creationTime,
        header.bodyId,
        header.parent,
        header.status,
        header.digest,
        header.bytes,
        null,
      ],
    ],
  };
  const relocate = async () => {
    await f.ctx.db.insert('projectFinishReadRows', {
      kind: store.journalIndexKind,
      sourceId: store.journalIndexKey(auth.projectId, index.scope, 0),
      projectId: auth.projectId,
      submissionId: 'segment',
      value: canonicalPayload(index),
    });
    await f.ctx.db.patch(auth.projectId, { journalRevision: 1 });
    await f.ctx.db.delete(first._id);
    await f.ctx.db.delete(first.bodyId);
  };
  const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
  Object.assign(process.env, synthetic);
  t.after(() => {
    for (const [key, value] of Object.entries(prior))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const calls = [],
    gets = [];
  let onGet = () => {},
    corrupt = false;
  t.mock.method(globalThis, 'fetch', async url => {
    gets.push(url);
    onGet();
    const bytes = Buffer.from(encoded.body);
    if (corrupt) bytes[0] ^= 1;
    return new Response(bytes);
  });
  const actionCtx = {
    auth: f.ctx.auth,
    runQuery: async (ref, args) => {
      const name = getFunctionName(ref);
      calls.push(name);
      if (name === 'projectJournalRead:read') return internalReads.read._handler(f.ctx, args);
      if (name === 'publicPeople:resolve') return people.resolve._handler(f.ctx, args);
      assert.fail(name);
    },
  };
  return {
    ...f,
    auth,
    old,
    request,
    before,
    first,
    encoded,
    segment,
    index,
    relocate,
    calls,
    gets,
    query: () => reads.read._handler(f.ctx, request),
    read: () => actions.history._handler(actionCtx, { ...request, query: 'projectHostedRecordReads:read' }),
    actor: value => {
      actor = value;
    },
    onGet: fn => {
      onGet = fn;
    },
    corrupt: () => {
      corrupt = true;
    },
  };
}

test('journal uses the S1 complete-object codec and rejects corrupt bytes, table pins and revision substitution', async t => {
  const h = await fixture(t),
    text = decodeArchiveBytes(h.encoded.body, h.encoded.pointer);
  assert.deepEqual(readJournalSegment(text, h.encoded.pointer, h.auth.projectId, h.index), h.segment);
  assert.throws(
    () => readJournalSegment(text, { ...h.encoded.pointer, tables: '[]' }, h.auth.projectId, h.index),
    code('EVIDENCE_CHANGED'),
  );
  assert.throws(
    () => readJournalSegment(text, h.encoded.pointer, 'different', h.index),
    code('EVIDENCE_CHANGED'),
  );
  assert.throws(
    () => readJournalSegment(text, h.encoded.pointer, h.auth.projectId, { ...h.index, through: 1 }),
    code('EVIDENCE_CHANGED'),
  );
  assert.throws(
    () =>
      decodeArchiveBytes(h.encoded.body, { ...h.encoded.pointer, rawSize: h.encoded.pointer.rawSize - 1 }),
    code('EVIDENCE_CHANGED'),
  );
});

test('exact archived versions match live replies through one server action and GET; current versions and immutable retry stay transactional', async t => {
  const h = await fixture(t);
  await h.relocate();
  assert.deepEqual(JSON.parse(await h.query()), { journalHistory: true });
  assert.equal(await h.read(), h.before);
  assert.equal(h.gets.length, 1);
  assert.equal(h.calls.filter(name => name === 'projectJournalRead:read').length, 2);
  const retry = await h.run('immutable replay', () =>
    records.writeHostedRecord(h.ctx, { ...h.auth, record: h.old, expectedVersion: null }),
  );
  assert.equal(retry.value, canonicalPayload(h.old));
  const current = await records.readHostedRecord(h.ctx, { ...h.auth, kind: 'job', key: h.old.id });
  assert.equal(current.version, 1);
  const reply = await hydrateLandingHistory(
    'projectHostedRecordReads:read',
    h.request,
    await h.query(),
    async (name, args) => {
      assert.equal(name, 'projectJournalActions:history');
      return actions.history._handler(
        { auth: h.ctx.auth, runQuery: (ref, args) => internalReads.read._handler(h.ctx, args) },
        { ...args, projectId: h.auth.projectId },
      );
    },
  );
  assert.equal(reply, h.before);
});

test('journal rechecks access after GET and refuses corruption without leaking its private pin', async t => {
  const h = await fixture(t);
  await h.relocate();
  h.onGet(() => h.actor('stranger'));
  await assert.rejects(h.read(), code('PROJECT_UNAVAILABLE'));
  h.actor('owner');
  h.onGet(() => {});
  h.corrupt();
  await assert.rejects(h.read(), code('EVIDENCE_CHANGED'));
  h.actor('stranger');
  const n = h.gets.length;
  await assert.rejects(h.read(), code('PROJECT_UNAVAILABLE'));
  assert.equal(h.gets.length, n, 'inaccessible projects never fetch an object');
});

test('archived Work events fill contiguous revision pages and retain exact replay bytes with live later revisions', async t => {
  const h = await fixture(t);
  const { metadataRequest } = await import('../dist/work-metadata.js');
  const { readJournalEvents } = await import(moduleUrl('../convex/projectJournalEvents.ts'));
  const work = await import(moduleUrl('../convex/projectWork.ts'));
  const command = { action: 'note', kind: 'comment', intentId: randomUUID(), text: 'Retained rationale' };
  const event = {
    projectId: h.auth.projectId,
    value: '',
    operationId: randomUUID(),
    revision: 1,
    actor: 'owner',
    at: '2026-01-01T00:00:00.000Z',
    request: metadataRequest(command),
    command: canonicalPayload(command),
  };
  const id = await h.ctx.db.insert('projectHostedRecordBodies', event);
  await h.ctx.db.patch(h.auth.projectId, {
    journalRevision: 1,
    workStoreCutoverRevision: 0,
    workStoreEventWindows: [{ revision: 0, storeFirst: true }],
  });
  const input = {
    projectId: h.auth.projectId,
    owner: 'owner',
    initialRevision: 0,
    revision: 1,
    paginationOpts: { cursor: null, numItems: 1 },
  };
  const before = await work.events._handler(h.ctx, input);
  const segment = {
    protocol: 1,
    kind: 'forge-journal-segment',
    projectId: h.auth.projectId,
    scope: 'events',
    from: 1,
    through: 1,
    tables: { projectHostedRecordBodies: [canonicalPayload(h.tables.projectHostedRecordBodies.get(id))] },
  };
  const encoded = encodeArchiveBytes(journalSegmentText(segment), 1, journalTablePins(segment.tables));
  const index = { scope: 'events', from: 1, through: 1, pointer: encoded.pointer };
  await h.ctx.db.insert('projectFinishReadRows', {
    kind: store.journalIndexKind,
    sourceId: store.journalIndexKey(h.auth.projectId, 'events', 1),
    projectId: h.auth.projectId,
    submissionId: 'events-1',
    value: canonicalPayload(index),
  });
  await h.ctx.db.delete(id);
  t.mock.method(globalThis, 'fetch', async () => new Response(encoded.body));
  const ctx = {
    runQuery: (ref, args) =>
      getFunctionName(ref) === 'projectWork:events'
        ? work.events._handler(h.ctx, args)
        : internalReads.read._handler(h.ctx, args),
  };
  assert.deepEqual(await readJournalEvents(ctx, input), before);
  const secondId = await h.ctx.db.insert('projectHostedRecordBodies', {
    ...event,
    operationId: randomUUID(),
    revision: 2,
  });
  const first = await readJournalEvents(ctx, { ...input, revision: 2 });
  assert.equal(first.page[0].revision, 1);
  assert.equal(first.isDone, false);
  const second = await readJournalEvents(ctx, {
    ...input,
    revision: 2,
    paginationOpts: { cursor: first.continueCursor, numItems: 1 },
  });
  assert.equal(second.page[0]._id, secondId);
  assert.equal(second.isDone, true);
});

test('journal recovery continues the S1 merge without duplicate physical rows or lost exact table bytes', async t => {
  const h = await fixture(t);
  await h.relocate();
  const recovery = await import(moduleUrl('../convex/projectJournalRecovery.ts'));
  const project = h.tables.hostedProjects.get(h.auth.projectId);
  const ctx = { ...h.ctx, journalLoaded: [h.segment] };
  const page = JSON.parse(
    await recovery.journalRecoveryPage(ctx, project, 'projectHostedRecords', { cursor: null }),
  );
  assert.deepEqual(page.rows, h.segment.tables.projectHostedRecords);
  assert.equal(page.done, false);
  const { readRecoveryCapsuleCursor } = await import(moduleUrl('../convex/projectLandingCapsuleRecovery.ts'));
  const cursor = readRecoveryCapsuleCursor('projectHostedRecords', page.cursor);
  assert.equal(cursor.phase, 'journal');
  const end = JSON.parse(await recovery.journalRecoveryPage(ctx, project, 'projectHostedRecords', cursor));
  assert.equal(end.done, true);
  assert.deepEqual(end.rows, []);
});
