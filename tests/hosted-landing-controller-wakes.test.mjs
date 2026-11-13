// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { finishFixture, desired } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { CHECK_PROGRESS_WAKE_MS } from '../dist/landing-stall.js';

/** Cost slice 2 (7ecc4884): a controller wake that cannot change eligibility is
 * not scheduled. Progress cadence, terminal wakes and receipts stay as they were;
 * the counts below are the pre-change fixture measurements of the same flow. */
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const SHARDS = 8;
const wakes = await import(moduleUrl('../convex/projectHostedLandingDesiredWake.ts'));

async function drainAll(f, label) {
  for (let i = 0; i < 600; i++) {
    const task = f.pending().find(task => !task.name.startsWith('projectHostedLandingStall'));
    if (!task) return;
    await f.execute(task);
  }
  assert.fail(`pending work did not drain: ${label}`);
}
/** `count` landings, each with its own 8-shard check; one shard result every
 * `gapMs` round-robin, then the terminal result. */
async function landings(t, { count, gapMs, batching, shared = false }) {
  const f = await batchesFixture(t, { count, batching, requestCheck: !shared });
  await drainAll(f, 'submit');
  const live = new Map();
  const activate = async () => {
    for (const run of f.runs())
      if (
        !live.has(run.id) &&
        !['passed', 'failed', 'cancelled', 'interrupted', 'runner-unavailable'].includes(run.status)
      )
        live.set(run.id, await f.rawChecks.activate(run.id, SHARDS));
  };
  await activate();
  await drainAll(f, 'activate');
  const from = f.counts.length;
  const next = new Map();
  for (let step = 0; step < 400; step++) {
    await activate();
    const open = [...live.entries()].filter(([id]) => {
      const run = f.runs().find(run => run.id === id);
      return !['passed', 'failed', 'cancelled', 'interrupted', 'runner-unavailable'].includes(run.status);
    });
    if (!open.length) break;
    const [id, activated] = open[step % open.length];
    const i = next.get(id) ?? 0;
    f.advanceClock(gapMs);
    await f.rawChecks.callback(
      i < SHARDS ? f.rawChecks.shard(activated, i) : f.rawChecks.complete(activated, 'passed'),
    );
    next.set(id, i + 1);
    await drainAll(f, `event ${step}`);
  }
  await drainAll(f, 'end');
  const calls = f.counts.slice(from);
  const wakeCalls = calls.filter(c => c.name === 'finishCheckWake');
  return {
    f,
    calls,
    checkWakes: wakeCalls.length,
    // A wake that wrote no landing row changed nothing the queue can see.
    noopWakes: wakeCalls.filter(c => !c.written.includes('projectHostedLandingRequests')).length,
    ticks: calls.filter(c => c.name === 'finishLandingAdvance').length,
  };
}

// Before the change, per landing: wakes 9/9/9, no-op wakes 8/6/0, ticks 1/3/9.
for (const [gapMs, ticks] of [
  [5_000, 1],
  [20_000, 3],
  [CHECK_PROGRESS_WAKE_MS, 9],
]) {
  test(`one 8-shard check, a result every ${gapMs / 1000} s: no no-op wake, progress cadence unchanged`, async t => {
    const run = await landings(t, { count: 1, gapMs, batching: false });
    assert.equal(states(run.f)[0].phase, 'landed');
    assert.equal(run.noopWakes, 0, 'every scheduled wake changed the queue');
    // Progress still reaches the queue at the throttle cadence, and the terminal
    // result is consumed by the same wake that moves the entry on.
    assert.equal(run.ticks, ticks);
    assert.equal(run.checkWakes, ticks);
    t.diagnostic(
      JSON.stringify({ gapMs, wakes: run.checkWakes, noopWakes: run.noopWakes, ticks: run.ticks }),
    );
  });
}

test('a terminal result inside the throttle window is never skipped (lost-wakeup replay)', async t => {
  const f = await batchesFixture(t, { count: 1, batching: false, requestCheck: true });
  await drainAll(f, 'submit');
  const activated = await f.rawChecks.activate(f.runs()[0].id, SHARDS);
  await drainAll(f, 'activate');
  f.advanceClock(1_000);
  await f.rawChecks.callback(f.rawChecks.shard(activated, 0));
  await drainAll(f, 'progress');
  assert.equal(states(f)[0].phase, 'checking');
  const wakesBefore = f.counts.filter(c => c.name === 'finishCheckWake').length;
  // Still inside the window of the last retained progress: the result is terminal.
  f.advanceClock(1_000);
  for (let i = 1; i < SHARDS; i++) await f.rawChecks.callback(f.rawChecks.shard(activated, i));
  await f.rawChecks.callback(f.rawChecks.complete(activated, 'passed'));
  assert(
    f.pending().some(task => task.name === 'projectHostedLandingDriver:checkWake'),
    'the terminal result schedules its wake in its own transaction',
  );
  await drainAll(f, 'terminal');
  assert.equal(states(f)[0].phase, 'landed');
  assert.equal(f.counts.filter(c => c.name === 'finishCheckWake').length - wakesBefore, 1);
  const idle = f.counts.length;
  await drainAll(f, 'idle');
  assert.equal(f.counts.length, idle, 'idle makes zero Convex calls');
});

test('three landings with shared batch runs still settle, and no wake is lost or idle', async t => {
  const run = await landings(t, { count: 3, gapMs: 20_000, batching: 'default', shared: true });
  assert.deepEqual(
    states(run.f).map(state => state.phase),
    ['landed', 'landed', 'landed'],
  );
  assert.equal(run.f.runs().length, 1, 'all three entries share the one cohort run');
  assert.equal(run.f.pending().filter(task => !task.name.startsWith('projectHostedLandingStall')).length, 0);
  // Before: 45 wakes. Several waiters on one run keep the old (conservative) rule.
  assert(run.checkWakes <= 31, `wakes ${run.checkWakes}`);
  t.diagnostic(JSON.stringify({ wakes: run.checkWakes, noopWakes: run.noopWakes, ticks: run.ticks }));
});

test('a desired landing whose source job still runs arms its watchdog, not an empty drive', async t => {
  const f = await finishFixture(t);
  const command = {
    operationId: randomUUID(),
    authorityEpoch: 1,
    composeOperationId: f.selection.request.operationId,
    after: null,
    check: f.request().check,
  };
  const operation = [...f.tables.projectHostedOperations.values()].find(
    row => row.operationId === command.composeOperationId,
  );
  const compose = [...f.tables.projectHostedComposes.values()].find(
    row => row.operationId === command.composeOperationId,
  );
  const saved = { operation: operation.value, compose: compose.value };
  // The job is submitted and running: not terminal.
  f.patch('projectHostedOperations', operation._id, {
    value: JSON.stringify({ ...JSON.parse(saved.operation), terminal: null }),
  });
  f.patch('projectHostedComposes', compose._id, {
    value: JSON.stringify({ ...JSON.parse(saved.compose), status: 'submitted' }),
  });
  const state = JSON.parse(
    await f.tx('desiredSubmit', desired.submit, { projectId: f.projectId, request: JSON.stringify(command) }),
  );
  assert.equal(state.phase, 'composing');
  const drive = () => f.pending().filter(task => task.name === 'projectHostedLandingDesired:drive');
  // The scheduler runs every due task at once, as in production.
  for (const task of drive().filter(task => task.scheduledTime <= Date.now())) await f.execute(task);
  assert.equal(drive().length, 1, 'one desired wake owns the goal');
  assert(
    drive()[0].scheduledTime - Date.now() >= 30_000,
    'the watchdog is armed at its first backoff, not immediately',
  );
  // The source completes: its completion wakes the goal at once.
  f.patch('projectHostedOperations', operation._id, { value: saved.operation });
  f.patch('projectHostedComposes', compose._id, { value: saved.compose });
  await f.tx(
    'desiredNotify',
    { _handler: (ctx, input) => wakes.notifyDesiredCompose(ctx, input.projectId, input.operationId) },
    { projectId: f.projectId, operationId: command.composeOperationId },
  );
  assert.equal(drive().length, 1);
  assert(drive()[0].scheduledTime - Date.now() < 1_000, 'completion wakes the goal immediately');
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal(
    [...f.tables.projectHostedLandingRequests.values()].map(row => JSON.parse(row.value).phase).join(),
    'landed',
  );
  // One claim and one advance for the whole goal. Before: an empty pair at submit
  // too (2 claims, 2 advances, 2 drive actions; 5.8 KB + 55 KB read, 41 writes).
  for (const name of ['desired-claim', 'desired-advance'])
    assert.equal(f.counts.filter(c => c.name === name).length, 1, name);
  assert.equal(f.pending().length, 0);
});
