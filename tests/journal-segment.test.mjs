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
import { hydrateLandingHistory, hasJournalHistory } from '../dist/landing-capsule-client.js';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const reads = await import(moduleUrl('../convex/projectHostedRecordReads.ts'));
const store = await import(moduleUrl('../convex/projectJournalStore.ts'));
const internalReads = await import(moduleUrl('../convex/projectJournalRead.ts'));
const actions = await import(moduleUrl('../convex/projectJournalActions.ts'));
const people = await import(moduleUrl('../convex/publicPeople.ts'));
const code = expected => error => (error.code ?? error.data?.code) === expected;
async function fixture(t, { inline = false, lane = false } = {}) {
  const f = recordsFixture(),
    auth = await f.setup();
  let actor = 'owner';
  f.ctx.auth = { getUserIdentity: async () => ({ subject: actor }) };
  const old = lane
    ? {
        kind: 'lane',
        id: randomUUID(),
        version: 0,
        at: '2026-01-01T00:00:00.000Z',
        intentId: randomUUID(),
        actor: 'owner',
        base: { head: 'a'.repeat(64), receiptId: 'receipt' },
        head: 'a'.repeat(64),
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: 'active',
        authorityEpoch: 1,
      }
    : {
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
      record: lane
        ? { ...old, version: 1, lifecycleVersion: 1, state: 'completed' }
        : { ...old, version: 1, status: 'failed' },
      expectedVersion: 0,
    }),
  );
  if (inline) {
    await f.ctx.db.patch(first._id, { inline: first.value });
    await f.ctx.db.patch(first.bodyId, { value: '' });
  }
  const request = {
    projectId: auth.projectId,
    request: canonicalPayload({ collection: lane ? 'lanes' : 'jobs', id: old.id, version: 0 }),
  };
  const before = await reads.read._handler(f.ctx, request);
  const header = f.tables.projectHostedRecords.get(first._id),
    body = f.tables.projectHostedRecordBodies.get(first.bodyId);
  const segment = {
    protocol: 1,
    kind: 'forge-journal-segment',
    projectId: auth.projectId,
    scope: store.journalScope(old.kind, old.id),
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
        ...(lane ? [[old.head, old.sourceVersion, old.lifecycleVersion]] : []),
      ],
    ],
  };
  const relocate = async ({ receipts = false } = {}) => {
    await f.ctx.db.insert('projectJournalSegments', {
      scope: index.scope,
      from: index.from,
      through: index.through,
      category: 'record',
      recordKind: old.kind,
      firstPosition: `${auth.projectId}:${header._creationTime.toFixed(6).padStart(23, '0')}:${header._id}`,
      lastPosition: `${auth.projectId}:${header._creationTime.toFixed(6).padStart(23, '0')}:${header._id}`,
      key: store.journalIndexKey(auth.projectId, index.scope, 0),
      projectId: auth.projectId,
      value: canonicalPayload(
        receipts ? Object.fromEntries(Object.entries(index).filter(([key]) => key !== 'records')) : index,
      ),
    });
    await f.ctx.db.patch(auth.projectId, {
      journalRevision: 1,
      ...(receipts ? { journalRecordReceipts: true } : {}),
    });
    store.journalProject(f.ctx, await f.ctx.db.get(auth.projectId));
    if (receipts)
      await f.ctx.db.patch(first._id, {
        inline: undefined,
        journalSegment: encoded.pointer.sha256,
        ...(lane
          ? {
              journalLane: {
                head: old.head,
                sourceVersion: old.sourceVersion,
                lifecycleVersion: old.lifecycleVersion,
                revert: false,
              },
            }
          : {}),
      });
    else await f.ctx.db.delete(first._id);
    if (!inline) await f.ctx.db.delete(first.bodyId);
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
    query: async () => {
      try {
        return await reads.read._handler(f.ctx, request);
      } catch (error) {
        if (hasJournalHistory(error)) return canonicalPayload(error.data);
        throw error;
      }
    },
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
  assert.equal(JSON.parse(await h.query()).journalHistory, true);
  assert.match(JSON.parse(await h.query()).viewVersion, /^[a-f0-9]{64}$/);
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
  await h.ctx.db.insert('projectJournalSegments', {
    scope: 'events',
    from: 1,
    through: 1,
    category: 'events',
    key: store.journalIndexKey(h.auth.projectId, 'events', 1),
    projectId: h.auth.projectId,
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

test('archived inline record values hydrate while the empty provenance body remains live', async t => {
  const h = await fixture(t, { inline: true });
  await h.relocate();
  assert(h.tables.projectHostedRecordBodies.has(h.first.bodyId));
  assert.equal(JSON.parse(await h.query()).journalHistory, true);
  assert.equal(await h.read(), h.before);
});

test('a narrow finish projection cannot hide an existing journal; cold markers change when a public writer loses their role', async t => {
  const h = await fixture(t);
  await h.relocate();
  store.journalProject(h.ctx, { _id: h.auth.projectId, owner: 'owner', visibility: 'private' });
  assert(await store.journalRecord(h.ctx, h.auth.projectId, 'job', h.old.id, 0));
  await h.ctx.db.patch(h.auth.projectId, { visibility: 'public' });
  h.actor('reader');
  const grant = await h.ctx.db.insert('projectContributors', {
    projectId: h.auth.projectId,
    contributor: 'reader',
  });
  const writer = JSON.parse(await h.query());
  await h.ctx.db.delete(grant);
  const reader = JSON.parse(await h.query());
  assert.notEqual(writer.viewVersion, reader.viewVersion);
  assert.equal(writer.journalHistory, true);
  assert.equal(reader.journalHistory, true);
  assert.equal(h.gets.length, 0, 'reactive markers never open R2 on the query path');
});

test('version pages include a single archived version zero and continue in both directions', async t => {
  const h = await fixture(t);
  await h.relocate();
  const { journalRecordPage } = await import(moduleUrl('../convex/projectJournalRecordPage.ts'));
  const ctx = { ...h.ctx, journalLoaded: [h.segment] },
    input = { projectId: h.auth.projectId, kind: 'job', key: h.old.id, through: 1, cursor: null, limit: 1 };
  const first = await journalRecordPage(ctx, input);
  assert.deepEqual(
    first.page.map(row => row.version),
    [0],
  );
  assert.equal(first.isDone, false);
  const second = await journalRecordPage(ctx, { ...input, cursor: first.continueCursor });
  assert.deepEqual(
    second.page.map(row => row.version),
    [1],
  );
  assert.equal(second.isDone, true);
  const latest = await journalRecordPage(ctx, { ...input, newestFirst: true });
  assert.deepEqual(
    latest.page.map(row => row.version),
    [1],
  );
  assert.equal(latest.isDone, false);
  const older = await journalRecordPage(ctx, { ...input, newestFirst: true, cursor: latest.continueCursor });
  assert.deepEqual(
    older.page.map(row => row.version),
    [0],
  );
  assert.equal(older.isDone, true);
});

test('an included Lane retains its exact transaction source pins after its full old body moves', async t => {
  const h = await fixture(t, { lane: true });
  await h.relocate();
  await h.query();
  const descriptor = await records.recordVersion(h.ctx, h.auth.projectId, 'lane', h.old.id, 0);
  assert(descriptor);
  assert.equal(await h.ctx.db.get(h.first.bodyId), null);
  const pins = store.journalLaneSourcePins(descriptor);
  assert.deepEqual(pins, { head: h.old.head, version: 0, sourceVersion: 0, lifecycleVersion: 0 });
  const { sameSaveLane } = await import(moduleUrl('../convex/projectHostedSaveStore.ts'));
  assert(sameSaveLane(pins, { head: h.old.head, version: 0, sourceVersion: 0, lifecycleVersion: 0 }));
  assert(!sameSaveLane(pins, { head: h.old.head, version: 0, sourceVersion: 1, lifecycleVersion: 0 }));
  assert.equal(h.gets.length, 0, 'transactional validation never opens an R2 segment');
});

test('Lane metrics retain superseded version facts without R2 or full old bodies', async t => {
  const h = await fixture(t, { lane: true });
  await h.relocate();
  await h.query();
  const { journalLaneMetricsPage } = await import(moduleUrl('../convex/projectJournalLaneMetrics.ts'));
  const page = await journalLaneMetricsPage(h.ctx, h.auth.projectId, 0, Date.now() + 1000, null);
  assert.deepEqual(
    page.page.map(row => row.version),
    [1, 0],
  );
  assert(
    page.page.every(row => row.id === h.old.id && row.intentId === h.old.intentId && row.revert === false),
  );
  assert.equal(h.gets.length, 0);
  assert.equal(page.isDone, true);
});

test('archived Work receipts reconcile the original command in a mutation without R2 and reject changed content', async t => {
  const h = await fixture(t);
  const { metadataRequest } = await import('../dist/work-metadata.js');
  const events = await import(moduleUrl('../convex/projectWorkEventStore.ts'));
  const command = { action: 'intent', outcome: 'Original outcome', constraints: '', base: 'a'.repeat(64) };
  const text = JSON.stringify(command),
    request = metadataRequest(command),
    operationId = randomUUID();
  const id = await h.ctx.db.insert('projectHostedRecordBodies', {
    projectId: h.auth.projectId,
    value: '',
    operationId,
    revision: 1,
    request,
    actor: 'owner',
    at: '2026-01-01T00:00:00.000Z',
    journalSegment: 'verified',
    journalCommand: JSON.stringify({ action: 'intent', base: command.base }),
  });
  const replay = await events.findWorkEvent(h.ctx, h.auth.projectId, operationId, { command: text });
  assert.equal(replay.command, text);
  assert.equal(replay._id, id);
  assert.equal(replay.previousRevision, 0);
  assert.equal(h.gets.length, 0);
  await assert.rejects(
    events.findWorkEvent(h.ctx, h.auth.projectId, operationId, {
      command: JSON.stringify({ ...command, outcome: 'Different' }),
    }),
    code('WORK_OPERATION_CHANGED'),
  );
  const authority = await events.findWorkEvent(h.ctx, h.auth.projectId, operationId, { authority: true });
  assert.deepEqual(JSON.parse(authority.command), { action: 'intent', base: command.base });
});

test('a snapshot display rebuild resolves exact archived versions before writing and rechecks access after GET', async t => {
  const h = await fixture(t),
    snapshots = await import(moduleUrl('../convex/projectHostedSnapshots.ts'));
  const projection = await import(moduleUrl('../convex/projectHostedProjection.ts')),
    cold = await import(moduleUrl('../convex/projectJournalProjection.ts'));
  const { HOSTED_SNAPSHOT_EMPTY_ROOT, hostedSnapshotPageRoot } = await import('../dist/hosted-snapshot.js');
  const refs = [{ kind: 'job', key: h.old.id, version: 0, digest: h.first.digest, bytes: h.first.bytes }],
    root = hostedSnapshotPageRoot(HOSTED_SNAPSHOT_EMPTY_ROOT, 0, refs);
  const input = {
    ...h.auth,
    operationId: randomUUID(),
    snapshotId: randomUUID(),
    expectedSnapshotId: null,
    journalSequence: 1,
    seedCheckpoint: { sha256: 'a'.repeat(64), size: 1 },
    source: { head: 'a'.repeat(64), receiptId: 'main' },
    pageCount: 1,
    recordCount: 1,
    root,
  };
  const selection = { projectId: h.auth.projectId, actor: h.auth.actor, snapshotId: input.snapshotId };
  await snapshots.begin._handler(h.ctx, input);
  await snapshots.stage._handler(h.ctx, {
    ...selection,
    page: 0,
    previousRoot: HOSTED_SNAPSHOT_EMPTY_ROOT,
    refs,
  });
  await snapshots.publish._handler(h.ctx, selection);
  const request = { ...selection, page: 0, operationId: randomUUID() };
  assert.equal(await projection.rebuildPage._handler(h.ctx, request), 1);
  const before = [...h.tables.projectHostedDisplayRecords.values()].map(row => row.value);
  await h.relocate();
  for (const id of [...h.tables.projectHostedDisplayRecords.keys()]) await h.ctx.db.delete(id);
  const ctx = {
    runMutation: async (ref, args) => {
      assert.equal(getFunctionName(ref), 'projectHostedProjection:rebuildPage');
      return h.run('rebuild', () => projection.rebuildPage._handler(h.ctx, args));
    },
  };
  assert.equal(await cold.rebuildPage._handler(ctx, request), 1);
  assert.deepEqual(
    [...h.tables.projectHostedDisplayRecords.values()].map(row => row.value),
    before,
  );
  assert.equal(h.gets.length, 1);
  for (const id of [...h.tables.projectHostedDisplayRecords.keys()]) await h.ctx.db.delete(id);
  h.onGet(() => {
    h.tables.hostedProjects.get(h.auth.projectId).owner = 'different-owner';
  });
  await assert.rejects(cold.rebuildPage._handler(ctx, request), code('PROJECT_UNAVAILABLE'));
  assert.equal(h.tables.projectHostedDisplayRecords.size, 0);
});

test('a mounted cold Lane history marker changes with a new current version while the archived first version stays identical', async t => {
  const h = await fixture(t, { lane: true });
  await h.relocate();
  const history = await import(moduleUrl('../convex/projectHostedLaneHistory.ts'));
  const args = { projectId: h.auth.projectId, laneId: h.old.id };
  const observe = async () => {
    try {
      return JSON.parse(await history.read._handler(h.ctx, args));
    } catch (error) {
      if (hasJournalHistory(error)) return error.data;
      throw error;
    }
  };
  const before = await observe();
  assert(before.journalHistory);
  await records.writeHostedRecord(h.ctx, {
    ...h.auth,
    expectedVersion: 1,
    record: { ...h.old, version: 2, lifecycleVersion: 2, state: 'completed' },
  });
  const after = await observe();
  assert(after.journalHistory);
  assert.notEqual(after.viewVersion, before.viewVersion);
  assert.equal(h.gets.length, 0);
});

test('unsupported clients get a structured upgrade before archived history can look like an empty successful reply', async t => {
  const h = await fixture(t);
  await h.relocate();
  await assert.rejects(
    reads.read._handler(h.ctx, h.request),
    error =>
      error.data?.code === 'CLI_UPGRADE_REQUIRED' &&
      error.data.journalHistory === true &&
      !('index' in error.data),
  );
  assert.equal(h.gets.length, 0);
});

test('compact version receipts preserve exact reads, source pins and complete metrics without one archive index per version', async t => {
  const h = await fixture(t, { lane: true });
  await h.relocate({ receipts: true });
  assert(h.tables.projectHostedRecords.has(h.first._id));
  assert.equal(await h.ctx.db.get(h.first.bodyId), null);
  assert.deepEqual(JSON.parse(await h.read()), JSON.parse(h.before));
  const row = await records.recordVersion(h.ctx, h.auth.projectId, 'lane', h.old.id, 0);
  assert.equal(store.journalLaneSourcePins(row).head, h.old.head);
  const { journalLaneMetricsPage } = await import(moduleUrl('../convex/projectJournalLaneMetrics.ts'));
  const gets = h.gets.length,
    page = await journalLaneMetricsPage(h.ctx, h.auth.projectId, 0, Date.now() + 1000, null, true);
  assert.deepEqual(
    page.page.map(row => row.version),
    [1, 0],
  );
  assert.equal(h.gets.length, gets);
  const { journalSourceRow } = await import(moduleUrl('../convex/projectJournalCanonical.ts'));
  assert(!('journalLane' in journalSourceRow(row)));
});
