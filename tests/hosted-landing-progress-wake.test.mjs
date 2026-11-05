// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const SHARDS = 8;

/** Incident c329d191: every running-check progress event woke the queue and
 * wrote the checking entry's queue row, which the publish of a waiting head
 * reads; that write contention exhausted the head's only finish drive. Same
 * events, two arrival gaps: 61 s apart nothing is throttled (the old one wake
 * per event); 10 s apart progress reaches the queue at most once a minute. */
async function progress(t, gapMs) {
  const f = await batchesFixture(t, { count: 1, batching: false, requestCheck: true });
  const drain = async () => {
    for (let i = 0; i < 200; i++) {
      const task = f.pending().find(task => !task.name.startsWith('projectHostedLandingStall'));
      if (!task) return;
      await f.execute(task);
    }
    assert.fail('pending work did not drain');
  };
  await drain();
  const [run] = f.runs();
  const activated = await f.rawChecks.activate(run.id, SHARDS);
  await drain();
  assert.equal(states(f)[0].phase, 'checking');
  const from = f.counts.length;
  for (let i = 0; i < SHARDS - 1; i++) {
    f.advanceClock(gapMs);
    await f.rawChecks.callback(f.rawChecks.shard(activated, i));
    await drain();
  }
  const calls = f.counts.slice(from);
  const rowWrites = calls.reduce(
    (n, c) => n + c.written.filter(table => table === 'projectHostedLandingRequests').length,
    0,
  );
  const queueTicks = calls.filter(c => c.name === 'finishLandingClaim').length;
  assert.equal(states(f)[0].phase, 'checking', 'progress alone never settles the entry');
  // The terminal event still reaches the entry at once.
  f.advanceClock(1_000);
  await f.rawChecks.callback(f.rawChecks.shard(activated, SHARDS - 1));
  await f.rawChecks.callback(f.rawChecks.complete(activated, 'passed'));
  for (let i = 0; i < 400 && !['ready', 'landed'].includes(states(f)[0].phase); i++) {
    const task = f.pending()[0];
    if (!task) break;
    await f.execute(task);
  }
  assert(['ready', 'landed'].includes(states(f)[0].phase), states(f)[0].phase);
  return { events: SHARDS - 1, rowWrites, queueTicks, calls: calls.length };
}

test('incident c329d191: running-check progress writes the queue row at most once a minute', async t => {
  const unthrottled = await progress(t, 61_000);
  const throttled = await progress(t, 10_000);
  t.diagnostic(JSON.stringify({ unthrottled, throttled }));
  assert(unthrottled.rowWrites >= unthrottled.events, 'one wake per event when events are a minute apart');
  // 7 events over 70 s: the first and the one at least 60 s later.
  assert(throttled.rowWrites <= 2 * Math.ceil(throttled.events / 6), JSON.stringify(throttled));
  assert(throttled.rowWrites < unthrottled.rowWrites);
  assert(throttled.queueTicks < unthrottled.queueTicks);
});
