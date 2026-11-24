// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { state, setWorkRecord, workRecordRows } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const retire = await import(moduleUrl('../convex/projectViewRowsRetire.ts'));
const legacy = ['viewFiles', 'viewFiles:payload', 'viewDetails', 'viewDetails:payload', 'laneViews'];
const kept = ['viewAcceptances', 'views', 'lanes'];

function seed() {
  const s = state([]);
  let n = 0;
  const generations = { one: 'project-one', two: 'project-two', empty: 'project-empty' };
  for (const [id, projectId] of Object.entries(generations))
    s.tables.projectWorkGenerations.set(id, { _id: id, projectId });
  const put = (generationId, collection, count) => {
    for (let i = 0; i < count; i++) {
      const _id = `row-${n++}`;
      setWorkRecord(s.tables, _id, {
        _id,
        _creationTime: 1,
        projectId: generations[generationId],
        generationId,
        collection,
        key: `${collection}:${i}`,
        parent: 'view',
        position: i,
        value: JSON.stringify({ i }),
      });
    }
  };
  for (const collection of legacy) put('one', collection, 250);
  for (const collection of kept) put('one', collection, 3);
  put('two', 'viewFiles', 7);
  put('two', 'viewAcceptances', 2);
  put('empty', 'viewAcceptances', 1);
  const ctx = {
    runQuery: async (ref, args) => retire[getFunctionName(ref).split(':')[1]]._handler(s.ctx, args),
    runMutation: async (ref, args) => retire[getFunctionName(ref).split(':')[1]]._handler(s.ctx, args),
  };
  const rows = () => workRecordRows(s.tables);
  const count = names => rows().filter(r => names.includes(r.collection)).length;
  return { s, ctx, rows, count };
}

test('View row retirement: a dry run counts without writing, then apply deletes only the legacy collections and the rescan finds none (Item c0af6cfa F1)', async () => {
  const f = seed();
  const before = f.rows().length;
  const dry = JSON.parse(await retire.run._handler(f.ctx, { operationId: 'dry', apply: false }));
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.rows, 5 * 250 + 7);
  assert.equal(dry.rangesFound, 6);
  assert.equal(dry.stopped, null);
  assert.equal(f.rows().length, before, 'a dry run writes nothing');
  assert.equal(f.s.tables.projectReturnPages.size, 0);
  const wanted = dry.ranges.find(r => r.generationId === 'two' && r.collection === 'viewFiles');
  assert.equal(wanted.rows, 7);
  assert.ok(wanted.bytes > 0);

  const applied = JSON.parse(await retire.run._handler(f.ctx, { operationId: 'apply', apply: true }));
  assert.equal(applied.isDone, true);
  assert.equal(applied.remainingRanges, 0);
  assert.equal(applied.rows, dry.rows);
  assert.equal(applied.deletedBytes, applied.readBytes);
  assert.ok(applied.receiptsForgotten > 0, 'a finished apply forgets its receipts');
  assert.equal(f.s.tables.projectReturnPages.size, 0);
  assert.equal(f.count(legacy), 0);
  assert.equal(f.count(kept), 3 * 3 + 2 + 1, 'viewAcceptances and every other collection are untouched');
  const again = JSON.parse(await retire.run._handler(f.ctx, { operationId: 'again', apply: true }));
  assert.equal(again.rows, 0);
  assert.equal(again.isDone, true);
});

test('View row retirement stops at its read budget, pages stay at 100 rows, and a lost reply replays its receipt', async () => {
  const f = seed();
  const args = {
    generationId: 'one',
    collection: 'viewFiles',
    table: 'projectWorkDataRecords',
    operationId: 'page-1',
  };
  const first = JSON.parse(await retire.page._handler(f.s.ctx, args));
  assert.equal(first.rows, 100);
  assert.equal(first.isDone, false);
  const remaining = () => f.count(['viewFiles']) - 7;
  assert.equal(remaining(), 150);
  assert.deepEqual(
    JSON.parse(await retire.page._handler(f.s.ctx, args)),
    first,
    'a replay returns the stored result',
  );
  assert.equal(remaining(), 150, 'a replay deletes nothing');
  await assert.rejects(
    retire.page._handler(f.s.ctx, { ...args, collection: 'viewDetails', table: 'projectWorkRecords' }),
    e => (e.data?.code ?? e.code) === 'WORK_OPERATION_CHANGED',
  );
  await assert.rejects(
    retire.page._handler(f.s.ctx, { ...args, collection: 'viewAcceptances', operationId: 'other' }),
    e => (e.data?.code ?? e.code) === 'BAD_ARGUMENT',
  );

  const limited = JSON.parse(
    await retire.run._handler(f.ctx, { operationId: 'limited', apply: true, budgetBytes: 1 }),
  );
  assert.equal(limited.stopped, 'budget');
  assert.equal(limited.isDone, false);
  assert.equal(limited.remainingRanges, null, 'no proof is claimed after an early stop');
  const resumed = JSON.parse(await retire.run._handler(f.ctx, { operationId: 'resume', apply: true }));
  assert.equal(resumed.isDone, true);
  assert.equal(f.count(legacy), 0);
});

test('View row retirement refuses to delete while an index build is in flight and finds rows in any record table', async () => {
  const f = seed();
  f.s.tables.projectWorkGenerations.get('two').status = 'building';
  const dry = JSON.parse(await retire.run._handler(f.ctx, { operationId: 'dry', apply: false }));
  assert.equal(dry.buildingGenerations, 1, 'a dry run reports it');
  await assert.rejects(
    retire.run._handler(f.ctx, { operationId: 'apply', apply: true }),
    e => (e.data?.code ?? e.code) === 'WORK_STALE',
  );
  assert.equal(f.count(legacy) > 0, true, 'nothing was deleted');
  f.s.tables.projectWorkGenerations.get('two').status = 'ready';
  // A partition from before the table split holds a View row in the core table.
  f.s.tables.projectWorkRecords.set('old-split', {
    _id: 'old-split',
    _creationTime: 1,
    projectId: 'project-empty',
    generationId: 'empty',
    collection: 'viewFiles',
    key: 'old',
    parent: 'view',
    position: 0,
    value: '{}',
  });
  const applied = JSON.parse(await retire.run._handler(f.ctx, { operationId: 'apply', apply: true }));
  assert.equal(applied.isDone, true);
  assert.equal(f.s.tables.projectWorkRecords.has('old-split'), false);
  assert.equal(f.count(legacy), 0);
  assert.equal(f.count(['viewAcceptances']), 3 + 2 + 1);
});
