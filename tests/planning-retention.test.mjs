// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { setup } from './hosted-planning-fixture.mjs';
import { meterReads, trackReadSets } from './hosted-read-set.mjs';
import { moduleUrl } from './convex-module.mjs';

const modules = {
  projectItemRetention: await import(moduleUrl('../convex/projectItemRetention.ts')),
  projectPlanningPurge: await import(moduleUrl('../convex/projectPlanningPurge.ts')),
  projectPlanningPurgeSelect: await import(moduleUrl('../convex/projectPlanningPurgeSelect.ts')),
};
const retention = modules.projectItemRetention;
const shelf = await import(moduleUrl('../convex/projectPlanSettled.ts'));
const day = 24 * 60 * 60 * 1000;
const time = Date.parse('2026-07-01T12:00:00Z');
const code = expected => error => (error.data?.code ?? error.code) === expected;

function routePurge(s, before = () => undefined) {
  for (const kind of ['runAction', 'runQuery', 'runMutation']) {
    const fallback = s.ctx[kind];
    s.ctx[kind] = async (ref, args) => {
      const [module, name] = getFunctionName(ref).split(':');
      const handler = modules[module]?.[name];
      if (!handler) return fallback(ref, args);
      await before(module, name, args);
      try {
        return await (handler.isMutation
          ? s.transaction(() => handler._handler(s.ctx, args))
          : handler._handler(s.ctx, args));
      } catch (error) {
        // Plain errors crossing a Convex function boundary lose their application code.
        if (module === 'projectItemRetention' && name === 'prepare' && !(error instanceof ConvexError))
          throw new Error('Internal Server Error');
        throw error;
      }
    };
  }
}
const current = async (s, itemId) => (await s.read()).data.planningItems.findLast(item => item.id === itemId);
const write = (s, itemId, expectedVersion, fields) =>
  s.send({ action: 'put-planning-item', operationId: randomUUID(), itemId, expectedVersion, ...fields });
const dispatch = s => s.scheduled.filter(task => getFunctionName(task.fn) === 'projectItemRetention:expire');

async function createDeleted(t, fields = {}) {
  const s = await setup(t);
  t.mock.timers.enable({ apis: ['Date'], now: time });
  const created = s.item({ body: 'The recoverable planning text', ...fields });
  const { itemId } = created;
  await s.send(created);
  const deletion = s.item({
    itemId,
    expectedVersion: 1,
    status: 'deleted',
    operationId: randomUUID(),
    body: created.body,
  });
  const revision = (await s.read()).data.revision;
  await s.send(deletion, revision);
  await s.send(deletion, revision);
  return { s, itemId, body: created.body };
}

test('Delete measures 30 days from the deletion, edits retain its date, and the sweep purges only when due', async t => {
  const { s, itemId } = await createDeleted(t);
  routePurge(s);
  assert.equal(s.tables.projectItemRetention.size, 2, 'replay keeps one deadline and one attempt');
  const deadline = time + 30 * day;
  const list = () => shelf.settledPage(s.ctx, s.projectId, 'deleted', { cursor: null, numItems: 50 });
  assert.equal(JSON.parse((await list()).page[0]).purgeAt, deadline);
  t.mock.timers.setTime(time + 7 * day);
  await write(s, itemId, 2, { title: 'Updated while Deleted' });
  assert.equal(JSON.parse((await list()).page[0]).purgeAt, deadline);
  t.mock.timers.setTime(deadline - 1);
  assert.equal(await retention.sweep._handler(s.ctx, {}), 0);
  assert.equal(dispatch(s).length, 0);
  t.mock.timers.setTime(deadline);
  assert.equal(await retention.sweep._handler(s.ctx, {}), 1);
  const [task] = dispatch(s);
  assert.equal(task.args.itemId, itemId);
  const purgedAt = await retention.expire._handler(s.ctx, task.args);
  assert.equal(purgedAt, deadline);
  assert.equal(s.tables.projectItemRetention.size, 1, 'only the completion receipt remains');
  assert.deepEqual((await list()).page, []);
  assert.equal((await current(s, itemId)).title, 'Deleted Item');
  assert.equal((await current(s, itemId)).body, '');
  assert.equal(await retention.expire._handler(s.ctx, task.args), purgedAt);
  await assert.rejects(write(s, itemId, 4, { status: 'open' }), code('PLANNING_ITEM_PURGED'));
});

test('Restore racing the timer leaves text and versions whole, and a new Delete gets its own 30 days', async t => {
  const { s, itemId, body } = await createDeleted(t);
  t.mock.timers.setTime(time + 30 * day);
  assert.equal(await retention.sweep._handler(s.ctx, {}), 1);
  const [task] = dispatch(s);
  let restored = false;
  routePurge(s, async (module, name) => {
    if (module === 'projectPlanningPurge' && name === 'begin' && !restored) {
      restored = true;
      await write(s, itemId, 2, { status: 'open' });
    }
  });
  await assert.rejects(retention.expire._handler(s.ctx, task.args), code('WORK_STALE'));
  assert.equal(s.tables.projectItemRetention.size, 0);
  assert.equal(s.tables.hostedProjects.get(s.projectId).itemPurges, undefined);
  assert.equal((await current(s, itemId)).body, body);
  assert.equal((await current(s, itemId)).status, 'open');
  await write(s, itemId, 3, { status: 'deleted' });
  // The old task can arrive after a Restore and a second Delete. Its operation cannot purge version 4.
  await assert.rejects(retention.expire._handler(s.ctx, task.args), code('ITEM_CHANGED'));
  assert.equal((await current(s, itemId)).body, body);
  assert.equal(s.tables.hostedProjects.get(s.projectId).itemPurges, undefined);
  const next = [...s.tables.projectItemRetention.values()].find(row => row.kind === 'deadline');
  assert.equal(next.purgeAt, time + 60 * day);
  assert.deepEqual(
    (await s.read()).data.planningItems.filter(item => item.id === itemId).map(item => item.body),
    [body, body, body, body],
  );
});

test('Delete forever refuses a contributor, requires typed confirmation, and replays the owner’s purge', async t => {
  const { s, itemId, body } = await createDeleted(t);
  routePurge(s);
  const input = { projectId: s.projectId, itemId, version: 2, confirmation: 'DELETE' };
  s.tables.projectContributors.set('contributor', { projectId: s.projectId, contributor: 'member' });
  s.caller('member');
  await assert.rejects(retention.deleteForever._handler(s.ctx, input), code('PROJECT_UNAVAILABLE'));
  s.caller('owner');
  await assert.rejects(
    retention.deleteForever._handler(s.ctx, { ...input, confirmation: 'delete' }),
    code('BAD_ARGUMENT'),
  );
  assert.equal((await current(s, itemId)).body, body);
  assert.equal(s.tables.hostedProjects.get(s.projectId).itemPurges, undefined);
  const revision = (await s.read()).data.revision;
  const pending = [...s.tables.projectItemRetention.values()];
  await assert.rejects(
    retention.deleteForever._handler(s.ctx, { ...input, version: 1 }),
    code('ITEM_CHANGED'),
  );
  assert.deepEqual([...s.tables.projectItemRetention.values()], pending);
  assert.equal((await s.read()).data.revision, revision);
  assert.equal(await retention.deleteForever._handler(s.ctx, input), time);
  const after = (await s.read()).data.revision;
  s.tables.hostedProjects.get(s.projectId).itemPurges = []; // Executor retains only its newest completed entries.
  assert.equal(await retention.deleteForever._handler(s.ctx, input), time);
  assert.equal((await s.read()).data.revision, after, 'replay with an evicted receipt writes no Work');
  assert.equal((await current(s, itemId)).body, '');
  assert.equal(s.tables.projectItemRetention.size, 1);
});

test('a daily sweep reads only its bounded due rows with zero records read when there are none', async t => {
  const s = await setup(t);
  t.mock.timers.enable({ apis: ['Date'], now: time });
  const meter = meterReads(s.ctx);
  const sweep = () => retention.sweep._handler(s.ctx, {});
  for (let i = 0; i < 100; i++) {
    const projectId = `future-${i}`;
    await s.ctx.db.insert('projectItemRetention', {
      projectId,
      itemId: randomUUID(),
      kind: 'attempt',
      version: 2,
      attemptAt: time + day,
    });
  }
  assert.deepEqual(await meter.cost(async () => assert.equal(await sweep(), 0)), {
    documents: 0,
    bytes: 0,
  });
  for (let i = 0; i < 15; i++)
    await s.ctx.db.insert('projectItemRetention', {
      projectId: s.projectId,
      itemId: randomUUID(),
      kind: 'attempt',
      version: 2,
      attemptAt: time,
    });
  const due = await meter.cost(async () => assert.equal(await sweep(), 10));
  assert.equal(dispatch(s).length, 10);
  assert.equal(due.documents, 10);
  assert.ok(due.bytes < 3000);
  t.diagnostic(`Due sweep reads ${due.documents} records, ${due.bytes} fixture bytes; idle reads 0.`);
  assert.equal(await sweep(), 5, 'a backlog remains eligible for the next sweep');
  assert.equal(await sweep(), 0);
});

test('an Archived or Deleted Item opens from a unique short id and preserves the full Item version', async t => {
  const { s, itemId } = await createDeleted(t, {
    status: 'closed',
    body: 'Large Item text '.repeat(2500),
  });
  const lookup = id => shelf.item._handler(s.ctx, { projectId: s.projectId, id });
  assert.deepEqual(await lookup(itemId), await lookup(itemId.slice(0, 8)));
  const deleted = JSON.parse((await lookup(itemId.slice(0, 8))).row);
  assert.equal(deleted.version, 2);
  assert.equal(
    deleted.was,
    'closed',
    'restore the status kept in the full version even when the body is large',
  );
  await write(s, itemId, 2, { status: 'archived' });
  assert.equal(JSON.parse((await lookup(itemId.slice(0, 8))).row).status, 'archived');

  const other = `${itemId.slice(0, 8)}-${randomUUID().slice(9)}`;
  await s.send(s.item({ itemId: other }));
  assert.equal(await lookup(itemId.slice(0, 8)), null);
  assert.ok((await lookup(itemId)).row, 'the complete shelved id still opens');
  assert.deepEqual(await lookup(other), { id: other, row: null });
});

test('refusals yield the next sweep to fresh Items and back off without dropping a transient failure', async t => {
  const { s, itemId } = await createDeleted(t);
  const transient = s.item();
  await s.send(transient);
  await write(s, transient.itemId, 1, { status: 'deleted' });
  const permanentlyRefused = new Set(Array.from({ length: 10 }, () => randomUUID()));
  for (const id of permanentlyRefused)
    await s.ctx.db.insert('projectItemRetention', {
      projectId: s.projectId,
      itemId: id,
      kind: 'attempt',
      version: 2,
      attemptAt: time + 30 * day - 1,
    });
  let interrupted = false;
  routePurge(s, (module, name, args) => {
    if (module !== 'projectPlanningPurge' || name !== 'run') return;
    if (permanentlyRefused.has(args.itemId)) throw new Error('The executor refused this fixture');
    if (args.itemId === transient.itemId && !interrupted) {
      interrupted = true;
      throw new Error('The executor stopped');
    }
  });
  const day0 = time + 30 * day;
  const sweep = async n => {
    t.mock.timers.setTime(day0 + n * day);
    const from = dispatch(s).length;
    await retention.sweep._handler(s.ctx, {});
    return dispatch(s).slice(from);
  };
  const refused = await sweep(0);
  assert.equal(refused.length, 10);
  for (const task of refused) {
    assert.ok(permanentlyRefused.has(task.args.itemId));
    await assert.rejects(retention.expire._handler(s.ctx, task.args), /executor refused/);
  }
  const fresh = await sweep(1);
  assert.deepEqual(fresh.map(task => task.args.itemId).sort(), [itemId, transient.itemId].sort());
  for (const task of fresh)
    if (task.args.itemId === transient.itemId)
      await assert.rejects(retention.expire._handler(s.ctx, task.args), /executor stopped/);
    else assert.equal(await retention.expire._handler(s.ctx, task.args), day0 + day);
  const retried = await sweep(2);
  assert.equal(retried.length, 10);
  for (const task of retried)
    await assert.rejects(retention.expire._handler(s.ctx, task.args), /executor refused/);
  const [retry] = await sweep(3);
  assert.equal(retry.args.itemId, transient.itemId);
  assert.equal(await retention.expire._handler(s.ctx, retry.args), day0 + 3 * day);
});

test('a full Deleted page batches deadline reads and retry writes leave its subscription alone', async t => {
  const { s } = await createDeleted(t);
  for (let i = 1; i < 51; i++) {
    const row = s.item();
    await s.send(row);
    await write(s, row.itemId, 1, { status: 'deleted' });
  }
  const dependencies = trackReadSets(s.ctx, s.tables);
  const query = s.ctx.db.query;
  let deadlineRanges = 0;
  s.ctx.db.query = table => {
    if (table === 'projectItemRetention') deadlineRanges++;
    return query(table);
  };
  const list = cursor => shelf.settledPage(s.ctx, s.projectId, 'deleted', { cursor, numItems: 50 });
  let first;
  const read = await dependencies.subscribe(async () => {
    first = await list(null);
  });
  assert.equal(first.page.length, 50);
  assert.ok(first.page.every(line => JSON.parse(line).purgeAt === time + 30 * day));
  assert.equal(deadlineRanges, 1);
  const second = await list(first.continueCursor);
  assert.equal(second.page.length, 1);
  assert.equal(JSON.parse(second.page[0]).purgeAt, time + 30 * day);
  assert.equal(deadlineRanges, 2);

  dependencies.reset();
  t.mock.timers.setTime(time + 30 * day);
  assert.equal(await retention.sweep._handler(s.ctx, {}), 10);
  assert.equal(dependencies.invalidated([read]), 0);
});

test('a completed purge from the existing executor clears an independently scheduled deadline', async t => {
  const { s, itemId } = await createDeleted(t);
  routePurge(s);
  const receipt = await modules.projectPlanningPurge.run._handler(s.ctx, {
    projectId: s.projectId,
    itemId,
    operationId: randomUUID(),
  });
  assert.equal(receipt.purgedAt, time);
  assert.equal(s.tables.projectItemRetention.size, 0);
  t.mock.timers.setTime(time + 30 * day);
  assert.equal(await retention.sweep._handler(s.ctx, {}), 0);
});
