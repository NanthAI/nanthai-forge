// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { recordsFixture } from './hosted-records-fixture.mjs';

const { workRecordWriter, finishWorkRecordWrites } = await import(
  moduleUrl('../convex/projectWorkRecordWriter.ts')
);
const { exactChildTally, planCounter } = await import(moduleUrl('../convex/projectPlanCountsStore.ts'));
const { publishRollupBranches, readRollupBranch, readRollupScope } = await import(
  moduleUrl('../convex/projectPlanRollupStore.ts')
);
const { prepareScopes, prepareScopesAll, scopeCoverage } = await import(
  moduleUrl('../convex/projectPlanCounts.ts')
);

async function fixture(legacy = false) {
  const s = recordsFixture();
  const { projectId } = await s.setup();
  const tasks = [];
  s.ctx.scheduler.runAfter = async (_delay, ref, args) => {
    assert.equal(getFunctionName(ref), 'projectInitiativeWorkRebuild:advance');
    return `task-${tasks.push(args)}`;
  };
  const writer = workRecordWriter(s.ctx);
  const backupId = 'synthetic-backup';
  const partition = await (legacy ? s.ctx : writer).db.insert('projectWorkGenerations', {
    projectId,
    format: 11,
    status: 'ready',
    backupId,
    revision: 0,
    initialRevision: 0,
    nextBatch: 0,
    metadata: '{"schema":24}',
  });
  await s.ctx.db.patch(projectId, {
    work: {
      backupId,
      generationId: partition,
      operationId: 'synthetic-index',
      initialRevision: 0,
      revision: 0,
    },
  });
  const fields = (id, position, extra) => {
    const item = { id, position, kind: 'issue', title: 'Synthetic', status: 'open', ...extra };
    return {
      value: JSON.stringify(item),
      planning: {
        kind: item.kind,
        status: item.status,
        text: item.title,
        initiativeId: item.initiativeId ?? '',
        open: ['proposed', 'open', 'in-progress'].includes(item.status),
      },
    };
  };
  const write = async route => {
    const context = workRecordWriter(s.ctx);
    const result = await route(context.db);
    await finishWorkRecordWrites(context);
    return result;
  };
  const put = (id, position, extra) => {
    const insert = db =>
      db.insert('projectPlanningRecords', {
        projectId,
        generationId: partition,
        collection: 'planningSearch',
        key: id,
        parent: '',
        position,
        ...fields(id, position, extra),
      });
    return legacy ? insert(s.ctx.db) : write(insert);
  };
  const update = (doc, id, position, extra) =>
    write(async db => {
      await db.get(doc);
      await db.patch(doc, fields(id, position, extra));
    });
  return {
    ...s,
    put,
    update,
    child: id => exactChildTally(s.ctx.db, partition, id),
    initiative: id => readRollupScope(s.ctx.db, partition, `initiative:${id}`, true),
    async effective(id) {
      const state = await readRollupBranch(s.ctx.db, partition, id);
      return state.effective ?? state.counts;
    },
    async forward(item, facts) {
      const previous = await readRollupBranch(s.ctx.db, partition, item.id);
      return publishRollupBranches(s.ctx.db, { projectId, partition }, [{ item, previous, next: facts }]);
    },
    prepare: after => prepareScopes._handler(s.ctx, { projectId, expectedPartition: partition, after }),
    coverage: async () => JSON.parse((await planCounter(s.ctx.db, partition)).value),
    partition,
  };
}

test('exact child and Initiative tallies follow moves, shelves and hidden settled children', async () => {
  const s = await fixture();
  const child = await s.put('child', 0, {
    parentId: 'a',
    initiativeId: 'one',
    status: 'closed',
    hidden: true,
  });
  assert.equal((await s.child('a')).total, 1);
  assert.equal((await s.child('a')).done, 1);
  assert.equal((await s.initiative('one')).done, 1);
  await s.update(child, 'child', 0, { parentId: 'b', initiativeId: 'two', status: 'closed', hidden: true });
  assert.equal((await s.child('a')).total, 0);
  assert.equal((await s.child('b')).done, 1);
  assert.equal((await s.initiative('one')).total, 0);
  assert.equal((await s.initiative('two')).done, 1);
  await s.update(child, 'child', 0, { parentId: 'b', initiativeId: 'two', status: 'archived', hidden: true });
  assert.equal((await s.child('b')).total, 0);
  assert.equal((await s.initiative('two')).total, 0);
  const coverage = await s.coverage();
  const zero = await s.run('no-children', () =>
    exactChildTally(s.ctx.db, s.partition, 'no-children', coverage),
  );
  assert.equal(zero.total, 0);
  assert(s.counts.at(-1).documents <= 1, 'a covered sparse lookup reads no siblings');
});

test('the exact child count includes hidden children and groups that overflow the visibility counter', async () => {
  const s = await fixture();
  for (let i = 0; i < 101; i++) await s.put(`overflow-${i}`, i, { initiativeId: `initiative-${i}` });
  await s.put('overflow-child', 101, {
    parentId: 'overflow-parent',
    initiativeId: 'another',
    status: 'closed',
  });
  await s.put('hidden-child', 102, { parentId: 'overflow-parent', hidden: true });
  assert.equal((await s.child('overflow-parent')).total, 2);
  assert.equal((await s.child('overflow-parent')).unsettled, 1);
});

test('legacy scope preparation stays unknown until the last page and folds interleaved writes once', async () => {
  const s = await fixture(true);
  const docs = [];
  for (let n = 0; n < 55; n++) docs.push(await s.put(`child-${100 + n}`, n, { parentId: 'a' }));
  assert.equal(await s.child('a'), null);
  const page = await s.prepare('');
  assert.deepEqual(page, { after: 'child-149', counted: 50, replayed: false });
  assert.equal(await s.child('a'), null, 'a partial tally is not exact');
  await s.update(docs[0], 'child-100', 0, { parentId: 'b', status: 'closed' });
  await s.update(docs.at(-1), 'child-154', 54, { parentId: 'b', status: 'closed' });
  assert.deepEqual(await s.prepare(''), { after: page.after, counted: 0, replayed: true });
  assert.deepEqual(await s.prepare(page.after), { after: null, counted: 5, replayed: false });
  assert.equal((await s.child('a')).total, 53);
  assert.equal((await s.child('b')).done, 2);
  assert.deepEqual(await s.prepare(page.after), { after: null, counted: 0, replayed: true });
  assert.equal((await s.child('b')).total, 2);
});

test('the all-project preparation driver advances one root page per task and is safe to restart', async () => {
  const s = await fixture(true);
  for (let i = 100; i < 155; i++) await s.put(`child-${i}`, i, { parentId: 'a' });
  const scheduled = [];
  s.ctx.scheduler.runAfter = async (_delay, ref, args) => {
    assert.equal(getFunctionName(ref), 'projectPlanCounts:prepareScopes');
    scheduled.push(args);
    return 'task';
  };
  assert.deepEqual(await scopeCoverage._handler(s.ctx, {}), {
    complete: 0,
    pending: 1,
    blocked: 0,
    noPlan: 0,
    next: null,
  });
  assert.deepEqual(await prepareScopesAll._handler(s.ctx, {}), { scheduled: 1, isDone: true });
  const first = await prepareScopes._handler(s.ctx, scheduled.shift());
  assert.equal(first.counted, 50);
  assert.equal(await s.child('a'), null);
  assert.equal(scheduled.length, 1);
  const last = await prepareScopes._handler(s.ctx, scheduled.shift());
  assert.equal(last.counted, 5);
  assert.equal(scheduled.length, 0);
  assert.equal((await s.child('a')).total, 55);
  assert.deepEqual(await scopeCoverage._handler(s.ctx, {}), {
    complete: 1,
    pending: 0,
    blocked: 0,
    noPlan: 0,
    next: null,
  });
  await prepareScopesAll._handler(s.ctx, {});
  assert.deepEqual(await prepareScopes._handler(s.ctx, scheduled.shift()), {
    after: null,
    counted: 0,
    replayed: true,
  });
  assert.equal((await s.child('a')).total, 55);
});

test('moving an overridden branch subtracts its published facts and preserves them only on the new parent', async () => {
  const s = await fixture();
  const middle = { id: 'middle', parentId: 'old', initiativeId: 'g', status: 'closed' };
  const doc = await s.put(middle.id, 0, middle);
  assert.equal((await s.child('old')).unsettled, 0);
  const childFacts = { unsettled: 1, progress: 1, started: 1 };
  assert.equal(await s.forward(middle, childFacts), true);
  assert.equal(await s.forward(middle, childFacts), false, 'retry does not double-count a branch');
  assert.equal(
    (await s.child('old')).unsettled,
    0,
    'public exact tally still counts direct displayed statuses',
  );
  assert.equal((await s.effective('old')).unsettled, 1);
  assert.equal((await s.initiative('g')).unsettled, 0, 'an Initiative counts the displayed member once');
  await s.update(doc, middle.id, 0, { ...middle, parentId: 'new' });
  assert.equal((await s.effective('old')).total, 0);
  assert.equal((await s.effective('new')).progress, 1);
  await s.forward({ ...middle, parentId: 'new' }, { unsettled: 0, progress: 0, started: 1 });
  assert.equal((await s.effective('new')).unsettled, 0);
  assert.equal((await s.effective('new')).done, 1);
});
