// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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

test('a save split adds up a step marked twice and resolve nests its save (friction f15db544)', () => {
  const clock = [0, 10, 30, 60, 100, 150];
  const save = syncTiming(() => clock.shift());
  save.mark('capture'); // 10
  save.mark('prepare'); // 20
  save.mark('capture'); // 30 more: the save repaired once after WORK_STALE
  save.mark('submit'); // 40
  assert.deepEqual(save.value(), { totalMs: 100, stepsMs: { capture: 40, prepare: 20, submit: 40 } });
  const outer = [0, 150];
  const resolve = syncTiming(() => outer.shift());
  resolve.nest(save.value());
  resolve.mark('save');
  assert.deepEqual(resolve.value(), {
    totalMs: 150,
    stepsMs: { save: 150 },
    save: { totalMs: 100, stepsMs: { capture: 40, prepare: 20, submit: 40 } },
  });
});

test('the dependency refresh after a sync joins its split and the reply states its wall time (friction a1f01239)', async () => {
  const { withDependencyTiming } = await import('../dist/sync-timing.js');
  const at = Date.parse('2026-11-19T10:54:05Z');
  // The incident: a 15.6 s split while the command took over 600 s, most of it relinking node_modules.
  const reply = { source: {}, timing: { totalMs: 15_560, stepsMs: { settle: 60, hostedWait: 15_500 } } };
  const timed = withDependencyTiming(reply, 590_000, at - 606_000, at);
  assert.equal(timed.timing.totalMs, 605_560);
  assert.equal(timed.timing.stepsMs.dependencies, 590_000);
  assert.equal(timed.timing.wallMs, 606_000, 'wall time since dispatch');
  assert.equal(reply.timing.totalMs, 15_560, 'the input reply is not mutated');
  // No refresh time: the split is unchanged apart from its wall time.
  const quick = withDependencyTiming(reply, 0, at, at);
  assert.deepEqual(quick.timing.stepsMs, reply.timing.stepsMs);
  assert.equal(quick.timing.wallMs, 15_560, 'never below the split');
  // A reply without a split names only a refresh of a second or more.
  assert.deepEqual(withDependencyTiming({ status: 'up-to-date' }, 400, at, at), { status: 'up-to-date' });
  assert.deepEqual(withDependencyTiming({ status: 'up-to-date' }, 4_000, at, at), {
    status: 'up-to-date',
    dependenciesMs: 4_000,
  });
  assert.equal(withDependencyTiming(null, 4_000, at, at), null);
});

test('the reply wall time is re-stamped at assembly, after reads that follow the operation (review of a1f01239)', async () => {
  const { stampWallMs, withDependencyTiming } = await import('../dist/sync-timing.js');
  const reply = withDependencyTiming(
    { timing: { totalMs: 15_560, stepsMs: { hostedWait: 15_560 } } },
    0,
    0,
    16_000,
  );
  assert.equal(reply.timing.wallMs, 16_000);
  // A 20 s overlap read before the reply is assembled stays inside the wall time.
  assert.equal(stampWallMs(reply, 0, 36_000).timing.wallMs, 36_000);
  // Only a split that already carries a wall time is stamped.
  const plain = { timing: { totalMs: 5, stepsMs: {} } };
  assert.equal(stampWallMs(plain, 0, 36_000), plain);
  assert.equal(stampWallMs(null, 0, 1), null);
});
