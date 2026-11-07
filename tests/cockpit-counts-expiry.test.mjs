// SPDX-License-Identifier: Apache-2.0
// The cockpit's live coordination drops its counts (unknown) at nextExpiryAt from one local timer,
// with no further Convex call while idle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeConvex, installHookHost } from './convex-fake.mjs';
import { moduleUrl } from './convex-module.mjs';

const host = installHookHost();
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { ConvexProvider } = await import('convex/react');
const { useCoordination } = await import(moduleUrl('../web/src/cockpit/coordination.ts'));
test.after(() => host.restore());

const START = 1_800_000_000_000;
const counts = nextExpiryAt => ({
  activeAgents: 2,
  activeSubagents: 0,
  activePeople: 0,
  activeLanes: 1,
  unannouncedActiveLanes: 0,
  ...(nextExpiryAt === undefined ? {} : { nextExpiryAt }),
});
function backend(value) {
  return fakeConvex({
    resolve: (name, args) => {
      if (name === 'projectCoordination:counts') return value;
      if (args.paginationOpts) return { page: [], isDone: true, continueCursor: '' };
      if (name.endsWith(':unacked')) return { items: [], complete: true };
      if (name.endsWith(':claims')) return { claims: [], complete: true };
      if (name.endsWith('OverlapAcks:now'))
        return JSON.stringify({
          answered: {},
          mine: [],
          complete: true,
          signals: { edits: [], notices: [], behindMain: [], complete: true },
        });
      return null;
    },
  });
}
const settle = async () => {
  for (let i = 0; i < 50; i++) await React.act(() => new Promise(resolve => setImmediate(resolve)));
};
async function mount(fake) {
  const seen = { live: undefined };
  function Page() {
    seen.live = useCoordination('p');
    return null;
  }
  const root = createRoot(host.container);
  await React.act(async () =>
    root.render(React.createElement(ConvexProvider, { client: fake.client }, React.createElement(Page))),
  );
  await settle();
  return { root, seen };
}

test('cockpit counts show while the window is open and are unknown after nextExpiryAt, with 0 calls idle', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const fake = backend(counts(START + 600_000));
  const { root, seen } = await mount(fake);
  assert.equal(seen.live.counts?.activeAgents, 2, 'counted while the window is open');
  fake.reset();
  await React.act(async () => t.mock.timers.tick(599_999));
  assert.equal(seen.live.counts?.activeAgents, 2, 'still counted just before the window ends');
  await React.act(async () => t.mock.timers.tick(1));
  assert.equal(seen.live.counts, undefined, 'unknown once the window ends');
  assert.deepEqual(seen.live.unavailable, [], 'expiry is not an outage');
  await React.act(async () => t.mock.timers.tick(3_600_000));
  assert.equal(fake.stats.adds + fake.stats.executions, 0, 'no query, poll or refresh after the expiry');
  await React.act(async () => root.unmount());
});

test('counts with no window to expire stay, and unmounting cancels the timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const fake = backend(counts());
  const mounted = await mount(fake);
  await React.act(async () => t.mock.timers.tick(86_400_000));
  assert.equal(mounted.seen.live.counts?.activeAgents, 2);
  await React.act(async () => mounted.root.unmount());
  const timed = backend(counts(START + 86_400_000 + 60_000));
  const second = await mount(timed);
  await React.act(async () => second.root.unmount());
  timed.reset();
  await React.act(async () => t.mock.timers.tick(120_000));
  assert.equal(timed.stats.adds + timed.stats.executions, 0, 'a cancelled timer causes no call');
});
