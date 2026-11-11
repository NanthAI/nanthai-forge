// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { journalMaintenanceFixture } from './journal-maintenance-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { JOURNAL_TABLES } from '../dist/journal-segment.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { expandOperationReceipt } from '../dist/compact-operation-receipt.js';
const objects = await import(moduleUrl('../convex/projectJournalObject.ts'));
const canonical = await import(moduleUrl('../convex/projectJournalCanonical.ts'));
const snapshot = f =>
  Object.fromEntries(
    JOURNAL_TABLES.map(table => [
      table,
      [...f.tables[table].values()].map(row => canonicalPayload(canonical.journalSourceRow(row))).sort(),
    ]),
  );
async function restored(w) {
  const data = Object.fromEntries(
    JOURNAL_TABLES.map(table => [
      table,
      [...w.f.tables[table].values()]
        .filter(row => !row.journalSegment)
        .map(row => canonicalPayload(canonical.journalSourceRow(row))),
    ]),
  );
  for (const row of w.f.tables.projectJournalSegments.values()) {
    if (row.category === 'fragment') continue;
    const segment = await objects.getJournalSegment(w.f.projectId, JSON.parse(row.value));
    for (const table of JOURNAL_TABLES) data[table].push(...(segment.tables[table] ?? []));
  }
  return Object.fromEntries(Object.entries(data).map(([table, rows]) => [table, rows.sort()]));
}
test('existing settled history relocates without changing current heads, source rows or complete retry outcomes', async t => {
  const w = await journalMaintenanceFixture(t),
    before = snapshot(w.f),
    heads = structuredClone(w.f.tables.projectHostedRecordHeads);
  const operations = [...w.f.tables.projectHostedOperations.values()].filter(
    row => JSON.parse(row.value).terminal,
  );
  const results = await w.drain();
  assert.deepEqual(w.f.tables.projectHostedRecordHeads, heads);
  assert.deepEqual(
    await restored(w),
    before,
    'portable rows are complete, with no duplicates or archive hints',
  );
  for (const original of operations)
    assert.deepEqual(
      expandOperationReceipt(w.f.tables.projectHostedOperations.get(original._id)),
      JSON.parse(original.value),
    );
  assert(results.every(result => result.metrics.mutations <= 2));
  assert.equal(w.requests.filter(method => method === 'PUT').length, w.objects.size);
  assert([...w.f.tables.projectHostedRecords.values()].some(row => row.journalSegment));
  assert([...w.f.tables.projectHostedOperations.values()].some(row => row.journalSegment));
  assert(
    [...w.f.tables.projectHostedRecordHeads.values()].every(
      row => !w.f.tables.projectHostedRecords.get(row.recordId).journalSegment,
    ),
  );
  t.diagnostic(
    JSON.stringify({
      pages: results.length,
      objects: w.objects.size,
      puts: w.requests.filter(method => method === 'PUT').length,
      gets: w.requests.filter(method => method === 'GET').length,
      maxRss: Math.max(...results.map(result => result.metrics.sampledRss)),
      wallMs: results.reduce((n, result) => n + result.metrics.wallMs, 0),
    }),
  );
});
test('disabled writer makes no Convex or R2 call', async t => {
  const w = await journalMaintenanceFixture(t);
  delete process.env.FORGE_JOURNAL_SEGMENTS;
  assert.equal((await w.pack()).kept, 'disabled');
  assert.equal(w.calls.length, 0);
  assert.equal(w.requests.length, 0);
});
test('lost publication response replays the same page without another PUT or changed source', async t => {
  const w = await journalMaintenanceFixture(t),
    before = snapshot(w.f);
  w.losePublish();
  await assert.rejects(w.pack(), /lost published/);
  const puts = w.requests.filter(method => method === 'PUT').length;
  await w.pack();
  assert.equal(w.requests.filter(method => method === 'PUT').length, puts);
  await w.drain();
  assert.deepEqual(await restored(w), before);
});
test('lost PUT and corrupt verified object leave original rows intact until a resumable claim publishes', async t => {
  const w = await journalMaintenanceFixture(t),
    before = snapshot(w.f);
  w.losePut();
  await assert.rejects(w.pack());
  assert.deepEqual(snapshot(w.f), before);
  w.release();
  await w.drain();
  assert.deepEqual(await restored(w), before);
  const other = await journalMaintenanceFixture(t);
  const original = snapshot(other.f);
  other.corrupt();
  await assert.rejects(other.pack());
  assert.deepEqual(snapshot(other.f), original);
});
test('coordination moves only aged detail and preserves dedup receipts, messages, handoffs and acknowledgements', async t => {
  const w = await journalMaintenanceFixture(t, { advance: false });
  const events = [];
  for (const kind of ['activity', 'change', 'claim', 'release', 'message', 'handoff', 'ack']) {
    const command =
      kind === 'activity'
        ? {
            kind,
            sessionId: 'session',
            sequence: 1,
            name: 'test',
            environment: 'test',
            status: 'working',
            summary: 'old',
            context: {},
          }
        : kind === 'change'
          ? { kind, source: 'work' }
          : kind === 'claim'
            ? { kind, sessionId: 'session', paths: ['a.txt'], ttlSeconds: 60 }
            : kind === 'release'
              ? { kind, sessionId: 'session', claimId: 'claim' }
              : kind === 'message'
                ? { kind, text: 'retained', context: {} }
                : kind === 'handoff'
                  ? { kind, sessionId: 'session', to: 'owner', summary: 'retained', head: 'a'.repeat(64) }
                  : { kind, sessionId: 'session', messageId: 'message', text: 'ack' };
    const id = await w.insert('projectCoordinationEvents', {
      projectId: w.f.projectId,
      actor: 'owner',
      operationId: randomUUID(),
      at: Date.now(),
      command,
    });
    events.push({ id, kind });
  }
  w.f.advanceClock(15 * 86_400_000);
  const fresh = await w.insert('projectCoordinationEvents', {
    projectId: w.f.projectId,
    actor: 'owner',
    operationId: randomUUID(),
    at: Date.now(),
    command: { kind: 'change', source: 'work' },
  });
  await w.drain({ ...w.input, phase: 4 });
  for (const event of events)
    assert.equal(
      w.f.tables.projectCoordinationEvents.has(event.id),
      ['message', 'handoff', 'ack'].includes(event.kind),
    );
  assert(w.f.tables.projectCoordinationEvents.has(fresh));
});

test('oversized original body is framed into bounded pages and becomes visible only after the final verified part', async t => {
  const w = await journalMaintenanceFixture(t);
  const headIds = new Set([...w.f.tables.projectHostedRecordHeads.values()].map(row => row.recordId));
  const row = [...w.f.tables.projectHostedRecords.values()].find(
    row => row.kind === 'lane' && !headIds.has(row._id),
  );
  assert(row);
  const body = w.f.tables.projectHostedRecordBodies.get(row.bodyId);
  const value = JSON.stringify({ ...JSON.parse(body.value), reason: '𐐷漢字\\"'.repeat(45000) });
  await w.mutate(ctx => ctx.db.patch(body._id, { value }));
  const before = snapshot(w.f);
  const results = [await w.pack()];
  const publish = await import(moduleUrl('../convex/projectJournalPublish.ts'));
  let checked = false;
  while (w.queue.length) {
    results.push(await w.pack(w.queue.shift()));
    const capture = JSON.parse(w.transcript.at(-2).value);
    if (capture.fragmented && !checked) {
      const step = w.transcript.at(-1),
        count = w.objects.size;
      const replay = JSON.parse(await w.f.c.transaction('journalFragmentReplay', publish.page, step.args));
      assert.equal(replay.archived, 0);
      assert(replay.next);
      assert.equal(w.objects.size, count);
      checked = true;
    }
  }
  assert(checked, 'an intermediate fragment publication was replayed after its response');
  const fragments = [...w.f.tables.projectJournalSegments.values()].filter(
    row => row.category === 'fragment',
  );
  assert(fragments.length > 0);
  assert.deepEqual(await restored(w), before);
  for (const step of w.transcript.filter(step => step.name.endsWith('Capture:page'))) {
    assert(
      Buffer.byteLength(step.value) <= 500 * 1024,
      'complete capture transport stays within its byte page',
    );
    const captured = JSON.parse(step.value);
    for (const text of captured.texts ?? []) {
      const rows = Object.values(JSON.parse(text).tables).flat();
      assert(rows.length <= 100);
      assert(rows.reduce((n, row) => n + Buffer.byteLength(row), 0) <= 500 * 1024);
    }
  }
  assert(results.every(result => result.metrics.mutations <= 2));
});
test('a shared current body stays live while superseded immutable headers move', async t => {
  const w = await journalMaintenanceFixture(t);
  const head = [...w.f.tables.projectHostedRecordHeads.values()].find(head => head.kind === 'lane');
  const current = w.f.tables.projectHostedRecords.get(head.recordId);
  const old = [...w.f.tables.projectHostedRecords.values()].find(
    row => row.kind === current.kind && row.key === current.key && row._id !== current._id,
  );
  await w.mutate(ctx => ctx.db.patch(old._id, { bodyId: current.bodyId }));
  const before = snapshot(w.f);
  await w.drain();
  assert(w.f.tables.projectHostedRecordBodies.has(current.bodyId));
  assert.deepEqual(await restored(w), before);
});
test('expired operations retain latest archived ownership and an updated recovery ledger exactly once', async t => {
  const w = await journalMaintenanceFixture(t);
  await w.drain();
  const row = [...w.f.tables.projectHostedOperations.values()].find(row => row.journalSegment);
  const ledger = JSON.stringify({ stage: 'done', evidence: 'late ledger' });
  const wake = await import(moduleUrl('../convex/projectJournalWake.ts'));
  const beforeRevision = w.f.tables.hostedProjects.get(w.f.projectId).journalRevision;
  await w.mutate(ctx => wake.retainJournalRecovery(ctx, row, ledger));
  assert.equal(
    w.f.tables.hostedProjects.get(w.f.projectId).journalRevision,
    beforeRevision + 1,
    'an in-flight export cannot cross a changed archived ledger',
  );
  await w.mutate(ctx =>
    wake.retainJournalRecovery(ctx, w.f.tables.projectHostedOperations.get(row._id), ledger),
  );
  assert.equal(
    w.f.tables.hostedProjects.get(w.f.projectId).journalRevision,
    beforeRevision + 1,
    'identical retry preserves the recovery fence',
  );
  await w.drain({ ...w.input, operationId: w.input.operationId, existing: false, phase: 1 });
  const updated = w.f.tables.projectHostedOperations.get(row._id);
  assert.equal(updated.recovery, ledger);
  assert.notEqual(updated.journalDigest, row.journalDigest);
  w.f.advanceClock(70 * 86_400_000);
  const operation = await import(moduleUrl('../convex/projectHostedOperations.ts'));
  await w.mutate(ctx => operation.pruneExpiredHostedOperations(ctx, w.f.projectId, Date.now()));
  assert(!w.f.tables.projectHostedOperations.has(row._id));
  const recovery = await import(moduleUrl('../convex/projectJournalOperationRecovery.ts'));
  const retained = [];
  for (const index of w.f.tables.projectJournalSegments.values()) {
    if (index.category !== 'operations') continue;
    const segment = await objects.getJournalSegment(w.f.projectId, JSON.parse(index.value));
    for (const text of segment.tables.projectHostedOperations ?? []) {
      const value = await w.mutate(ctx => recovery.journalOperationRecoveryRow(ctx, w.f.projectId, text));
      if (value && JSON.parse(value)._id === row._id) retained.push(JSON.parse(value));
    }
  }
  assert.equal(retained.length, 1);
  assert.equal(retained[0].recovery, ledger);
});

test('closed Lane save digests drain in bounded pages while an open Lane keeps its staged rows', async t => {
  const w = await journalMaintenanceFixture(t, { advance: false });
  const closed = [...w.f.tables.projectHostedRecordHeads.values()].find(
    row => row.kind === 'lane' && row.status === 'completed',
  );
  assert(closed);
  const operationId = randomUUID();
  await w.insert('projectHostedSaves', {
    projectId: w.f.projectId,
    actor: 'owner',
    operationId,
    jobId: 'job',
    value: JSON.stringify({ request: { laneId: closed.key }, status: 'completed' }),
  });
  const ids = [];
  for (let index = 0; index < 120; index++)
    ids.push(
      await w.insert('projectHostedSavePages', {
        projectId: w.f.projectId,
        actor: 'owner',
        operationId,
        index,
        digest: 'a'.repeat(64),
      }),
    );
  await w.mutate(ctx => ctx.db.patch(closed._id, { status: 'active' }));
  w.f.advanceClock(31 * 86_400_000);
  await w.drain({ ...w.input, phase: 2 });
  assert(
    ids.every(id => w.f.tables.projectHostedSavePages.has(id)),
    'an open Lane keeps every staged digest',
  );
  await w.mutate(ctx => ctx.db.patch(closed._id, { status: 'completed' }));
  const results = await w.drain({ ...w.input, operationId: randomUUID(), phase: 2 });
  assert(results.length >= 2);
  assert(ids.every(id => !w.f.tables.projectHostedSavePages.has(id)));
  const archived = [...w.f.tables.projectJournalSegments.values()]
    .filter(row => row.category === 'save')
    .flatMap(row => JSON.parse(row.value).savePages);
  assert.deepEqual(
    archived.map(row => row[0]).sort((a, b) => a - b),
    Array.from({ length: 120 }, (_, i) => i),
  );
  assert(archived.every(row => row[1] === 'a'.repeat(64)));
  assert(
    w.transcript
      .filter(step => step.name.endsWith('Capture:page'))
      .every(step => (JSON.parse(step.value).pending?.refs.length ?? 0) <= 100),
  );
});
test('a lost capture claim resumes after its lease and concurrent claims never publish another object', async t => {
  const w = await journalMaintenanceFixture(t);
  const capture = await import(moduleUrl('../convex/projectJournalCapture.ts'));
  const input = { ...w.input, claim: randomUUID() };
  const first = JSON.parse(await w.f.c.transaction('journalCapture', capture.page, input));
  assert(first.texts.length > 0);
  assert.equal((await w.pack()).deferred, 'claimed');
  assert.equal(w.objects.size, 0);
  w.release();
  await w.drain();
  assert.equal(w.requests.filter(method => method === 'PUT').length, w.objects.size);
});

test('a fractional creation-time eligibility wake drains aged detail without another user event', async t => {
  const w = await journalMaintenanceFixture(t, { advance: false });
  const id = await w.insert('projectCoordinationEvents', {
    projectId: w.f.projectId,
    actor: 'owner',
    operationId: randomUUID(),
    at: Date.now(),
    command: { kind: 'change', source: 'work' },
  });
  w.f.advanceClock(14 * 86_400_000);
  const scheduled = new Set(w.f.tables._scheduled_functions.keys());
  await w.drain({ ...w.input, phase: 4 });
  const wakes = [...w.f.tables._scheduled_functions.values()].filter(
    row => !scheduled.has(row._id) && row.name === 'projectJournalRun:pack',
  );
  assert(wakes.length > 0);
  assert(w.f.tables.projectCoordinationEvents.has(id));
  w.f.advanceClock(100);
  for (const wake of wakes) await w.drain(wake.args[0]);
  assert(!w.f.tables.projectCoordinationEvents.has(id));
  assert(
    ![...w.f.tables.projectJournalReceipts.values()].some(row => row.operationId.startsWith('journal-wake:')),
  );
});

test('future Lane save work is scheduled once across inventory pages and paused-job markers clear on resume', async t => {
  const w = await journalMaintenanceFixture(t, { advance: false });
  const closed = [...w.f.tables.projectHostedRecordHeads.values()].find(
    row => row.kind === 'lane' && row.status === 'completed',
  );
  const operationId = randomUUID();
  await w.insert('projectHostedSaves', {
    projectId: w.f.projectId,
    actor: 'owner',
    operationId,
    jobId: 'job',
    value: JSON.stringify({ request: { laneId: closed.key }, status: 'completed' }),
  });
  for (let index = 0; index < 120; index++)
    await w.insert('projectHostedSavePages', {
      projectId: w.f.projectId,
      actor: 'owner',
      operationId,
      index,
      digest: 'a'.repeat(64),
    });
  const scheduled = new Set(w.f.tables._scheduled_functions.keys());
  await w.drain({ ...w.input, phase: 2 });
  const wakes = [...w.f.tables._scheduled_functions.values()].filter(
    row =>
      !scheduled.has(row._id) && row.name === 'projectJournalRun:pack' && row.args[0].laneId === closed.key,
  );
  assert.equal(wakes.length, 1, 'one known eligibility event, not one timer per row or inventory page');
  const pending = [...w.f.tables.projectJournalReceipts.values()].filter(row =>
    row.operationId.startsWith('journal-wake:'),
  );
  assert.equal(pending.length, 1);
  t.diagnostic(
    JSON.stringify({
      pendingEligibilityRows: pending.length,
      bytes: pending.reduce(
        (n, row) => n + Buffer.byteLength(JSON.stringify({ ...row, _creationTime: 0 })),
        0,
      ),
    }),
  );
  w.f.advanceClock(8 * 86_400_000);
  delete process.env.FORGE_JOURNAL_SEGMENTS;
  assert.equal((await w.pack(wakes[0].args[0])).kept, 'disabled');
  process.env.FORGE_JOURNAL_SEGMENTS = '1';
  await w.drain({ ...w.input, operationId: randomUUID(), phase: 0 });
  assert(
    ![...w.f.tables.projectJournalReceipts.values()].some(row => row.operationId.startsWith('journal-wake:')),
  );
  assert.equal(w.f.tables.projectHostedSavePages.size, 0);
});

test('operator and terminal-event cursors replace fixed project rows as history grows', async t => {
  const w = await journalMaintenanceFixture(t);
  await w.drain();
  await w.drain({ projectId: w.f.projectId, operationId: `work:${'a'.repeat(36)}` });
  await w.drain({
    projectId: w.f.projectId,
    operationId: `recovery:${'p'.repeat(32)}:${'a'.repeat(64)}`,
    phase: 1,
  });
  const controls = () =>
    [...w.f.tables.projectJournalReceipts.values()].filter(row =>
      /^journal-control:[0-4]:(existing|live)$/.test(row.operationId),
    );
  assert.equal(controls().length, 8);
  const count = w.objects.size;
  for (let i = 0; i < 2; i++)
    await w.drain({
      projectId: w.f.projectId,
      operationId: `recovery:${'p'.repeat(32)}:${String(i).repeat(64)}`,
      phase: 1,
    });
  assert.equal(controls().length, 8);
  assert.equal(w.objects.size, count);
  t.diagnostic(
    JSON.stringify({
      steadyControls: {
        rows: controls().length,
        bytes: controls().reduce(
          (n, row) => n + Buffer.byteLength(JSON.stringify({ ...row, _creationTime: 0 })),
          0,
        ),
      },
    }),
  );
});
