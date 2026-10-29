// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fakeConvex, installHookHost } from './convex-fake.mjs';
import { moduleUrl } from './convex-module.mjs';

const host = installHookHost();
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { ConvexProvider, useQuery } = await import('convex/react');
const { HostedAttention } = await import(moduleUrl('../web/src/shell/Attention.tsx'));
const { useWorkRecords, workIndex } = await import(moduleUrl('../web/src/hosted-work-index.ts'));
const { createLiveReads, HIDDEN_GRACE_MS, IDLE_MS } = await import(moduleUrl('../web/src/live-reads.ts'));
test.after(() => host.restore());

// Synthetic volumes shaped like a busy project (hundreds of Views and runs).
const sizes = { intents: 600, lanes: 560, views: 2200, runs: 1500, channelMoves: 575, hostedChannels: 25 };
const summaries = ['intents', 'lanes', 'views', 'runs', 'channelMoves'];
const workspace = JSON.stringify({
  generationId: 'g1',
  revision: 1,
  backupId: 'b',
  backupDigest: 'd',
  sourceHead: 'h',
  key: 'k',
  name: 'Synthetic',
  actor: 'user_a',
  counts: {},
  capabilities: { recentSummaryPages: true, owner: true, editableIntentIds: [], sourceReturn: false },
});
function backend() {
  const collections = Object.fromEntries(
    Object.entries(sizes).map(([name, count]) => [
      name,
      Array.from({ length: count }, (_, position) => ({
        id: `${name}-${position}`,
        position,
        value: JSON.stringify({ id: `${name}-${position}`, name: `${name} ${position}` }),
      })),
    ]),
  );
  return fakeConvex({
    collections,
    resolve: (name, args) => {
      if (name === 'projectWorkIndex:workspace') return workspace;
      if (args.paginationOpts) return { page: [], isDone: true, continueCursor: '' };
      if (name.endsWith(':unacked')) return { items: [], complete: true };
      if (name.endsWith(':claims')) return { claims: [] };
      return null;
    },
  });
}
/** A child page reading the Work index the way the hosted pages do. */
const reader = (collections, seen) =>
  function Reader() {
    const raw = useQuery(workIndex.workspace, { projectId: 'p' });
    const parsed = React.useMemo(() => (raw ? JSON.parse(raw) : null), [raw]);
    for (const collection of collections) {
      const result = useWorkRecords('p', parsed, collection);
      if (seen) seen[collection] = result.records.length;
    }
    return null;
  };
// Now: the frame plus the Channel strip. Work › Lanes adds planning, Views, runs and moves again.
const pages = {
  now: [reader(['hostedChannels', 'channelMoves', 'channels', 'runs'])],
  lanes: [
    reader(['hostedChannels', 'channelMoves', 'channels', 'runs']),
    reader(['views', 'runs', 'channelMoves']),
    reader(['intents', 'channels', 'hostedChannels']),
  ],
};
const settle = async () => {
  for (let i = 0; i < 400; i++) await React.act(() => new Promise(resolve => setImmediate(resolve)));
};
async function mount(fake, children, client = fake.client) {
  let rerender;
  function App() {
    const [count, setCount] = React.useState(0);
    rerender = () => setCount(count + 1);
    return React.createElement(
      HostedAttention,
      { projectId: 'p' },
      ...children.map((child, index) => React.createElement(child, { key: index })),
    );
  }
  const root = createRoot(host.container);
  await React.act(async () =>
    root.render(React.createElement(ConvexProvider, { client }, React.createElement(App))),
  );
  await settle();
  return { root, rerender: () => rerender() };
}
const pagesFor = count => Math.max(1, Math.ceil(count / 100));
const ranges = fake =>
  [...fake.live.values()]
    .filter(entry => entry.name === 'projectWorkIndex:records')
    .map(entry => `${entry.args.collection}:${entry.args.paginationOpts.cursor}`);

for (const [name, children] of Object.entries(pages))
  test(`${name} page holds a fixed set of subscriptions across re-renders, with no duplicate or split pages`, async () => {
    const fake = backend();
    const { root, rerender } = await mount(fake, children);
    const live = fake.count();
    for (const collection of summaries)
      assert.equal(
        ranges(fake).filter(range => range.startsWith(`${collection}:`)).length,
        pagesFor(sizes[collection]),
        `${collection} is paged once, without client page splits`,
      );
    assert.equal(new Set(ranges(fake)).size, ranges(fake).length, 'no two subscriptions read the same page');
    assert.equal(fake.stats.adds - fake.stats.removes, live);
    fake.reset();
    for (let i = 0; i < 50; i++) {
      await React.act(async () => rerender());
      await settle();
    }
    assert.deepEqual({ adds: fake.stats.adds, removes: fake.stats.removes }, { adds: 0, removes: 0 });
    assert.equal(fake.count(), live);
    fake.invalidate();
    await settle();
    assert.equal(fake.stats.adds, 0, 'a server-side rerun never re-subscribes');
    assert.equal(fake.stats.executions, live);
    await React.act(async () => root.unmount());
    assert.equal(fake.count(), 0);
  });

test('asleep holds zero subscriptions and keeps values; waking subscribes each read once', async () => {
  const fake = backend(),
    reads = createLiveReads(),
    seen = {};
  const { root } = await mount(fake, [reader(['views', 'hostedChannels'], seen)], reads.client(fake.client));
  const live = fake.count();
  assert.ok(live > 20);
  assert.equal(reads.subscriptions, live);
  assert.deepEqual(seen, { views: sizes.views, hostedChannels: sizes.hostedChannels });
  fake.reset();
  await React.act(async () => reads.sleep());
  await settle();
  assert.equal(fake.count(), 0, 'no Convex subscription while asleep');
  assert.equal(reads.subscriptions, 0);
  assert.deepEqual(
    seen,
    { views: sizes.views, hostedChannels: sizes.hostedChannels },
    'mounted pages keep their last values',
  );
  assert.equal(fake.stats.adds, 0);
  await React.act(async () => reads.wake());
  await settle();
  assert.equal(fake.count(), live);
  assert.equal(fake.stats.adds, live, 'each mounted read subscribes exactly once on wake');
  assert.equal(fake.stats.executions, live, 'one fresh read per subscription, no pagination restart');
  assert.deepEqual(seen, { views: sizes.views, hostedChannels: sizes.hostedChannels });
  await React.act(async () => root.unmount());
  assert.equal(reads.subscriptions, 0);
});

test('one-shot queries, mutations and actions pass through while asleep', async () => {
  const calls = [];
  const real = {
    watchQuery: () => ({ onUpdate: () => () => {}, localQueryResult: () => 1 }),
    watchPaginatedQuery: () => ({ onUpdate: () => () => {}, localQueryResult: () => 1 }),
    query(...args) {
      calls.push(['query', this === real, args.length]);
      return Promise.resolve('fresh');
    },
    mutation(...args) {
      calls.push(['mutation', this === real, args.length]);
      return Promise.resolve(null);
    },
  };
  const reads = createLiveReads();
  const client = reads.client(real);
  reads.sleep();
  assert.equal(await client.query(workIndex.workspace, { projectId: 'p' }), 'fresh');
  await client.mutation(workIndex.workspace, {});
  assert.deepEqual(calls, [
    ['query', true, 2],
    ['mutation', true, 2],
  ]);
});

test('hidden tabs sleep after the grace period, idle tabs after IDLE_MS, and input wakes them', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const reads = createLiveReads(),
    window = new EventTarget(),
    page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const stop = reads.watchActivity(window, page);
  const visibility = state => {
    page.visibilityState = state;
    page.dispatchEvent(new Event('visibilitychange'));
  };
  assert.equal(reads.dormant, false);
  visibility('hidden');
  t.mock.timers.tick(HIDDEN_GRACE_MS - 1);
  assert.equal(reads.dormant, false, 'a quick tab switch keeps live reads');
  t.mock.timers.tick(1);
  assert.equal(reads.dormant, true);
  window.dispatchEvent(new Event('pointermove'));
  assert.equal(reads.dormant, true, 'input in a hidden tab does not wake it');
  visibility('visible');
  assert.equal(reads.dormant, false);
  t.mock.timers.tick(IDLE_MS - 1000);
  window.dispatchEvent(new Event('keydown'));
  t.mock.timers.tick(IDLE_MS - 1);
  assert.equal(reads.dormant, false, 'input restarts the idle window');
  t.mock.timers.tick(1);
  assert.equal(reads.dormant, true);
  window.dispatchEvent(new Event('pointerdown'));
  assert.equal(reads.dormant, false);
  stop();
  t.mock.timers.tick(IDLE_MS * 2);
  assert.equal(reads.dormant, false, 'stopping removes the pending timeout');
});

test('web code never polls Convex reads on an interval', () => {
  const files = [];
  const walk = directory => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) files.push(path);
    }
  };
  walk(new URL('../web/src', import.meta.url).pathname);
  const intervals = files.filter(file => /setInterval\(/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(
    intervals.map(file => file.slice(file.indexOf('web/src/'))),
    ['web/src/shell/StatusBar.tsx'],
    'only useNow ticks, and it stands still while live reads are asleep',
  );
  const statusBar = readFileSync(new URL('../web/src/shell/StatusBar.tsx', import.meta.url), 'utf8');
  assert.match(statusBar, /if \(asleep\) \{/);
});
