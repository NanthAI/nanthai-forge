// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { syncTiming } from '../dist/sync-timing.js';

test('sync timing splits steps from the previous mark and totals them', () => {
  const clock = [1000, 1000.4, 1250.6, 4300, 4999.2];
  const timing = syncTiming(() => clock.shift());
  timing.mark('settle');
  timing.mark('submit');
  timing.mark('hostedWait');
  timing.mark('apply');
  assert.deepEqual(timing.value(), {
    totalMs: 3999,
    stepsMs: { settle: 0, submit: 250, hostedWait: 3049, apply: 699 },
  });
  assert.equal(clock.length, 0, 'one clock read per mark, none on read-out');
});

test('a clock that steps back never reports a negative step', () => {
  const clock = [10, 5];
  const timing = syncTiming(() => clock.shift());
  timing.mark('hostedWait');
  assert.deepEqual(timing.value(), { totalMs: 0, stepsMs: { hostedWait: 0 } });
});
