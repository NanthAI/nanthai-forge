// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { canonicalPayload, hostedPayloadHash } from '../dist/hosted-source-operation.js';
import {
  hostedRecordRef,
  hostedRecordIndex,
  hostedSnapshotPages,
  recordRefOrder,
  snapshotPageBytes,
  HOSTED_RECORD_PAGE_BYTES,
} from '../dist/hosted-records.js';
import { HOSTED_SNAPSHOT_EMPTY_ROOT, hostedSnapshotPageRoot } from '../dist/hosted-snapshot.js';
const store = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const snapshots = await import(moduleUrl('../convex/projectHostedSnapshots.ts'));
const reads = await import(moduleUrl('../convex/projectHostedSnapshotRead.ts'));
const projection = await import(moduleUrl('../convex/projectHostedProjection.ts'));
const operations = await import(moduleUrl('../convex/projectHostedOperations.ts'));
const hash = 'a'.repeat(64),
  nextHash = 'b'.repeat(64),
  object = { sha256: hash, size: 1 };
const at = '2026-01-01T00:00:00.000Z';
const lane = () => ({
  kind: 'lane',
  id: randomUUID(),
  version: 0,
  at,
  intentId: randomUUID(),
  actor: 'owner',
  base: { head: hash, receiptId: 'main-receipt' },
  head: hash,
  sourceVersion: 0,
  lifecycleVersion: 0,
  state: 'active',
  authorityEpoch: 1,
});
const job = () => ({
  kind: 'job',
  id: randomUUID(),
  version: 0,
  at,
  operationId: randomUUID(),
  jobKind: 'save',
  input: object,
  inputDigest: hash,
  authorityEpoch: 1,
  attempt: 0,
  fence: 0,
  status: 'pending',
  executionId: null,
  output: null,
});
const save = (laneId, id = randomUUID()) => ({
  kind: 'save',
  id,
  version: 0,
  at,
  laneId,
  actor: 'owner',
  operationId: randomUUID(),
  expectedHead: hash,
  expectedSourceVersion: 0,
  head: nextHash,
  sourceVersion: 1,
  changes: object,
});
const candidate = () => ({
  kind: 'candidate',
  id: randomUUID(),
  version: 0,
  at,
  intentId: randomUUID(),
  base: { head: hash, receiptId: 'main-receipt' },
  inputs: object,
  dependencies: object,
  algorithm: 'native-v1',
  result: { status: 'clean', head: hash },
});
const code = expected => error => error.code === expected;
async function setup() {
  const s = recordsFixture(),
    auth = await s.setup();
  return {
    ...s,
    auth,
    put: (record, expectedVersion = null) =>
      s.run('record', () => store.writeHostedRecord(s.ctx, { ...auth, record, expectedVersion })),
  };
}
function plan(auth, refs, expectedSnapshotId = null, journalSequence = 1) {
  const pages = [...hostedSnapshotPages(refs)];
  let root = HOSTED_SNAPSHOT_EMPTY_ROOT;
  const batches = pages.map((refs, page) => {
    const previousRoot = root;
    root = hostedSnapshotPageRoot(root, page, refs);
    return { page, previousRoot, refs };
  });
  return {
    input: {
      ...auth,
      operationId: randomUUID(),
      snapshotId: randomUUID(),
      expectedSnapshotId,
      journalSequence,
      seedCheckpoint: object,
      source: { head: hash, receiptId: 'main-receipt' },
      pageCount: pages.length,
      recordCount: refs.length,
      root,
    },
    batches,
  };
}
const selection = p => ({ projectId: p.projectId, actor: p.actor, snapshotId: p.snapshotId });
async function publish(s, p) {
  await s.call('begin', snapshots.begin, p.input);
  for (const page of p.batches) await s.call('stage', snapshots.stage, { ...selection(p.input), ...page });
  return s.call('publish', snapshots.publish, selection(p.input));
}

test('canonical Lane/save/Candidate/job versions have exact indexed identity, sibling/status paging and independent heads', async () => {
  const s = await setup(),
    l = lane(),
    j = job(),
    c = candidate(),
    sv = save(l.id);
  for (const record of [l, j, c, sv]) {
    const first = await s.put(record);
    assert.equal(first.digest, hostedRecordRef(record).digest);
    assert.deepEqual(await s.put(record), first);
    await assert.rejects(
      s.put({ ...record, at: '2026-01-02T00:00:00.000Z' }),
      code('WORK_OPERATION_CHANGED'),
    );
  }
  const firstHead = await store.recordHead(s.ctx, s.auth.projectId, 'lane', l.id);
  const sibling = { ...lane(), intentId: l.intentId };
  await s.put(sibling);
  assert.deepEqual(await store.recordHead(s.ctx, s.auth.projectId, 'lane', l.id), firstHead);
  const updated = { ...l, version: 1, head: nextHash, sourceVersion: 1 };
  await s.put(updated, 0);
  assert.equal(
    JSON.parse((await store.readHostedRecord(s.ctx, { ...s.auth, kind: 'lane', key: l.id })).value).head,
    nextHash,
  );
  await s.put(l); // Old completed write cannot rewind the current head.
  assert.equal((await store.recordHead(s.ctx, s.auth.projectId, 'lane', l.id)).version, 1);
  await assert.rejects(s.put({ ...updated, version: 2 }, 0), code('WORK_STALE'));
  for (const record of [sv, c])
    await assert.rejects(s.put({ ...record, version: 1 }, 0), code('WORK_OPERATION_CHANGED'));
  assert.equal(
    (await store.hostedRecordPage(s.ctx, { ...s.auth, kind: 'lane', parent: l.intentId, cursor: null })).page
      .length,
    2,
  );
  assert.equal(
    (await store.hostedRecordPage(s.ctx, { ...s.auth, kind: 'job', status: 'pending', cursor: null })).page
      .length,
    1,
  );
  assert.equal(
    (await store.hostedRecordPage(s.ctx, { ...s.auth, kind: 'save', parent: l.id, cursor: null })).page
      .length,
    1,
  );
  await s.put({ ...j, version: 1, status: 'running', fence: 1, executionId: 'provider-execution' }, 0);
  assert.equal(
    (await store.hostedRecordPage(s.ctx, { ...s.auth, kind: 'job', status: 'pending', cursor: null })).page
      .length,
    0,
  );
});

test('canonical writes/read/replays enforce current project access, epoch and project identity', async () => {
  const s = await setup(),
    l = lane();
  await s.put(l);
  await assert.rejects(
    store.readHostedRecord(s.ctx, { ...s.auth, actor: 'foreign', kind: 'lane', key: l.id }),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    store.writeHostedRecord(s.ctx, { ...s.auth, actor: 'foreign', record: l, expectedVersion: null }),
    code('PROJECT_UNAVAILABLE'),
  );
  await s.ctx.db.patch(s.auth.projectId, { sourceAuthority: { mode: 'server-shadow', epoch: 2 } });
  await s.put(l); // Original immutable receipt remains reconcilable after fencing changes.
  await assert.rejects(s.put(lane()), code('SOURCE_AUTHORITY_CHANGED'));
  await s.ctx.db.patch(s.auth.projectId, { removal: 'deleted' });
  await assert.rejects(s.put(l), code('PROJECT_UNAVAILABLE'));
});

test('persisted operation envelopes retain original IDs/time and terminal results through lost replies and revoked actors', async () => {
  const s = await setup(),
    operationId = randomUUID(),
    attemptId = randomUUID();
  const expected = { authorityEpoch: 1, head: hash },
    payload = { lane: randomUUID() };
  const input = {
    ...s.auth,
    request: {
      schema: 1,
      projectId: s.auth.projectId,
      actor: s.auth.actor,
      operationId,
      expected,
      payloadHash: hostedPayloadHash(payload, expected),
    },
    payload,
    firstAttempt: {
      projectId: s.auth.projectId,
      operationId,
      id: attemptId,
      parentAttemptId: null,
      at,
      expected,
      ids: { lane: payload.lane },
    },
  };
  const first = await s.run('begin-operation', () => operations.beginHostedOperation(s.ctx, input));
  const replay = await s.run('begin-operation', () =>
    operations.beginHostedOperation(s.ctx, {
      ...input,
      firstAttempt: { ...input.firstAttempt, id: randomUUID() },
    }),
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(first.operation, replay.operation);
  const receipt = { attemptId, at, outcome: { status: 'completed', result: { laneId: payload.lane } } };
  const completed = await s.run('complete-operation', () =>
    operations.finishHostedOperation(s.ctx, { ...s.auth, operationId, receipt }),
  );
  assert.deepEqual(
    await operations.finishHostedOperation(s.ctx, {
      ...s.auth,
      operationId,
      receipt: { ...receipt, outcome: { status: 'failed', error: { code: 'later', message: 'later' } } },
    }),
    completed,
  );
  await assert.rejects(
    operations.beginHostedOperation(s.ctx, { ...input, payload: { lane: randomUUID() } }),
    code('WORK_OPERATION_CHANGED'),
  );
  const foreignProject = await s.ctx.db.insert('hostedProjects', { owner: 'other', visibility: 'private' });
  await assert.rejects(
    operations.beginHostedOperation(s.ctx, { ...input, projectId: foreignProject }),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    operations.beginHostedOperation(s.ctx, { ...input, request: { ...input.request, projectId: 'foreign' } }),
    code('WORK_OPERATION_CHANGED'),
  );
  await s.ctx.db.patch(s.auth.projectId, { removal: 'deleted' });
  await assert.rejects(operations.beginHostedOperation(s.ctx, input), code('PROJECT_UNAVAILABLE'));
});

test('stage 10,050 immutable records, lose a page/final reply, rebuild disposable rows, and select exactly once within read/range/byte budgets', async t => {
  const s = await setup(),
    l = lane();
  await s.put(l);
  const refs = [];
  for (let i = 0; i < 10050; i++) {
    const record = save(l.id, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const ref = hostedRecordRef(record),
      bodyId = await s.ctx.db.insert('projectHostedRecordBodies', {
        projectId: s.auth.projectId,
        value: canonicalPayload(record),
      });
    await s.ctx.db.insert('projectHostedRecords', {
      projectId: s.auth.projectId,
      kind: ref.kind,
      key: ref.key,
      version: ref.version,
      ...hostedRecordIndex(record),
      digest: ref.digest,
      bytes: ref.bytes,
      bodyId,
    });
    refs.push(ref);
  }
  refs.sort((a, b) => recordRefOrder(a).localeCompare(recordRefOrder(b)));
  const p = plan(s.auth, refs),
    selected = selection(p.input);
  const truth = canonicalPayload([...s.tables.projectHostedRecords.values()]);
  const sourceHeads = canonicalPayload([...s.tables.projectHostedRecordHeads.values()]);
  const first = await s.call('begin', snapshots.begin, p.input);
  assert.deepEqual(await s.call('begin-replay', snapshots.begin, p.input), first);
  await assert.rejects(s.call('premature-publish', snapshots.publish, selected), code('WORK_STALE'));
  for (const [i, page] of p.batches.entries()) {
    let result;
    const stagePage = async () => {
      result = await s.call('stage', snapshots.stage, { ...selected, ...page });
    };
    if (i === 50)
      await assert.rejects(async () => {
        await stagePage();
        throw Error('lost page reply');
      }, /lost page reply/);
    else await stagePage();
    assert.equal(s.tables.projectHostedSnapshotHeads.size, 0, 'private pages never become current');
    if (i === 50) {
      // The transaction committed but the caller did not receive its reply.
      const pagesBefore = s.tables.projectHostedSnapshotPages.size;
      assert.deepEqual(await s.call('lost-page-replay', snapshots.stage, { ...selected, ...page }), result);
      assert.equal(s.tables.projectHostedSnapshotPages.size, pagesBefore);
      assert.equal(s.counts.at(-1).writes, 0);
    }
  }
  assert.equal(s.tables.projectHostedRecords.size, 10051, 'staging never clones canonical history');
  let receipt;
  await assert.rejects(async () => {
    receipt = await s.call('publish', snapshots.publish, selected);
    throw Error('lost final reply');
  }, /lost final reply/);
  assert.equal(receipt.status, 'published');
  const pointer = structuredClone([...s.tables.projectHostedSnapshotHeads.values()][0]);
  assert.deepEqual(await s.call('lost-publish-replay', snapshots.publish, selected), receipt);
  assert.deepEqual([...s.tables.projectHostedSnapshotHeads.values()][0], pointer);
  assert.equal(s.counts.at(-1).writes, 0);
  assert(s.counts.filter(c => c.name === 'publish').every(c => c.documents < 10));
  const current = await s.call('read-current', reads.current, s.auth);
  assert.equal(current.snapshotId, p.input.snapshotId);
  let count = 0;
  for (let page = 0; page < p.input.pageCount; page++) {
    const output = await s.call('read-page', reads.page, { ...selected, page });
    assert.equal(output.refs.length, p.batches[page].refs.length);
    count += output.refs.length;
    await s.call('rebuild-page', projection.rebuildPage, { ...selected, page, operationId: randomUUID() });
  }
  assert.equal(count, 10050);
  assert.equal(s.tables.projectHostedDisplayRecords.size, 10050);
  const damaged = [...s.tables.projectHostedDisplayRecords.values()].find(row => row.key === refs[0].key);
  await s.ctx.db.patch(damaged._id, { value: '{"display":"corrupted"}' });
  await s.call('rebuild-again', projection.rebuildPage, { ...selected, page: 0, operationId: randomUUID() });
  const repaired = [...s.tables.projectHostedDisplayRecords.values()].find(row => row.key === refs[0].key);
  assert.notEqual(repaired.value, '{"display":"corrupted"}');
  assert.equal(canonicalPayload([...s.tables.projectHostedRecords.values()]), truth);
  assert.equal(canonicalPayload([...s.tables.projectHostedRecordHeads.values()]), sourceHeads);
  assert.deepEqual([...s.tables.projectHostedSnapshotHeads.values()][0], pointer);
  const totals = Object.fromEntries(
    ['ranges', 'documents', 'readBytes', 'writes', 'writeBytes'].map(key => [
      key,
      Math.max(...s.counts.map(c => c[key])),
    ]),
  );
  t.diagnostic(
    JSON.stringify({
      records: count,
      pages: p.input.pageCount,
      calls: s.counts.length,
      maxima: totals,
      final: s.counts.find(c => c.name === 'publish'),
    }),
  );
});

test('snapshot plans/pages are immutable, ordered, project-bound, and fenced; completed retry cannot rewind a newer selection', async () => {
  const s = await setup(),
    a = lane(),
    b = lane();
  await s.put(a);
  await s.put(b);
  const refs = [a, b].map(hostedRecordRef).sort((a, b) => recordRefOrder(a).localeCompare(recordRefOrder(b)));
  const p = plan(s.auth, refs),
    selected = selection(p.input);
  await s.call('begin', snapshots.begin, p.input);
  await assert.rejects(
    s.call('changed-plan', snapshots.begin, { ...p.input, source: { head: nextHash, receiptId: 'other' } }),
    code('WORK_OPERATION_CHANGED'),
  );
  await assert.rejects(
    s.call('reversed-page', snapshots.stage, { ...selected, ...p.batches[0], refs: refs.toReversed() }),
    code('WORK_OPERATION_CHANGED'),
  );
  await assert.rejects(
    s.call('forged-byte-pin', snapshots.stage, {
      ...selected,
      ...p.batches[0],
      refs: [{ ...refs[0], bytes: 1 }],
    }),
    code('SOURCE_UNAVAILABLE'),
  );
  await assert.rejects(
    s.call('missing-record', snapshots.stage, {
      ...selected,
      ...p.batches[0],
      refs: [{ ...refs[0], key: randomUUID() }],
    }),
    code('SOURCE_UNAVAILABLE'),
  );
  await s.call('stage', snapshots.stage, { ...selected, ...p.batches[0] });
  await assert.rejects(
    s.call('changed-page', snapshots.stage, {
      ...selected,
      ...p.batches[0],
      refs: [{ ...refs[0], digest: nextHash }],
    }),
    code('WORK_OPERATION_CHANGED'),
  );
  const first = await s.call('publish', snapshots.publish, selected);
  const next = plan(s.auth, [], p.input.snapshotId, 2);
  await publish(s, next);
  assert.deepEqual(await s.call('publish-replay', snapshots.publish, selected), first);
  assert.equal((await reads.current._handler(s.ctx, s.auth)).snapshotId, next.input.snapshotId);
  assert.equal((await reads.page._handler(s.ctx, { ...selected, page: 0 })).refs.length, 2);
  const third = plan(s.auth, [], next.input.snapshotId, 3);
  await s.call('begin', snapshots.begin, third.input);
  await s.ctx.db.patch(s.auth.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(
    s.call('fenced-publish', snapshots.publish, selection(third.input)),
    code('SOURCE_AUTHORITY_CHANGED'),
  );
  assert.deepEqual(await s.call('completed-after-epoch', snapshots.publish, selected), first);
  await s.ctx.db.patch(s.auth.projectId, { removal: 'deleted' });
  await assert.rejects(s.call('revoked-retry', snapshots.publish, selected), code('PROJECT_UNAVAILABLE'));
});

test('snapshot final CAS rejects competing selection and all read paths recheck project access', async () => {
  const s = await setup(),
    p = plan(s.auth, []),
    competing = plan(s.auth, []);
  await s.call('begin', snapshots.begin, p.input);
  await s.call('begin-competing', snapshots.begin, competing.input);
  await s.call('publish', snapshots.publish, selection(competing.input));
  await assert.rejects(s.call('stale-final', snapshots.publish, selection(p.input)), code('WORK_STALE'));
  assert.equal([...s.tables.projectHostedSnapshotHeads.values()][0].key, competing.input.snapshotId);
  for (const [fn, args] of [
    [reads.current, s.auth],
    [reads.page, { ...selection(competing.input), page: 0 }],
    [snapshots.publish, selection(competing.input)],
    [projection.rebuildPage, { ...selection(competing.input), page: 0, operationId: randomUUID() }],
  ]) {
    await assert.rejects(fn._handler(s.ctx, { ...args, actor: 'foreign' }), code('PROJECT_UNAVAILABLE'));
  }
});

test('metadata windows adapt to encoded record bytes as well as rows, with a larger single metadata record remaining usable', async () => {
  const s = await setup(),
    records = [job(), job(), job(), job()].map((record, i) => ({
      ...record,
      executionId: 'x'.repeat(i === 3 ? 180000 : 60000),
    }));
  const refs = [];
  for (const record of records) {
    await s.put(record);
    refs.push(hostedRecordRef(record));
  }
  refs.sort((a, b) => recordRefOrder(a).localeCompare(recordRefOrder(b)));
  const p = plan(s.auth, refs);
  assert(p.batches.length >= 3);
  for (const page of p.batches)
    assert(snapshotPageBytes(page.refs) <= HOSTED_RECORD_PAGE_BYTES || page.refs.length === 1);
  await publish(s, p);
  assert.equal([...s.tables.projectHostedRecords.values()].length, 4);
});

test('snapshot references cannot cross projects or substitute a different seed/root, and a forged byte count never loads the large body', async () => {
  const s = await setup(),
    record = { ...job(), executionId: 'x'.repeat(300000) };
  await s.put(record);
  const ref = hostedRecordRef(record),
    forged = plan(s.auth, [{ ...ref, bytes: 1 }]);
  await s.call('begin', snapshots.begin, forged.input);
  await assert.rejects(
    s.call('forged-large-body', snapshots.stage, { ...selection(forged.input), ...forged.batches[0] }),
    code('SOURCE_UNAVAILABLE'),
  );
  assert(s.counts.at(-1).readBytes < 10000, 'staging reads only the small canonical header');
  const projectId = await s.ctx.db.insert('hostedProjects', {
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server-shadow', epoch: 1 },
  });
  const other = plan({ ...s.auth, projectId }, [ref]);
  await s.call('begin-other', snapshots.begin, other.input);
  await assert.rejects(
    s.call('foreign-reference', snapshots.stage, { ...selection(other.input), ...other.batches[0] }),
    code('SOURCE_UNAVAILABLE'),
  );
  const broken = plan(s.auth, [ref]);
  broken.input.root = nextHash;
  await s.call('begin-broken-root', snapshots.begin, broken.input);
  await s.call('stage-broken-root', snapshots.stage, { ...selection(broken.input), ...broken.batches[0] });
  await assert.rejects(
    s.call('broken-root-publish', snapshots.publish, selection(broken.input)),
    code('WORK_STALE'),
  );
  const valid = plan(s.auth, [ref]);
  await publish(s, valid);
  const changedSeed = plan(s.auth, [], valid.input.snapshotId, 2);
  changedSeed.input.seedCheckpoint = { sha256: nextHash, size: 1 };
  await assert.rejects(
    s.call('changed-seed', snapshots.begin, changedSeed.input),
    code('WORK_OPERATION_CHANGED'),
  );
});
