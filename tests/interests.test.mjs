// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { state, providers } from './hosted-fixture.mjs';
const actions = await import(moduleUrl('../convex/interestActions.ts'));
const interests = await import(moduleUrl('../convex/interests.ts'));
const paginationOpts = { cursor: null, numItems: 20 };
const code = expected => error => error.data?.code === expected;
const denied = code('GITHUB_UNAVAILABLE');
const change = (
  s,
  update,
  expectedRevision = [...s.tables.projectInterests.values()].find(
    row => row.owner === 'owner' && row.importId === 'own',
  )?.revision ?? 0,
  operationId = randomUUID(),
) => actions.change._handler(s.ctx, { importId: 'own', update, expectedRevision, operationId });

test('personal stars/watches reconcile original writes and policy races, stay independent, and keep exact seen revisions without source reads or automatic work', async t => {
  const s = state(),
    cleanup = providers();
  t.after(cleanup);
  const baseline = structuredClone(s.tables.imports.get('own'));
  const operationId = randomUUID(),
    mutation = s.ctx.runMutation;
  let lose = true;
  s.ctx.runMutation = async (fn, args) => {
    const receipt = await mutation(fn, args);
    if (lose && args.update) {
      lose = false;
      throw Error('Lost committed interest reply');
    }
    return receipt;
  };
  await assert.rejects(change(s, { kind: 'star', value: true }, 0, operationId));
  const original = await change(s, { kind: 'star', value: true }, 0, operationId);
  assert.equal(s.tables.projectInterests.size, 1);
  assert.equal(s.tables.interestChanges.size, 1);
  await change(s, { kind: 'watch', value: true });
  let row = await interests.current._handler(s.ctx, { importId: 'own' });
  assert.equal(row.watching, true);
  assert.equal(row.starred, true);
  assert.equal(row.seenHead, 'a'.repeat(40));
  const normalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    new URL(url).pathname.includes('/commits/')
      ? Response.json({ sha: 'b'.repeat(40) })
      : normalFetch(url, init);
  const current = await actions.observe._handler(s.ctx, { importId: 'own' });
  assert.equal(current.head, 'b'.repeat(40));
  assert.equal(current.indexedHead, 'a'.repeat(40));
  assert.equal(
    (await interests.current._handler(s.ctx, { importId: 'own' })).seenHead,
    'a'.repeat(40),
    'Observation never silently marks a change seen.',
  );
  await change(s, { kind: 'seen', head: current.head });
  await change(s, { kind: 'star', value: false });
  assert.deepEqual(await change(s, { kind: 'star', value: true }, 0, operationId), original);
  row = await interests.current._handler(s.ctx, { importId: 'own' });
  assert.equal(row.starred, false);
  assert.equal(row.watching, true);
  assert.equal(row.seenHead, current.head);
  await assert.rejects(
    change(s, { kind: 'star', value: false }, 0, operationId),
    code('INTEREST_OPERATION_CHANGED'),
  );
  await assert.rejects(change(s, { kind: 'watch', value: false }, 0), code('INTEREST_CHANGED'));
  await change(s, { kind: 'watch', value: false });
  assert.deepEqual((await interests.list._handler(s.ctx, { paginationOpts })).page, []);
  await assert.rejects(change(s, { kind: 'seen', head: current.head }), code('BAD_ARGUMENT'));
  assert.equal(s.reads(), 0);
  assert.equal(s.scheduled.length, 0);
  assert.deepEqual(s.tables.imports.get('own'), baseline);
  assert.equal(s.tables.savedViews.size, 0);
});

test('anonymous and other-user interests are isolated; new choices/observations need current grants and both GitHub entitlements while owner metadata cleanup survives source loss', async t => {
  const s = state(),
    revoked = new Set(),
    cleanup = providers(actor => revoked.has(actor));
  t.after(cleanup);
  s.caller(undefined);
  await assert.rejects(change(s, { kind: 'star', value: true }), denied);
  assert.equal(await interests.current._handler(s.ctx, { importId: 'own' }), null);
  assert.deepEqual((await interests.list._handler(s.ctx, { paginationOpts })).page, []);
  s.caller('other');
  await assert.rejects(change(s, { kind: 'star', value: true }), denied);
  await assert.rejects(actions.observe._handler(s.ctx, { importId: 'own' }), denied);
  s.caller('owner');
  await change(s, { kind: 'star', value: true });
  await change(s, { kind: 'watch', value: true });
  s.tables.importReaders.set('reader', { _id: 'reader', importId: 'own', reader: 'reader' });
  s.caller('reader');
  await actions.change._handler(s.ctx, {
    importId: 'own',
    operationId: randomUUID(),
    expectedRevision: 0,
    update: { kind: 'watch', value: true },
  });
  assert.equal((await interests.list._handler(s.ctx, { paginationOpts })).page.length, 1);
  for (const actor of ['owner', 'reader']) {
    revoked.add(actor);
    await assert.rejects(actions.observe._handler(s.ctx, { importId: 'own' }), denied);
    await assert.rejects(
      actions.change._handler(s.ctx, {
        importId: 'own',
        operationId: randomUUID(),
        expectedRevision: 1,
        update: { kind: 'star', value: true },
      }),
      denied,
    );
    revoked.clear();
  }
  s.tables.importReaders.clear();
  await assert.rejects(actions.observe._handler(s.ctx, { importId: 'own' }), denied);
  await actions.change._handler(s.ctx, {
    importId: 'own',
    operationId: randomUUID(),
    expectedRevision: 1,
    update: { kind: 'watch', value: false },
  });
  assert.deepEqual((await interests.list._handler(s.ctx, { paginationOpts })).page, []);
  s.caller('owner');
  revoked.add('owner');
  assert.equal((await interests.list._handler(s.ctx, { paginationOpts })).page.length, 1);
  s.tables.imports.delete('own');
  await change(s, { kind: 'star', value: false });
  await change(s, { kind: 'watch', value: false });
  assert.deepEqual((await interests.list._handler(s.ctx, { paginationOpts })).page, []);
  s.caller('other');
  assert.equal(await interests.current._handler(s.ctx, { importId: 'own' }), null);
  assert.equal(s.reads(), 0);
});

test('interest provider/grant/lifecycle/ref races reject before publishing new choices or observations, while public personal metadata remains private and paginated', async t => {
  const s = state(),
    cleanup = providers();
  t.after(cleanup);
  const normalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await normalFetch(url, init);
    if (new URL(url).pathname.includes('/commits/')) s.tables.imports.get('own').removal = 'trash';
    return response;
  };
  await assert.rejects(change(s, { kind: 'watch', value: true }), denied);
  assert.equal(s.tables.projectInterests.size, 0);
  delete s.tables.imports.get('own').removal;
  globalThis.fetch = async (url, init) => {
    const response = await normalFetch(url, init);
    if (new URL(url).pathname.includes('/commits/')) s.tables.imports.get('own').ref = 'other';
    return response;
  };
  await assert.rejects(actions.observe._handler(s.ctx, { importId: 'own' }), code('INTEREST_CHANGED'));
  globalThis.fetch = normalFetch;
  const mutation = s.ctx.runMutation;
  s.tables.importReaders.set('reader', { _id: 'reader', importId: 'own', reader: 'reader' });
  s.caller('reader');
  s.ctx.runMutation = async (fn, args) => {
    s.tables.importReaders.clear();
    return mutation(fn, args);
  };
  await assert.rejects(
    actions.change._handler(s.ctx, {
      importId: 'own',
      operationId: randomUUID(),
      expectedRevision: 0,
      update: { kind: 'star', value: true },
    }),
    denied,
  );
  assert.equal(s.tables.projectInterests.size, 0);
  s.ctx.runMutation = mutation;
  cleanup();
  const publicCleanup = providers(() => false, false);
  t.after(publicCleanup);
  s.tables.imports.get('own').visibility = 'public';
  s.caller('reader');
  await actions.change._handler(s.ctx, {
    importId: 'own',
    operationId: randomUUID(),
    expectedRevision: 0,
    update: { kind: 'star', value: true },
  });
  for (let i = 0; i < 24; i++)
    await s.ctx.db.insert('projectInterests', {
      owner: 'reader',
      importId: 'synthetic-' + i,
      repository: 'public/example',
      ref: 'main',
      starred: true,
      watching: false,
      seenHead: null,
      active: true,
      revision: 1,
    });
  const first = await interests.list._handler(s.ctx, { paginationOpts });
  assert.equal(first.page.length, 20);
  assert.equal(first.isDone, false);
  const next = await interests.list._handler(s.ctx, {
    paginationOpts: { ...paginationOpts, cursor: first.continueCursor },
  });
  assert.equal(next.page.length, 5);
  s.caller(undefined);
  assert.deepEqual((await interests.list._handler(s.ctx, { paginationOpts })).page, []);
  s.caller('owner');
  assert.deepEqual((await interests.list._handler(s.ctx, { paginationOpts })).page, []);
  await assert.rejects(change(s, { kind: 'seen', head: 'invalid' }), code('BAD_ARGUMENT'));
  assert.equal(s.reads(), 0);
  assert.equal(s.scheduled.length, 0);
});
