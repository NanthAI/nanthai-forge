// SPDX-License-Identifier: Apache-2.0
// Issue 80540753 guard: every accepted landing, solo or batch, carries runner seconds and discarded
// runner seconds, so CI waste per landing is exact (Stats, a61d3c91, excludes unknowns and counts
// them). Found in the release qualification smoke: nine accepted batch members recorded R2 counts but
// neither field. A batch member carries its share of the shared check; a failed shared check's share
// is discarded, never dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { landingCosts } from '../dist/hosted-landings-view.js';
import { sharedCheckCounts } from '../dist/cost-budgets.js';

const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** The runner reports shard execution seconds (as the Actions results path sums them): `seconds` per
 * run, stamped on the run row before it completes. */
function reportSeconds(f, seconds) {
  const stamp = runId => {
    for (const [id, row] of f.tables.projectHostedCheckRuns) {
      const run = JSON.parse(row.value);
      if (run.id === runId)
        f.patch('projectHostedCheckRuns', id, {
          value: JSON.stringify({ ...run, execution: { seconds, shards: run.plan.shardCount } }),
        });
    }
  };
  f.rawChecks.pass = async run => {
    for (let i = 0; i < run.plan.shardCount; i++)
      await f.rawChecks.callback(f.rawChecks.shard(run, i, 'passed'));
    stamp(run.id);
    return f.rawChecks.callback(f.rawChecks.complete(run));
  };
  return async (runId, file) => {
    const run = await f.rawChecks.activate(runId);
    await f.rawChecks.callback(f.rawChecks.shard(run, 0, 'failed'));
    stamp(run.id);
    await f.rawChecks.callback(
      f.rawChecks.complete(run, 'failed', {
        contractReports: {
          [file]: { failed: true, durationMs: 1, firstError: `${file}: synthetic failure` },
        },
      }),
    );
  };
}
/** The guard: an accepted landing's reply (the landings read) has both fields. */
function assertRunnerFields(f) {
  const landed = states(f).filter(s => s.phase === 'landed');
  assert(landed.length > 0);
  for (const state of landed) {
    const costs = landingCosts(state, 0);
    assert.notEqual(costs.runnerAccepted, null, `${state.id} lacks runner minutes`);
    assert.notEqual(costs.runnerDiscarded, null, `${state.id} lacks discarded runner minutes`);
  }
  return landed;
}

test('accepted batch members each carry their share of the shared check and an explicit zero discarded', async t => {
  const f = await batchesFixture(t);
  reportSeconds(f, 1200);
  await f.drain();
  await f.passChecks();
  await f.drain();
  const landed = assertRunnerFields(f);
  assert.equal(landed.length, 4);
  for (const state of landed)
    assert.deepEqual([state.counts.runnerSeconds, state.counts.discardedRunnerSeconds], [300, 0]);
});

test('a failed shared check is discarded minutes on every member that later lands', async t => {
  const f = await batchesFixture(t);
  const fail = reportSeconds(f, 1200);
  await f.drain();
  await fail(f.runs()[0].id, 'tests/combined.test.mjs');
  await f.drain();
  for (let i = 0; i < 6 && states(f).some(s => s.phase !== 'landed' && s.phase !== 'terminal-failed'); i++) {
    for (const run of f.runs().filter(r => r.status === 'queued'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await f.drain();
  }
  const landed = assertRunnerFields(f);
  assert.equal(landed.length, 4);
  for (const state of landed)
    assert(state.counts.discardedRunnerSeconds >= 300, 'the failed shared run is waste');
});

test('a run with no execution report leaves the landing unknown instead of zero', () => {
  assert.equal(sharedCheckCounts(undefined, undefined, 4, true), undefined);
  assert.deepEqual(sharedCheckCounts({ runnerSeconds: 100 }, 400, 4, false), { discardedRunnerSeconds: 200 });
});
