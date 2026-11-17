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
import { carriedCostCounts, landingSpeedSample } from '../dist/landing-speed-alerts.js';
import { moduleUrl } from './convex-module.mjs';
const { statsLanding } = await import(moduleUrl('../convex/projectStats.ts'));
const { supersededCheckCosts, bindSupersededCheck } = await import(
  moduleUrl('../convex/projectHostedLandingRunnerCosts.ts')
);

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
  assert.deepEqual(
    sharedCheckCounts({ runnerSeconds: 100, discardedRunnerSeconds: 20 }, undefined, 4, false),
    {
      discardedRunnerSeconds: 120,
      discardedRunnerUnknown: 'superseded-check-execution-unreported',
    },
  );
});

test('unreported superseded execution stays unknown after a pass, a shared check and recomposition', () => {
  const unknown = 'superseded-check-execution-unreported';
  let counts = { discardedRunnerSeconds: 120, discardedRunnerUnknown: unknown };
  counts = sharedCheckCounts(counts, 1200, 4, true);
  assert.equal(counts.discardedRunnerSeconds, 120, 'known usage remains a lower bound');
  for (const reused of [true, false]) {
    const carried = carriedCostCounts(counts, undefined, reused);
    assert.equal(carried.discardedRunnerUnknown, unknown);
    const state = {
      at: '2026-11-16T12:00:00.000Z',
      timing: { submittedAt: '2026-11-16T12:00:00.000Z', committedAt: '2026-11-16T12:10:00.000Z' },
      counts: { ...carried, runnerSeconds: 300 },
    };
    assert.equal(landingCosts(state, 1).runnerDiscarded, null);
    assert.equal(landingSpeedSample(state, 1).counts[4], null);
    assert.equal(statsLanding({ id: 'receipt', at: state.at }, state).discardedRunnerSeconds, null);
  }
});

test('legacy resubmissions without a discard stamp stay unknown while a recorded zero survives proof reuse', () => {
  const supersedes = '11111111-1111-4111-8111-111111111111';
  assert.equal(landingCosts({ supersedes, counts: { runnerSeconds: 300 } }, 0).runnerDiscarded, null);
  const counts = carriedCostCounts({ runnerSeconds: 300, discardedRunnerSeconds: 0 }, undefined, true, true);
  assert.equal(landingCosts({ supersedes, counts }, 0).runnerDiscarded, 0);
  const legacy = supersededCheckCosts({ supersedes, counts: { runnerSeconds: 300 } }, 'retained-run');
  assert.equal(legacy.counts.discardedRunnerSeconds, 300, 'known latest usage is still retained');
  const reused = bindSupersededCheck(legacy.counts, legacy.supersededCheck, 'retained-run');
  assert.equal(
    landingCosts({ supersedes, counts: reused.counts }, 0).runnerDiscarded,
    null,
    'reusing the latest run does not erase an older missing carry',
  );
});

test('a recorded shared failure stays known despite the leader reservation timestamp', () => {
  const carried = supersededCheckCosts(
    {
      counts: { discardedRunnerSeconds: 120 },
      batchOriginId: 'failed-cohort',
      timing: { checkReservedAt: '2026-11-10T23:00:00.000Z' },
    },
    undefined,
  );
  assert.deepEqual(carried.counts, { discardedRunnerSeconds: 120 });
  assert.equal(landingCosts({ counts: carried.counts }, 0).runnerDiscarded, 2);
});
