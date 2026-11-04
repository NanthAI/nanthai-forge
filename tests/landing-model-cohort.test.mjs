// SPDX-License-Identifier: Apache-2.0
// Characterization of Issue 6e587f06, deliberately not the proposed fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
test('same-cohort rejection remains terminal when its unaccepted prefix fails every check', async t => {
  const f = await batchesFixture(t, { count: 2, conflict: true, batchMaxSize: 2 });
  const main = f.currentMain();
  assert(
    f.entries.every(entry => entry.candidate.result.status === 'clean'),
    'each selection composes alone cleanly',
  );
  await f.drain();
  const [first, second] = f.entries;
  const current = entry => states(f).find(state => state.id === entry.state.id);
  assert.equal(current(first).phase, 'checking');
  assert.equal(current(second).error?.code, 'COMPOSITION_CONFLICT');
  const rejectedAttempt = current(second).attemptId;
  for (let round = 0; round < 4 && current(first).phase !== 'terminal-failed'; round++) {
    const pending = f.runs().filter(run => run.status === 'queued');
    assert(pending.length, 'surviving prefix has a check to settle');
    for (const run of pending) await f.fail(run.id, 'tests/member-0.test.mjs');
    await f.drain();
  }
  assert.equal(current(first).phase, 'terminal-failed');
  assert.equal(current(first).error?.code, 'CHECK_FAILED');
  assert.equal(current(second).attemptId, rejectedAttempt, 'rejected member never retries on main');
  assert.equal(current(second).error?.code, 'COMPOSITION_CONFLICT');
  assert.equal(f.currentMain().head, main.head);
  assert.equal(f.currentMain().receipt.id, main.receipt.id);
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});
