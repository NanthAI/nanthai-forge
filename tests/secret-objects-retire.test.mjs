// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The one-off purge of retired Secret Objects (Item 41a0df87, slice 6): a dry run lists objects by name and writes
// nothing, apply refuses until the owner has reviewed that list, it deletes children before parents in bounded pages,
// a replay finds nothing, and the retired state other rows still carry (fields, the leave kind, a close phase, items
// of a deleted object) is cleared without touching anything else. A small in-memory database stands in for Convex,
// so this test loads no hosted fixture. Synthetic rows only.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const retire = await import(moduleUrl('../convex/secretObjectsRetire.ts'));
const code = expected => error => (error.code ?? error.data?.code) === expected;
const SIZES = { secretEvents: 4, secretGrants: 3, secretVersions: 2, secretDeletions: 1, secretObjects: 2 };

/** Just the database calls the purge makes: paginate (by row count), get, patch (undefined removes a field), delete. */
function database(tables) {
  const find = id =>
    Object.values(tables)
      .find(rows => rows.has(id))
      ?.get(id) ?? null;
  return {
    query: table => ({
      take: async n => [...tables[table].values()].slice(0, n),
      paginate: async ({ numItems, cursor }) => {
        const all = [...tables[table].values()];
        const start = cursor === null ? 0 : Number(cursor);
        const page = all.slice(start, start + numItems);
        const end = start + page.length;
        return { page, isDone: end >= all.length, continueCursor: String(end) };
      },
    }),
    normalizeId: (table, id) => (tables[table]?.has(id) ? id : null),
    get: async id => find(id),
    patch: async (id, fields) => {
      const row = find(id);
      for (const [name, value] of Object.entries(fields)) {
        if (value === undefined) delete row[name];
        else row[name] = value;
      }
    },
    delete: async id => {
      for (const rows of Object.values(tables)) rows.delete(id);
    },
  };
}
const empty = () =>
  Object.fromEntries(
    [...Object.keys(SIZES), 'agentGrants', 'forgeAccounts', 'accountOperations', 'accountItems'].map(name => [
      name,
      new Map(),
    ]),
  );
function bare() {
  const tables = empty();
  return { tables, ctx: { db: database(tables) } };
}
function world() {
  const w = bare();
  for (const [table, n] of Object.entries(SIZES))
    for (let i = 0; i < n; i++)
      w.tables[table].set(`${table}-${i}`, {
        _id: `${table}-${i}`,
        _creationTime: i + 1,
        ...(table === 'secretObjects'
          ? {
              name: `QA object ${i}`,
              repository: 'example/synthetic',
              ref: 'main',
              version: 1,
              owner: 'secret-owner',
            }
          : {}),
      });
  return w;
}
const total = tables => Object.keys(SIZES).reduce((n, table) => n + tables[table].size, 0);
const purge = (w, args) => retire.purgeRows._handler(w.ctx, args);
const clear = (w, args) => retire.clearFields._handler(w.ctx, args);

test('a dry run counts what it would delete, lists objects by name only and writes nothing', async () => {
  const w = world();
  const dry = await purge(w, { apply: false });
  assert.deepEqual(dry.counted, SIZES);
  assert.equal(dry.deleted, 0);
  assert.equal(dry.more, false);
  assert.deepEqual(
    dry.objects.map(o => [o.name, o.repository, o.ref, o.version]),
    [0, 1].map(i => [`QA object ${i}`, 'example/synthetic', 'main', 1]),
  );
  assert.ok(!JSON.stringify(dry).includes('secret-owner'), 'no owner is shown');
  assert.equal(total(w.tables), 12);
});

test('a dry run lists the objects even when events fill the page budget', async () => {
  const w = world();
  const dry = await purge(w, { apply: false, limit: 3 });
  assert.equal(dry.counted.secretEvents, 3);
  assert.equal(dry.counted.secretObjects, 0, 'the page budget ended before the objects');
  assert.equal(dry.objects.length, 2);
  assert.equal(dry.more, true);
});

test('apply refuses until the owner has reviewed the object list, and deletes nothing', async () => {
  const w = world();
  await assert.rejects(purge(w, { apply: true }), code('BAD_ARGUMENT'));
  await assert.rejects(purge(w, { apply: true, reviewed: false }), code('BAD_ARGUMENT'));
  assert.equal(total(w.tables), 12);
});

test('apply deletes children before parents in pages of at most the limit, and a replay finds nothing', async () => {
  const w = world();
  const first = await purge(w, { apply: true, reviewed: true, limit: 5 });
  assert.equal(first.deleted, 5);
  assert.equal(first.more, true);
  // Events go first, then grants: no object or version is touched while a child remains.
  assert.equal(w.tables.secretEvents.size, 0);
  assert.equal(w.tables.secretGrants.size, 2);
  assert.equal(w.tables.secretObjects.size, 2);
  let pages = 1;
  for (let page = first; page.more; pages++) page = await purge(w, { apply: true, reviewed: true, limit: 5 });
  assert.equal(pages, 3);
  assert.equal(total(w.tables), 0);
  assert.deepEqual(await purge(w, { apply: true, reviewed: true }), {
    counted: { secretEvents: 0, secretGrants: 0, secretVersions: 0, secretDeletions: 0, secretObjects: 0 },
    objects: [],
    deleted: 0,
    more: false,
  });
});

test('a limit outside 1 to 100 is refused before anything is read', async () => {
  const w = world();
  for (const limit of [0, 101, 1.5])
    await assert.rejects(purge(w, { apply: true, reviewed: true, limit }), code('BAD_ARGUMENT'));
  assert.equal(total(w.tables), 12);
});

test('retired fields are cleared from the rows that hold them, and nothing else changes', async () => {
  const w = bare();
  w.tables.forgeAccounts.set('a1', {
    _id: 'a1',
    owner: 'owner',
    handle: 'sample',
    secretsReview: { epoch: 5, operationId: 'op' },
    secretsLeftBelow: 3,
    secretsLeftBefore: 4,
  });
  w.tables.forgeAccounts.set('a2', { _id: 'a2', owner: 'other', handle: 'plain' });
  w.tables.agentGrants.set('g1', { _id: 'g1', name: 'agent', sealed: { ciphertext: 'x' } });
  const dry = await clear(w, { table: 'forgeAccounts', apply: false });
  assert.deepEqual(dry, { scanned: 2, holding: 1, cleared: 0, next: null });
  assert.equal(w.tables.forgeAccounts.get('a1').secretsLeftBelow, 3);
  assert.deepEqual(await clear(w, { table: 'forgeAccounts', apply: true }), {
    scanned: 2,
    holding: 1,
    cleared: 1,
    next: null,
  });
  assert.deepEqual(Object.keys(w.tables.forgeAccounts.get('a1')).sort(), ['_id', 'handle', 'owner']);
  assert.deepEqual(await clear(w, { table: 'forgeAccounts', apply: true }), {
    scanned: 2,
    holding: 0,
    cleared: 0,
    next: null,
  });
  assert.equal((await clear(w, { table: 'agentGrants', apply: true })).cleared, 1);
  assert.equal(w.tables.agentGrants.get('g1').sealed, undefined);
  assert.equal(w.tables.agentGrants.get('g1').name, 'agent');
});

test('clearing pages by the limit and hands back where to continue', async () => {
  const w = bare();
  for (let i = 0; i < 3; i++)
    w.tables.accountOperations.set(`op${i}`, { _id: `op${i}`, leave: [], captured: [], secretsBelow: i + 1 });
  const seen = [];
  let after = null;
  do {
    const page = await clear(w, { table: 'accountOperations', apply: true, limit: 2, after });
    seen.push(page.cleared);
    after = page.next;
  } while (after !== null);
  assert.deepEqual(seen, [2, 1]);
  assert.ok([...w.tables.accountOperations.values()].every(op => op.secretsBelow === undefined));
});

test('retired state in account rows is cleared: the leave kind, a close phase, and items of a deleted object', async () => {
  const w = bare();
  w.tables.accountOperations.set('01', {
    _id: '01',
    leave: ['teams', 'secrets'],
    captured: ['teams', 'secrets'],
    stage: 'running',
    pending: 2,
  });
  const item = (id, kind, state, extra = {}) =>
    w.tables.accountItems.set(id, { _id: id, accountId: '01', kind, state, ...extra });
  item('11', 'secret', 'started', { expected: { version: 1, policyRevision: 2, archiveRevision: 0 } });
  item('12', 'team', 'pending');
  w.tables.forgeAccounts.set('a1', {
    _id: 'a1',
    handle: 'sample',
    closing: { operationId: 'c', at: 1, below: 9, phase: 'secrets', cursor: 'x' },
  });
  assert.equal((await clear(w, { table: 'accountOperations', apply: true })).cleared, 1);
  assert.deepEqual(w.tables.accountOperations.get('01').leave, ['teams']);
  assert.deepEqual(w.tables.accountOperations.get('01').captured, ['teams']);
  assert.equal((await clear(w, { table: 'accountItems', apply: true })).holding, 1, 'only the retired item');
  assert.equal(w.tables.accountItems.get('11').state, 'completed');
  assert.equal(w.tables.accountItems.get('11').expected, undefined);
  assert.equal(w.tables.accountItems.get('12').state, 'pending', 'a live item is untouched');
  assert.equal(
    w.tables.accountOperations.get('01').pending,
    1,
    'the receipt stops waiting on the retired item',
  );
  await clear(w, { table: 'forgeAccounts', apply: true });
  assert.deepEqual(w.tables.forgeAccounts.get('a1').closing, {
    operationId: 'c',
    at: 1,
    phase: 'receipts',
    cursor: null,
  });
  // The last open retired item ends the receipt: nothing waits, so closing the account is not blocked by it.
  w.tables.accountItems.get('12').kind = 'secrets';
  await clear(w, { table: 'accountItems', apply: true });
  assert.equal(w.tables.accountOperations.get('01').pending, 0);
  assert.equal(w.tables.accountOperations.get('01').stage, 'completed');
});
