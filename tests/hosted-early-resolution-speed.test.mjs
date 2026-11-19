// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replayConflictTrio } from './early-resolution-replay.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const { budgets } = JSON.parse(readFileSync(new URL('../src/speed-budgets.json', import.meta.url)));
test('8c9b84fc: exact conflict trio uses resolution time while predecessors check, without another check', async t => {
  const before = await replayConflictTrio(t, { earlyResolve: 'off' });
  const after = await replayConflictTrio(t);
  t.diagnostic(JSON.stringify({ before, after }));
  const budget = budgets.find(b => b.metric === 'earlyResolveLateTaskToMainMs');
  assert(budget, 'central fake-clock speed budget');
  assert(after.lateTaskMs <= budget.max, `late task ${after.lateTaskMs} ms exceeds ${budget.max} ms`);
  assert(after.lateTaskMs < before.lateTaskMs, 'resolving during the wait beats resolving after settlement');
  assert.equal(after.checks, before.checks);
  assert.equal(after.resolutions, 1);
  assert.equal(after.idle, 0);
  for (const metric of ['calls', 'reads', 'writes']) assert(after[metric] <= before[metric], metric);
});

for (const history of [0, 1150])
  test(`disjoint early-resolution path adds zero calls/reads/writes at ${history} retained receipts`, async t => {
    const before = await replayConflictTrio(t, { earlyResolve: 'off', disjoint: true, history });
    const after = await replayConflictTrio(t, { disjoint: true, history });
    for (const metric of ['calls', 'reads', 'writes', 'checks', 'lateTaskMs', 'idle'])
      assert.equal(after[metric], before[metric], metric);
    assert.equal(after.resolutions, 0);
    // c01d5457: pending-only finish retirement reads 12 scheduler states and
    // removes 10 cancellation writes versus [154, 2924, 1002, 180000, 0].
    // 18af654d: the live line adds 32 reads and 33 slim projection writes;
    // preserve exact physical I/O and the zero-overhead early-resolution comparison.
    // 1122c9c9: pending-only scheduler cleanup adds exactly 15 status probes in both arms.
    // 3d5d8839: the trio's first landing opens an hour bucket and schedules the person-order touch (+1 call, +1 read
    // of its one stale-row range, +1 write: the schedule); equal in both arms.
    // 3a733ee8 (review 66f9ed38): +1 read and +1 write per landed Intent, no call. Each of the trio's three
    // landings posts one Item landing note in its existing completion tick (a unique-index probe, then an
    // insert): +3 reads, +3 writes; equal in both arms.
    // b149b16b: the always-on S1 writer arms one terminal-plus-seven-day capsule wake per landed
    // member inside its existing settle mutation (+3 writes: the schedules; no call or read); equal in both arms.
    // Calls 155 -> 165, reads 2987 -> 3193, writes 1032 -> 1126 (Item 9a04d916, compose settle; owner-approved +$0.02/1k): each finish wake with no IO in flight is the settle mutation, and a step that needs IO hands it to one drive action (an acceptance page or cohort plan steps once more there);
    // equal in both arms.
    assert.deepEqual(
      [after.calls, after.reads, after.writes, after.lateTaskMs, after.idle],
      [165, 3193, 1126, 180000, 0],
      '8c9b84fc: disjoint baseline must not grow',
    );
    t.diagnostic(JSON.stringify({ history, before, after }));
  });

test('conflicting early resolution reads only its active prefix, independent of retained receipts', async t => {
  const small = await replayConflictTrio(t);
  const large = await replayConflictTrio(t, { history: 1150 });
  for (const metric of ['calls', 'reads', 'writes', 'checks', 'lateTaskMs', 'idle'])
    assert.equal(large[metric], small[metric], metric);
  t.diagnostic(JSON.stringify({ small, large }));
});
