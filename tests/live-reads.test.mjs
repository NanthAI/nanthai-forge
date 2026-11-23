// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeConvex, installHookHost } from './convex-fake.mjs';
import { moduleUrl } from './convex-module.mjs';

const host = installHookHost();
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { ConvexProvider } = await import('convex/react');

const { workIndex } = await import(moduleUrl('../web/src/hosted-work-index.ts'));
const { createLiveReads, HIDDEN_GRACE_MS, IDLE_MS } = await import(moduleUrl('../web/src/live-reads.ts'));
test.after(() => host.restore());

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

/** A child page reading the Work index the way the hosted pages do. */

const settle = async () => {
  for (let i = 0; i < 400; i++) await React.act(() => new Promise(resolve => setImmediate(resolve)));
};

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

test('switching to Flow and back replaces the tab’s live line subscription', async () => {
  const fake = fakeConvex({
    resolve: (_name, { includeChecks }) => (includeChecks === false ? {} : { checks: { runs: [] } }),
  });
  const { useLiveLine } = await import(moduleUrl('../web/src/app/use-live-line.ts'));
  let value;
  function LineReader({ flow }) {
    ({ value } = useLiveLine('p', flow));
    return null;
  }
  const root = createRoot(host.container);
  for (const flow of [false, true, false]) {
    await React.act(async () =>
      root.render(
        React.createElement(
          ConvexProvider,
          { client: fake.client },
          React.createElement(LineReader, { flow }),
        ),
      ),
    );
    assert.equal(fake.count('projectLiveLine:read'), 1);
    assert.deepEqual(value.checks, flow ? { runs: [] } : undefined);
  }
  await React.act(async () => root.unmount());
});

test('the live line stays available when the web deploy reaches an older Convex validator first', async () => {
  const latest = { lanes: [], more: 0, main: null, exit: null, checks: { runs: [] } };
  const fake = fakeConvex({
    resolve: (_name, args) => {
      if ('includeChecks' in args)
        throw new Error('ArgumentValidationError: Object contains extra field `includeChecks`');
      return latest;
    },
  });
  const { useLiveLine } = await import(moduleUrl('../web/src/app/use-live-line.ts'));
  let result;
  function LineReader() {
    result = useLiveLine('p');
    return null;
  }
  const root = createRoot(host.container);
  await React.act(async () =>
    root.render(
      React.createElement(ConvexProvider, { client: fake.client }, React.createElement(LineReader)),
    ),
  );
  await settle();
  assert.deepEqual(result, { value: latest, error: undefined });
  assert.equal(fake.count('projectLiveLine:read'), 1);
  assert.equal(fake.stats.executions, 2, 'one rejected attempt and one compatible subscription');
  await React.act(async () => root.unmount());
});

// Exact spike's named regression: return after the tab was already idle/asleep.
test('return-after-idle: a visible return wakes the live line exactly once with current state', async t => {
  let latest = { lanes: [], more: 0, main: null, exit: null };
  const fake = fakeConvex({ resolve: name => (name === 'projectLiveLine:read' ? latest : null) });
  const reads = createLiveReads();
  const { useLiveLine } = await import(moduleUrl('../web/src/app/use-live-line.ts'));
  let value;
  function LineReader() {
    ({ value } = useLiveLine('p'));
    return null;
  }
  const root = createRoot(host.container);
  await React.act(async () =>
    root.render(
      React.createElement(
        ConvexProvider,
        { client: reads.client(fake.client) },
        React.createElement(LineReader),
      ),
    ),
  );
  await settle();
  assert.equal(fake.count(), 1);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const window = new EventTarget();
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const stop = reads.watchActivity(window, page);
  for (const alreadyIdle of [false, true]) {
    if (alreadyIdle) {
      t.mock.timers.tick(IDLE_MS);
      assert.equal(fake.count(), 0);
    }
    page.visibilityState = 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
    t.mock.timers.tick(HIDDEN_GRACE_MS);
    assert.equal(fake.count(), 0);
    const old = value;
    fake.reset();
    latest = {
      ...latest,
      lanes: [
        {
          laneId: 'current',
          stage: alreadyIdle ? 'ready' : 'checking',
          held: false,
          overlap: false,
          changedAt: 1,
        },
      ],
    };
    fake.invalidate();
    assert.equal(fake.stats.executions, 0, 'a stage change after hidden grace does no read');
    assert.deepEqual(value, old);
    page.visibilityState = 'visible';
    await React.act(async () => page.dispatchEvent(new Event('visibilitychange')));
    await settle();
    assert.equal(fake.count(), 1);
    assert.equal(fake.stats.adds, 1, 'one catch-up after a hidden interval, including an already idle tab');
    assert.equal(fake.stats.executions, 1);
    assert.deepEqual(value, latest, 'one catch-up shows the current version, without replay');
    window.dispatchEvent(new Event('focus'));
    assert.equal(fake.stats.adds, 1, 'focus after visibility never duplicates the catch-up');
  }
  stop();
  await React.act(async () => root.unmount());
  assert.equal(fake.count(), 0);
});
