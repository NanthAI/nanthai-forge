// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConvexError } from 'convex/values';
import { fakeConvex, installHookHost } from './convex-fake.mjs';
import { moduleUrl } from './convex-module.mjs';

const host = installHookHost();
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { ConvexProvider } = await import('convex/react');
const { HostedAttention } = await import(moduleUrl('../web/src/shell/Attention.tsx'));
const { useCoordination } = await import(moduleUrl('../web/src/cockpit/coordination.ts'));
test.after(() => host.restore());

const workspace = JSON.stringify({
  generationId: 'g1',
  revision: 1,
  backupId: 'b',
  backupDigest: 'd',
  sourceHead: 'h',
  key: 'k',
  name: 'Synthetic',
  actor: 'reader',
  counts: {},
  capabilities: { recentSummaryPages: true, owner: false, editableIntentIds: [], sourceReturn: false },
});
const refused = () =>
  new ConvexError({ code: 'PROJECT_UNAVAILABLE', message: 'Contributor access is required.' });
// A reader on the hosted pages: the sub-reads in `failing` are refused or fail, the rest answer.
function backend(failing = []) {
  return fakeConvex({
    resolve: (name, args) => {
      if (failing.some(suffix => name.endsWith(suffix))) throw refused();
      if (name === 'projectWorkIndex:workspace') return workspace;
      if (args.paginationOpts) return { page: [], isDone: true, continueCursor: '' };
      if (name.endsWith(':unacked')) return { items: [], complete: true };
      if (name.endsWith(':claims')) return { claims: [], complete: true };
      if (name.endsWith('OverlapAcks:list'))
        return JSON.stringify({
          page: [],
          isDone: true,
          signals: { edits: [], notices: [], behindMain: [], complete: true },
        });
      return null;
    },
  });
}
const settle = async () => {
  for (let i = 0; i < 200; i++) await React.act(() => new Promise(resolve => setImmediate(resolve)));
};
async function mount(fake) {
  const seen = { renders: 0, live: undefined };
  function Page() {
    seen.live = useCoordination('p');
    seen.renders++;
    return null;
  }
  const crashed = [];
  const root = createRoot(host.container, { onUncaughtError: error => crashed.push(error) });
  await React.act(async () =>
    root.render(
      React.createElement(
        ConvexProvider,
        { client: fake.client },
        React.createElement(HostedAttention, { projectId: 'p' }, React.createElement(Page)),
      ),
    ),
  );
  await settle();
  return { root, seen, crashed };
}

test('a reader opens the page with every read answering: nothing unavailable, complete', async () => {
  const fake = backend();
  const { root, seen, crashed } = await mount(fake);
  assert.deepEqual(crashed, []);
  assert.deepEqual(seen.live.unavailable, []);
  assert.equal(seen.live.overlapsComplete, true);
  assert.equal(seen.live.loading, false);
  await React.act(async () => root.unmount());
});

for (const [panel, suffix] of [
  ['overlaps', 'OverlapAcks:list'],
  ['unacked', ':unacked'],
  ['claims', ':claims'],
  ['counts', ':counts'],
])
  test(`a refused ${panel} read degrades only that panel: the page renders, others stay live`, async () => {
    const base = backend();
    const baseMount = await mount(base);
    const baseline = base.count();
    await React.act(async () => baseMount.root.unmount());
    const fake = backend([suffix]);
    const { root, seen, crashed } = await mount(fake);
    assert.deepEqual(crashed, [], 'no error reaches the app boundary');
    assert.deepEqual(seen.live.unavailable, [panel]);
    assert.equal(seen.live.initialLoading, false, 'a failed read is settled, not an endless spinner');
    if (panel === 'overlaps') {
      assert.equal(seen.live.overlapsComplete, false);
      assert.deepEqual(seen.live.overlapAnswers, []);
    }
    if (panel === 'unacked') assert.equal(seen.live.unackedComplete, false);
    assert.equal(fake.count(), baseline, 'subscriptions per view are unchanged');
    fake.reset();
    await settle();
    assert.equal(fake.stats.adds + fake.stats.executions, 0, 'idle stays at zero calls');
    await React.act(async () => root.unmount());
  });
