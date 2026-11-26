// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleUrl } from './convex-module.mjs';
import { projectRow, state } from './hosted-fixture.mjs';

const migration = await import(moduleUrl('../convex/projectIntentLandingNoteFill.ts'));

function dev(t) {
  t.mock.property(process, 'env', {
    ...process.env,
    CONVEX_CLOUD_URL: 'https://benevolent-wildebeest-974.convex.cloud',
  });
}

async function seed() {
  const projectId = 'project';
  const { ctx, tables } = state([]);
  tables.hostedProjects.set(projectId, projectRow({ _id: projectId, workStore: 'records' }));
  const intentId = 'successor';
  const itemId = 'item';
  await ctx.db.insert('projectHostedRecordHeads', {
    projectId,
    kind: 'intent',
    key: intentId,
    parent: '',
    status: 'completed',
    version: 1,
    recordId: 'projectHostedRecords-1',
    planningItemId: itemId,
  });
  const note = (i, fields = {}) =>
    ctx.db.insert('projectIntentLandingNotes', {
      projectId,
      intentId,
      receiptId: `receipt-${i}`,
      kind: 'landed',
      at: '2026-11-26T00:00:00.000Z',
      laneIds: [],
      ...(i % 2 ? { capsule: 'archive' } : { commit: 'a'.repeat(64), sequence: i, actor: 'owner' }),
      ...fields,
    });
  return { ctx, tables, projectId, itemId, note };
}

test('dev fill counts missing hot and archived notes, pins a 64-row page and resumes after a lost reply', async t => {
  dev(t);
  const { ctx, tables, projectId, itemId, note } = await seed();
  for (let i = 0; i < 66; i++) await note(i);
  const other = await note(67, { projectId: 'other' });
  const current = await note(68, { itemId });
  const before = new Map(tables.projectIntentLandingNotes);
  const args = { projectId };
  const census = await migration.count._handler(ctx, { ...args, cursor: null });
  assert.equal(census.notes, 64);
  assert.equal(census.rows, 64);
  assert.equal(census.estimatedBytes, 96_000);
  assert.deepEqual(census.recoverable, []);
  assert.deepEqual(census.orphans, []);
  const tail = await migration.count._handler(ctx, { ...args, cursor: census.next });
  assert.equal(tail.notes, 3);
  assert.equal(tail.rows, 2);
  assert.equal(tail.next, null);
  const first = await migration.remaining._handler(ctx, args);
  assert.deepEqual(await migration.fill._handler(ctx, { ...args, first }), {
    patched: 64,
    recovered: 0,
    deleted: 0,
    stale: false,
  });
  assert.deepEqual(await migration.fill._handler(ctx, { ...args, first }), {
    patched: 0,
    recovered: 0,
    deleted: 0,
    stale: true,
  });
  for (let i = 0; i < 2; i++) {
    const next = await migration.remaining._handler(ctx, args);
    assert.deepEqual(await migration.fill._handler(ctx, { ...args, first: next, maxRows: 1 }), {
      patched: 1,
      recovered: 0,
      deleted: 0,
      stale: false,
    });
  }
  assert.equal(await migration.remaining._handler(ctx, args), null);
  for (const [id, row] of before)
    assert.deepEqual(await ctx.db.get(id), id === other || id === current ? row : { ...row, itemId });
});

const putHead = (ctx, projectId, kind, key, fields = {}) =>
  ctx.db.insert('projectHostedRecordHeads', {
    projectId,
    kind,
    key,
    parent: '',
    status: 'completed',
    version: 1,
    recordId: 'projectHostedRecords-1',
    ...fields,
  });

const putReceipt = (ctx, projectId, i, candidateId) =>
  ctx.db.insert('projectHostedAcceptances', {
    projectId,
    receiptId: `receipt-${i}`,
    submissionId: 'submission',
    attemptId: 'attempt',
    sequence: i,
    value: JSON.stringify({ candidate: { id: candidateId } }),
  });

test('census and fill recover through receipt Candidate and Lane provenance and remove only the orphan reference', async t => {
  dev(t);
  const { ctx, projectId, itemId, note } = await seed();
  await putHead(ctx, projectId, 'issue', 'duplicate', {
    value: JSON.stringify({
      id: 'duplicate',
      status: 'abandoned',
      relations: [{ kind: 'duplicate-of', id: itemId }],
    }),
  });
  await putHead(ctx, projectId, 'issue', itemId, {
    value: JSON.stringify({ id: itemId, status: 'closed' }),
  });
  await putHead(ctx, projectId, 'candidate', 'candidate', { parent: 'duplicate' });
  await putHead(ctx, projectId, 'candidate', 'unbound-candidate', { parent: 'unbound' });
  await putHead(ctx, projectId, 'lane', 'old-lane', {
    parent: 'another-intent',
    planningItemId: 'duplicate',
  });
  const first = await note(0);
  const candidateNote = await note(1, { intentId: 'unbound' });
  const laneNote = await note(2, { intentId: 'unbound', laneIds: ['old-lane'] });
  const orphan = await note(3, { intentId: 'unbound' });
  await putReceipt(ctx, projectId, 1, 'candidate');
  await putReceipt(ctx, projectId, 2, 'unbound-candidate');
  const orphanReceipt = await putReceipt(ctx, projectId, 3, 'unbound-candidate');
  const census = await migration.count._handler(ctx, { projectId, cursor: null });
  assert.deepEqual(census.recoverable, [
    { noteId: candidateNote, receiptId: 'receipt-1' },
    { noteId: laneNote, receiptId: 'receipt-2' },
  ]);
  assert.deepEqual(census.orphans, [{ noteId: orphan, receiptId: 'receipt-3' }]);
  assert.equal((await ctx.db.get(orphan)).capsule, 'archive');
  assert.deepEqual(await migration.fill._handler(ctx, { projectId, first, deleteOrphans: [orphan] }), {
    patched: 3,
    recovered: 2,
    deleted: 1,
    stale: false,
  });
  for (const id of [first, candidateNote, laneNote]) assert.equal((await ctx.db.get(id)).itemId, itemId);
  assert.equal((await ctx.db.get(candidateNote)).capsule, 'archive');
  assert.equal(await ctx.db.get(orphan), null);
  assert.equal((await ctx.db.get(orphanReceipt)).receiptId, 'receipt-3');
});

test('fill leaves the entire page intact for missing acceptance evidence or an uncensused orphan', async t => {
  dev(t);
  const { ctx, projectId, note } = await seed();
  const first = await note(0);
  const unbound = await note(1, { intentId: 'unbound' });
  await assert.rejects(migration.fill._handler(ctx, { projectId, first }), {
    code: 'WORK_STALE',
    message: /acceptance receipt/,
  });
  await putReceipt(ctx, projectId, 1, 'unbound-candidate');
  await assert.rejects(migration.fill._handler(ctx, { projectId, first }), {
    code: 'WORK_STALE',
    message: /was not in the census/,
  });
  assert.equal((await ctx.db.get(first)).itemId, undefined);
  assert.equal((await ctx.db.get(unbound)).itemId, undefined);
});

test('a provenance page over budget can restart from its first pin with fewer rows', async t => {
  dev(t);
  const { ctx, projectId, itemId, note } = await seed();
  const first = await note(0);
  const tail = await note(1);
  let measurements = 0;
  ctx.meta.getTransactionMetrics = async () => ({
    documentsRead: { used: ++measurements === 2 ? 193 : 2 },
    bytesRead: { used: 1000 },
  });
  await assert.rejects(migration.fill._handler(ctx, { projectId, first }), {
    code: 'WORK_STALE',
    message: /page read budget/,
  });
  assert.equal((await ctx.db.get(first)).itemId, undefined);
  assert.equal((await ctx.db.get(tail)).itemId, undefined);
  assert.equal((await migration.fill._handler(ctx, { projectId, first, maxRows: 1 })).patched, 1);
  assert.equal((await ctx.db.get(first)).itemId, itemId);
  assert.equal(await migration.remaining._handler(ctx, { projectId }), tail);
});

test('landing-note count and fill refuse other deployments before any database access', async t => {
  t.mock.property(process, 'env', { ...process.env, CONVEX_CLOUD_URL: 'https://other.convex.cloud' });
  const ctx = {
    get db() {
      assert.fail('Read from a deployment outside Forge dev');
    },
  };
  const projectId = 'project';
  for (const [fn, args] of [
    [migration.count, { projectId, cursor: null }],
    [migration.remaining, { projectId }],
    [migration.fill, { projectId, first: 'note' }],
  ])
    await assert.rejects(fn._handler(ctx, args), { code: 'PROJECT_UNAVAILABLE' });
});
