// SPDX-License-Identifier: Apache-2.0
// Lifecycle rule 2 for Convex Auth (docs/development.md, "Convex Auth core beside Clerk"; spike case 5): the sign-in
// screen holds a passkey autofill challenge only while its tab is visible and active. The library starts one when its
// hook mounts and renews it about every eight minutes while mounted, so the gate decides how many challenges exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installHookHost } from './convex-fake.mjs';
import { moduleUrl } from './convex-module.mjs';

const host = installHookHost();
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { WhileAwake } = await import(moduleUrl('../web/src/app/awake.tsx'));
const { createLiveReads, HIDDEN_GRACE_MS, IDLE_MS } = await import(moduleUrl('../web/src/live-reads.ts'));
test.after(() => host.restore());

test('autofill mounts only while the sign-in tab is visible and active, once per return', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const reads = createLiveReads();
  const stop = reads.watchActivity(host.window, host.document);
  const mounts = { started: 0, live: 0 };
  function Autofill() {
    React.useEffect(() => {
      mounts.started++;
      mounts.live++;
      return () => void mounts.live--;
    }, []);
    return null;
  }
  let keep = false;
  const root = createRoot(host.container);
  const draw = () =>
    React.act(async () =>
      root.render(React.createElement(WhileAwake, { reads, keep }, React.createElement(Autofill))),
    );
  await draw();
  assert.deepEqual(mounts, { started: 1, live: 1 }, 'a visible tab offers passkeys at once');

  await React.act(async () => host.setVisibility('hidden'));
  assert.equal(mounts.live, 0, 'hiding the tab drops the challenge at once');
  await React.act(async () => t.mock.timers.tick(HIDDEN_GRACE_MS * 40));
  await React.act(async () => host.setVisibility('visible'));
  assert.deepEqual(mounts, { started: 2, live: 1 }, 'the return starts exactly one new challenge');

  await React.act(async () => t.mock.timers.tick(IDLE_MS));
  assert.equal(mounts.live, 0, 'an idle visible tab holds no challenge');
  keep = true;
  await draw();
  assert.equal(mounts.live, 1, 'a press being carried out keeps the flow mounted');
  keep = false;
  await draw();
  await React.act(async () => host.window.dispatchEvent(new Event('pointermove')));
  await React.act(async () => host.window.dispatchEvent(new Event('focus')));
  assert.deepEqual(mounts, { started: 4, live: 1 }, 'input wakes it once; more input adds nothing');
  stop();
  await React.act(async () => root.unmount());
});
