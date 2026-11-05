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

/** Synthetic queue harness (51bbbd00 goal 3, wave 1 2026-11-05 shape): 12
 * members arrive together, two of them break their own module. Their failing
 * test names the module the way a real stack trace does (dist/ build), the
 * attribution that missed 51d09ad5. Every run containing a broken member fails;
 * all others pass. Reports exact check runs per accepted landing. */
const COUNT = 12;
const BROKEN = new Set([3, 8]);
const modulePath = i => `src/queue-member-${i}.ts`;
const testFile = i => `tests/queue-member-${i}.test.mjs`;

export async function queueHarness(t) {
  const f = await batchesFixture(t, {
    count: COUNT,
    batching: 'default',
    batchMaxSize: null,
    memberPaths: Array.from({ length: COUNT }, (_, i) => modulePath(i)),
  });
  const index = new Map(f.entries.map((entry, i) => [entry.state.id, i]));
  const owners = run =>
    new Set(
      [...f.tables.projectHostedLandingAttempts.values()]
        .filter(row => JSON.parse(row.value).check?.runId === run.id)
        .map(row => index.get(row.submissionId)),
    );
  let steps = 0;
  for (;;) {
    assert(++steps < 4000, JSON.stringify(states(f).map(s => [s.sequence, s.phase])));
    if (states(f).every(s => s.phase === 'landed' || s.phase === 'terminal-failed')) break;
    const queued = f.runs().filter(run => run.status === 'queued');
    for (const run of queued) {
      const broken = [...owners(run)].filter(i => BROKEN.has(i));
      const activated = await f.rawChecks.activate(run.id);
      if (!broken.length) {
        await f.rawChecks.pass(activated);
        continue;
      }
      await f.rawChecks.callback(f.rawChecks.shard(activated, 0, 'failed'));
      await f.rawChecks.callback(
        f.rawChecks.complete(activated, 'failed', {
          contractReports: Object.fromEntries(
            broken.map(i => [
              testFile(i),
              {
                failed: true,
                durationMs: 1,
                firstError: `TypeError: boom\n    at dist/queue-member-${i}.js:12:3`,
              },
            ]),
          ),
        }),
      );
    }
    // Event-driven work first; a stall alarm only when nothing else can move.
    const live = f.pending().filter(task => !task.name.startsWith('projectHostedLandingStall'));
    const task = live[0] ?? (queued.length ? null : f.pending()[0]);
    if (task) await f.execute(task);
    else if (!queued.length && !f.runs().some(run => run.status === 'queued')) break;
  }
  const all = states(f);
  const landed = all.filter(s => s.phase === 'landed').length;
  return {
    f,
    all,
    runs: f.runs().length,
    landed,
    runsPerLanding: f.runs().length / landed,
    failedRuns: f.runs().filter(run => run.status === 'failed').length,
  };
}

test('synthetic queue: 12 members with 2 broken land 10, settle 2, within the runs-per-landing budget', async t => {
  const { all, runs, landed, runsPerLanding, failedRuns } = await queueHarness(t);
  t.diagnostic(
    JSON.stringify({ runs, failedRuns, landed, runsPerLanding: Number(runsPerLanding.toFixed(2)) }),
  );
  for (const [i, state] of all.entries())
    assert.equal(
      state.phase,
      BROKEN.has(i) ? 'terminal-failed' : 'landed',
      `member ${i}: ${JSON.stringify(state.error)}`,
    );
  assert.equal(landed, COUNT - BROKEN.size);
  // Measured 2026-11-05 on this harness: base f11c082d 17 runs (5 failed), 1.7
  // per landing; with failure attribution and one-time unstack 10 runs (4 failed).
  assert(runsPerLanding <= 1.2, `runs per accepted landing ${runsPerLanding} (was 1.7 before 51bbbd00)`);
});
