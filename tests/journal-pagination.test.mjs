// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeConvex, installHookHost } from './convex-fake.mjs';
import { moduleUrl } from './convex-module.mjs';
import { makeFunctionReference, getFunctionName } from 'convex/server';
const host = installHookHost();
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { ConvexProvider } = await import('convex/react');
const { useArchivePaginatedQuery } = await import(moduleUrl('../web/src/archive-pagination.ts'));
const ref = makeFunctionReference('projectCoordination:recent');
test.after(() => host.restore());
const settle = async () => {
  for (let i = 0; i < 30; i++) await React.act(() => new Promise(resolve => setImmediate(resolve)));
};

test('archive pagination preserves live pages, hydrates each cold page once and hides previous viewer data during reauthorization', async () => {
  let view = 'writer',
    resolveRead,
    actions = 0;
  const fake = fakeConvex({
    resolve: (_name, args) =>
      args.paginationOpts.cursor === null
        ? { page: [{ id: 'live' }], isDone: false, continueCursor: 'cold' }
        : { page: [], isDone: false, continueCursor: 'cold', journalHistory: true, viewVersion: view },
  });
  fake.client.action = async (reference, args) => {
    assert.equal(getFunctionName(reference), 'projectJournalCoordination:history');
    assert.equal(args.query, 'projectCoordination:recent');
    actions++;
    return new Promise(resolve => {
      resolveRead = () =>
        resolve(JSON.stringify({ page: [{ id: view }], isDone: true, continueCursor: 'done' }));
    });
  };
  let seen;
  function Page() {
    seen = useArchivePaginatedQuery(ref, { projectId: 'p' }, { initialNumItems: 1 });
    return null;
  }
  const root = createRoot(host.container);
  await React.act(async () =>
    root.render(React.createElement(ConvexProvider, { client: fake.client }, React.createElement(Page))),
  );
  await settle();
  assert.deepEqual(seen.results, [{ id: 'live' }]);
  assert.equal(actions, 0);
  await React.act(async () => seen.loadMore(1));
  await settle();
  assert.equal(actions, 1);
  assert.equal(seen.status, 'LoadingMore');
  await React.act(async () => resolveRead());
  await settle();
  assert.deepEqual(seen.results, [{ id: 'live' }, { id: 'writer' }]);
  assert.equal(seen.status, 'Exhausted');
  fake.reset();
  await settle();
  assert.equal(fake.stats.adds + fake.stats.executions, 0);
  assert.equal(actions, 1, 'idle never rehydrates');
  view = 'reader';
  await React.act(async () => fake.invalidate());
  await settle();
  assert.deepEqual(
    seen.results,
    [{ id: 'live' }],
    'previous viewer history disappears before the next GET resolves',
  );
  assert.equal(actions, 2);
  await React.act(async () => resolveRead());
  await settle();
  assert.deepEqual(seen.results, [{ id: 'live' }, { id: 'reader' }]);
  await React.act(async () => root.unmount());
});

test('archive pagination surfaces refused actions without showing a successful empty history', async () => {
  const fake = fakeConvex({
    resolve: () => ({ page: [], isDone: false, continueCursor: '', journalHistory: true, viewVersion: 'a' }),
  });
  let rejectRead, seen;
  fake.client.action = () =>
    new Promise((_resolve, reject) => {
      rejectRead = reject;
    });
  function Page() {
    seen = useArchivePaginatedQuery(ref, { projectId: 'p' }, { initialNumItems: 1 });
    return null;
  }
  const root = createRoot(host.container);
  await React.act(async () =>
    root.render(React.createElement(ConvexProvider, { client: fake.client }, React.createElement(Page))),
  );
  await settle();
  await React.act(async () => rejectRead(new Error('Current access revoked')));
  await settle();
  assert.equal(seen.status, 'Error');
  assert.equal(seen.results.length, 0);
  await React.act(async () => root.unmount());
});
