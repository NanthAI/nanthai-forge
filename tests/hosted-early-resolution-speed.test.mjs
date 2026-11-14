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
    assert.deepEqual(
      [after.calls, after.reads, after.writes, after.lateTaskMs, after.idle],
      [154, 2980, 1002, 180000, 0],
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
