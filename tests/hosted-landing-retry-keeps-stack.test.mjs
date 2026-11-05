// SPDX-License-Identifier: Apache-2.0
// Issue ea86f3fb (incident a7de3a93, 2026-11-05): a platform retry of a check
// re-checks the same predicted head and keeps its receipt, so the dependent and
// batch checks stacked on that (head, receipt) keep running. Before the fix a
// retried solo head superseded its stacked batch (run cancelled with 75 test
// files passed, ~74 runner-minutes lost), and a retried batch re-reserved its
// receipts, so every stacked successor re-checked after it passed.
// Model: models/landing-queue `retrykeep` / `retrykeep-fixed` and `StackPinned`.
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

async function drainActive(f) {
  for (let steps = 0; ;) {
    const task = f.pending().find(task => !task.name.startsWith('projectHostedLandingStall:'));
    if (!task) return;
    assert(++steps < 1000, 'bounded event-driven source/queue progress');
    await f.execute(task);
  }
}
const batches = f => [...f.tables.projectHostedLandingBatches.values()].map(row => JSON.parse(row.value));
// The incident run: 13 jobs, ~5.7 min each when cancelled (74 runner-minutes).
const RUNNER_MINUTES_PER_DISCARDED_RUN = 74;

/** Start every queued run with shard progress, as in the incident (CI under way). */
async function startAll(f) {
  const active = new Map();
  for (const run of f.runs().filter(run => run.status === 'queued')) {
    const live = await f.rawChecks.activate(run.id);
    active.set(run.id, live);
    await drainActive(f);
    await f.rawChecks.callback(f.rawChecks.shard(live, 0));
    await drainActive(f);
  }
  return active;
}
/** Pass every live run, successors first, until the queue settles. */
async function settle(f, active) {
  for (let wave = 0; states(f).some(s => s.phase !== 'landed' && s.phase !== 'terminal-failed'); wave++) {
    assert(wave < 10, JSON.stringify(states(f).map(s => [s.id, s.phase, s.error?.code])));
    for (const run of [...f.runs()].reverse()) {
      if (run.status === 'queued') active.set(run.id, await f.rawChecks.activate(run.id));
      if (['queued', 'running'].includes(run.status) && !run.cancelRequested)
        await f.rawChecks.pass(active.get(run.id));
    }
    await drainActive(f);
  }
}
/** Runs other than the retried one whose proof was still accepted. */
function report(t, f, initial, retried, label) {
  const used = new Set(
    [...f.tables.projectHostedAcceptances.values()].map(row => JSON.parse(row.value).check.runId),
  );
  const kept = initial.filter(run => run.id !== retried.id && used.has(run.id)).length;
  t.diagnostic(
    JSON.stringify({
      case: label,
      ciRuns: f.runs().length,
      otherRunsKept: kept,
      runnerMinutesSavedAtIncidentScale: kept * RUNNER_MINUTES_PER_DISCARDED_RUN,
    }),
  );
  return f.runs().length - initial.length - 1;
}

test('a platform retry of the batch head keeps every stacked batch check (same head and receipt)', async t => {
  const f = await batchesFixture(t, { count: 10, batching: 'default', batchMaxSize: null });
  await drainActive(f);
  const initial = f.runs();
  assert.equal(initial.length, 4, 'one head cohort and three stacked groups');
  const active = await startAll(f);
  const pins = batches(f)
    .filter(batch => batch.predecessor)
    .map(batch => [batch.id, batch.predecessor]);
  const head = initial[0];
  await f.rawChecks.callback(f.rawChecks.complete(active.get(head.id), 'runner-unavailable'));
  await drainActive(f);
  assert.equal(f.runs().length, 5, 'exactly one retry run for the head');
  assert(!batches(f).some(batch => batch.phase === 'superseded'), 'no stacked group is superseded');
  for (const run of f.runs().filter(run => initial.slice(1).some(old => old.id === run.id)))
    assert(!run.cancelRequested && run.status === 'running', 'stacked runs keep running');
  assert.deepEqual(
    batches(f)
      .filter(batch => batch.predecessor)
      .map(batch => [batch.id, batch.predecessor]),
    pins,
    'the stacked groups keep their pinned predecessor head and receipt',
  );
  await settle(f, active);
  assert(states(f).every(state => state.phase === 'landed'));
  assert.equal(report(t, f, initial, head, 'batch head'), 0, 'no stacked group re-checks');
  assert.equal(f.pending().length, 0, 'idle schedules nothing');
});

test('a platform retry of a stacked batch keeps its own stack and its successors', async t => {
  const f = await batchesFixture(t, { count: 10, batching: 'default', batchMaxSize: null });
  await drainActive(f);
  const initial = f.runs();
  const active = await startAll(f);
  const stacked = initial[1];
  await f.rawChecks.callback(f.rawChecks.complete(active.get(stacked.id), 'runner-unavailable'));
  await drainActive(f);
  assert.equal(f.runs().length, 5, 'exactly one retry run for the stacked group');
  assert(!batches(f).some(batch => batch.phase === 'superseded'), 'nothing is superseded');
  const retry = f.runs().at(-1);
  assert.equal(retry.request.expectedHead, stacked.request.expectedHead, 'the same predicted head');
  assert.deepEqual(retry.candidate.base, stacked.candidate.base, 'still stacked on the pending head');
  await settle(f, active);
  assert(states(f).every(state => state.phase === 'landed'));
  assert.equal(report(t, f, initial, stacked, 'stacked batch'), 0, 'no successor re-checks');
  assert.equal(f.pending().length, 0);
});

test('incident a7de3a93 replay: a solo head retried after a platform outcome keeps the stacked batch run', async t => {
  const f = await batchesFixture(t, { count: 3, batching: 'default', batchMaxSize: 1 });
  await drainActive(f);
  const initial = f.runs();
  assert.equal(initial.length, 3, 'a solo head and two stacked singleton groups');
  assert(states(f)[0].batchId === undefined, 'the head checks alone');
  const active = await startAll(f);
  const head = initial[0];
  await f.rawChecks.callback(f.rawChecks.complete(active.get(head.id), 'interrupted'));
  await drainActive(f);
  assert.equal(f.runs().length, 4, 'retrySoloLandingCheck enqueues one run for the same Candidate');
  assert.equal(f.runs().at(-1).request.candidateId, head.request.candidateId);
  assert(!batches(f).some(batch => batch.phase === 'superseded'), 'the stacked batch is not superseded');
  for (const run of f.runs().filter(run => initial.slice(1).some(old => old.id === run.id)))
    assert(!run.cancelRequested && run.status === 'running', 'the stacked run is not cancelled');
  await settle(f, active);
  assert(states(f).every(state => state.phase === 'landed'));
  assert.equal(report(t, f, initial, head, 'solo head'), 0, 'the stacked group does not re-check');
  assert.equal(f.pending().length, 0);
});
