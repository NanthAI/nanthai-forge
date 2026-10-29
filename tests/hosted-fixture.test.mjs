// SPDX-License-Identifier: Apache-2.0
// The hosted fake must keep the provider rules that hosted code relies on, or a
// handler bug passes here and fails against the real backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFunctionReference } from 'convex/server';
import { state } from './hosted-fixture.mjs';

const scheduledRef = makeFunctionReference('projectActorNames:remember');
const scheduledArgs = { projectId: 'project', reader: 'owner', labels: [] };

const project = (owner, key) => ({ owner, key, name: key, currentBackup: null, revision: 0 });

test('unique() rejects several matches instead of returning the first', async () => {
  const { ctx } = state([]);
  await ctx.db.insert('hostedProjects', project('owner', 'a'));
  const byKey = () =>
    ctx.db
      .query('hostedProjects')
      .withIndex('by_owner_and_key', q => q.eq('owner', 'owner').eq('key', 'a'))
      .unique();
  assert.equal((await byKey()).key, 'a');
  await ctx.db.insert('hostedProjects', project('owner', 'a'));
  await assert.rejects(byKey, /unique\(\) on hostedProjects matched 2 documents/);
});

test('indexes and range order come from convex/schema.ts', async () => {
  const { ctx } = state([]);
  const query = build => ctx.db.query('hostedProjects').withIndex('by_owner_and_key', build).take(1);
  assert.throws(
    () => ctx.db.query('hostedProjects').withIndex('by_owner_and_name', q => q.eq('owner', 'owner')),
    /Index hostedProjects.by_owner_and_name is not defined/,
  );
  assert.throws(() => query(q => q.eq('key', 'a')), /Invalid range/);
  assert.throws(() => query(q => q.gt('owner', 'a').eq('key', 'b')), /Invalid range/);
  assert.throws(() => query(q => q.gt('owner', 'a').gte('owner', 'b')), /Invalid range/);
  assert.deepEqual(await query(q => q.eq('owner', 'owner').gte('key', 'a').lt('key', 'b')), []);

  // "project" in the index name is actually the projectId schema field.
  for (const actor of ['c', 'a', 'b'])
    await ctx.db.insert('projectActorNames', { projectId: 'project', actor, displayName: actor });
  const actors = await ctx.db
    .query('projectActorNames')
    .withIndex('by_project_and_actor', q => q.eq('projectId', 'project').gte('actor', 'b').lt('actor', 'd'))
    .take(10);
  assert.deepEqual(
    actors.map(row => row.actor),
    ['b', 'c'],
  );
});

test('a failed mutation leaves no writes or scheduled work behind', async () => {
  const s = state([]),
    { ctx } = s,
    kept = await ctx.db.insert('hostedProjects', project('owner', 'kept'));
  await assert.rejects(
    s.transaction(async () => {
      await ctx.db.insert('hostedProjects', project('owner', 'new'));
      await ctx.db.patch(kept, { name: 'changed' });
      await ctx.scheduler.runAfter(0, scheduledRef, scheduledArgs);
      throw new Error('fails after writing');
    }),
    /fails after writing/,
  );
  assert.deepEqual(
    [...s.tables.hostedProjects.values()].map(row => [row.key, row.name]),
    [['kept', 'kept']],
  );
  assert.deepEqual([s.scheduled.length, s.tasks.size], [0, 0]);

  // A caught nested failure undoes only its own writes; the outer mutation commits.
  await s.transaction(async () => {
    await ctx.db.patch(kept, { name: 'outer' });
    await s
      .transaction(async () => {
        await ctx.db.delete(kept);
        throw new Error('inner');
      })
      .catch(() => {});
  });
  assert.equal((await ctx.db.get(kept)).name, 'outer');
});

test('a successful nested mutation is undone when the outer transaction fails', async () => {
  const s = state([]),
    { ctx } = s,
    kept = await ctx.db.insert('hostedProjects', project('owner', 'kept')),
    task = await ctx.scheduler.runAt(100, scheduledRef, scheduledArgs),
    before = await ctx.db.get(kept);
  await assert.rejects(
    s.transaction(async () => {
      await s.transaction(async () => {
        await ctx.db.replace(kept, project('owner', 'replacement'));
        await ctx.scheduler.cancel(task);
        await ctx.scheduler.runAt(200, scheduledRef, scheduledArgs);
      });
      await ctx.db.delete(kept);
      throw new Error('outer failed');
    }),
    /outer failed/,
  );
  assert.deepEqual(await ctx.db.get(kept), before);
  assert.deepEqual([...s.tasks], [[task, { state: { kind: 'pending' } }]]);
  assert.equal(s.scheduled.length, 1);
});

test('runMutation rolls back a real handler that writes before rejecting', async () => {
  const s = state([]),
    projectId = await s.ctx.db.insert('hostedProjects', project('owner', 'example')),
    remember = makeFunctionReference('projectActorNames:remember'),
    input = labels => ({ projectId, reader: 'owner', labels });
  await assert.rejects(
    s.ctx.runMutation(
      remember,
      input([
        { actor: 'owner', displayName: 'Changed before failure' },
        { actor: 'unknown', displayName: 'Not visible' },
      ]),
    ),
    error => error.code === 'PROJECT_UNAVAILABLE',
  );
  assert.equal(s.tables.projectActorNames.size, 0);
  await s.ctx.runMutation(remember, input([{ actor: 'owner', displayName: 'Committed' }]));
  assert.equal([...s.tables.projectActorNames.values()][0].displayName, 'Committed');
});

test('query results stay ordered and detached when only returned pages are cloned', async () => {
  for (const keysetPaging of [false, true]) {
    const { ctx } = state([], { keysetPaging });
    for (const key of ['c', 'a', 'b'])
      await ctx.db.insert('hostedProjects', {
        ...project('owner', key),
        nameChange: { operationId: key, expectedRevision: 0, name: key },
      });
    const query = () =>
      ctx.db.query('hostedProjects').withIndex('by_owner_and_key', q => q.eq('owner', 'owner'));
    const taken = await query().order('desc').take(1);
    assert.deepEqual(
      taken.map(row => row.key),
      ['c'],
    );
    taken[0].nameChange.name = 'changed';
    const first = await query().paginate({ cursor: null, numItems: 2 });
    assert.deepEqual(
      first.page.map(row => row.key),
      ['a', 'b'],
    );
    assert.equal(first.isDone, false);
    first.page[0].nameChange.name = 'changed';
    const last = await query().paginate({ cursor: first.continueCursor, numItems: 2 });
    assert.deepEqual(
      last.page.map(row => row.key),
      ['c'],
    );
    assert.equal(last.isDone, true);
    const unique = await ctx.db
      .query('hostedProjects')
      .withIndex('by_owner_and_key', q => q.eq('owner', 'owner').eq('key', 'b'))
      .unique();
    unique.nameChange.name = 'changed';
    for await (const row of query()) {
      assert.equal(row.nameChange.name, row.key);
      row.nameChange.name = 'changed';
    }
    assert.deepEqual(
      (await query().take(3)).map(row => row.nameChange.name),
      ['a', 'b', 'c'],
    );
  }
});
