// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { countsExpired, scheduleCountsExpiry } = await import(moduleUrl('../web/src/countsExpiry.ts'));

test('the count drops at nextExpiryAt from one local timer, with no new query', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let queries = 0;
  const query = () => queries++; // Anything that would reach Convex.
  const counts = { activeAgents: 2, nextExpiryAt: 1_000_000 + 600_000 };
  let shown = counts;
  const expire = () => {
    shown = countsExpired(counts, Date.now()) ? null : counts;
  };
  assert.equal(countsExpired(counts, Date.now()), false);
  scheduleCountsExpiry(counts, Date.now(), expire);
  t.mock.timers.tick(599_999);
  assert.equal(shown, counts, 'still counted just before the window ends');
  t.mock.timers.tick(1);
  assert.equal(shown, null, 'unknown at the expiry');
  t.mock.timers.tick(3_600_000);
  assert.equal(queries, 0, 'idle costs no query');
  void query;
});

test('new data or unmount cancels the timer; counts without an expiry set none', t => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  let fired = 0;
  const counts = { nextExpiryAt: 5_000 };
  scheduleCountsExpiry(counts, 0, () => fired++)();
  scheduleCountsExpiry({}, 0, () => fired++);
  scheduleCountsExpiry(undefined, 0, () => fired++);
  t.mock.timers.tick(10_000);
  assert.equal(fired, 0);
  assert.equal(countsExpired({}, 1e15), false, 'nothing to expire stays a zero/true count');
});

test('an already-expired stamp fires on the next tick and long delays are clamped', t => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: 100 });
  let fired = 0;
  scheduleCountsExpiry({ nextExpiryAt: 50 }, 100, () => fired++);
  t.mock.timers.tick(0);
  assert.equal(fired, 1);
  const delays = [];
  scheduleCountsExpiry({ nextExpiryAt: 2 ** 40 }, 0, () => {}, {
    setTimeout: (_fn, ms) => (delays.push(ms), 1),
    clearTimeout: () => {},
  });
  assert.equal(delays[0], 2 ** 31 - 1);
});
