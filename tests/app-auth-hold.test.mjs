// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Browser lifecycle rule 1 for Convex Auth (docs/development.md, "Convex Auth"; decisions.md
// shared-base rule 4): a token refresh due while the tab is hidden or dormant waits, and the tab's return answers
// every waiting request with exactly one refresh, also when the idle sleep had already begun.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { holdWhileAsleep, withRefreshHold } = await import(moduleUrl('../web/src/app/auth-hold.ts'));
const { createLiveReads, HIDDEN_GRACE_MS, IDLE_MS } = await import(moduleUrl('../web/src/live-reads.ts'));

function harness(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const reads = createLiveReads();
  const window = new EventTarget();
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const stop = reads.watchActivity(window, page);
  const calls = [];
  const fetchToken = async args => (calls.push(args), `token-${calls.length}`);
  const visibility = state => {
    page.visibilityState = state;
    page.dispatchEvent(new Event('visibilitychange'));
  };
  t.after(stop);
  return { reads, window, page, calls, held: holdWhileAsleep(fetchToken, reads, page), visibility };
}

test('an awake tab refreshes straight through', async t => {
  const { calls, held } = harness(t);
  assert.equal(await held({ forceRefreshToken: true }), 'token-1');
  assert.deepEqual(calls, [{ forceRefreshToken: true }]);
});

test('refreshes asked for while hidden wait and the return makes exactly one, forced if any asked', async t => {
  const { calls, held, visibility } = harness(t);
  visibility('hidden');
  const first = held({ forceRefreshToken: false });
  const second = held({ forceRefreshToken: true });
  t.mock.timers.tick(HIDDEN_GRACE_MS * 10);
  await Promise.resolve();
  assert.equal(calls.length, 0, 'a hidden tab makes no refresh call');
  visibility('visible');
  assert.deepEqual(await Promise.all([first, second]), ['token-1', 'token-1']);
  assert.deepEqual(calls, [{ forceRefreshToken: true }]);
});

test('returning after the idle sleep began counts as attention: exactly one refresh', async t => {
  const { reads, window, calls, held, visibility } = harness(t);
  t.mock.timers.tick(IDLE_MS);
  assert.equal(reads.dormant, true, 'an idle visible tab sleeps');
  const waiting = held({ forceRefreshToken: false });
  visibility('hidden');
  t.mock.timers.tick(HIDDEN_GRACE_MS);
  visibility('visible');
  assert.equal(await waiting, 'token-1');
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('pointermove'));
  await Promise.resolve();
  assert.equal(calls.length, 1, 'focus and input after the return never add a second refresh');
});

test('the held client hands the auth library the held fetch and leaves every other method as it was', async t => {
  const { reads } = harness(t);
  let given;
  const client = {
    setAuth(fetchToken, onChange) {
      given = { fetchToken, onChange };
    },
    other() {
      return this === client;
    },
  };
  const wrapped = withRefreshHold(client, reads, {
    visibilityState: 'hidden',
    addEventListener() {},
    removeEventListener() {},
  });
  const onChange = () => undefined;
  wrapped.setAuth(async () => 'token', onChange);
  assert.equal(given.onChange, onChange);
  assert.equal(wrapped.other(), true);
  let settled = false;
  void given.fetchToken({ forceRefreshToken: false }).then(() => (settled = true));
  await Promise.resolve();
  assert.equal(settled, false, 'the library fetch waits while the page is hidden');
});
