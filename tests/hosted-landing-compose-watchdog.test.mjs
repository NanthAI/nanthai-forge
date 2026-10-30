// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { LANDING_STALL_MS } from '../dist/landing-stall.js';
import {
  HOSTED_FINISH_COMPOSE_WATCHDOG_MS,
  HOSTED_FINISH_COMPOSE_WATCH_WINDOW_MS,
} from '../dist/hosted-finish.js';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const batchOf = f => JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value);
const finishWakes = (f, submissionId) =>
  f
    .pending()
    .filter(t => t.name === 'projectHostedFinishDriver:drive' && t.args[0].submissionId === submissionId);
async function untilStep(f) {
  for (let tick = 0; f.pending()[0]?.name !== 'projectConvexSource:step'; tick++) {
    assert(tick < 100, 'the source step is reached');
    await f.execute(f.pending()[0]);
  }
  return f.pending()[0];
}

test('incident replay 2026-10-30: a batch compose step that dies on fetch failed is resumed by its finish owner, not the 15-minute stall', async t => {
  const f = await batchesFixture(t, { count: 2 });
  await untilStep(f);
  const failedAt = Date.now();
  await assert.rejects(f.execute(f.pending()[0], 'step-fetch-failed'), /fetch failed/);

  // The exact stuck state: a composing batch holds the train, both members are
  // queued but not runnable, the queue owns no lease and no dispatch wake.
  const batch = batchOf(f);
  assert.equal(batch.phase, 'composing');
  const queue = [...f.tables.projectHostedLandingQueues.values()][0];
  assert.deepEqual(new Set(queue.train), new Set(states(f).map(s => s.id)));
  assert.equal(queue.lease, null);
  for (const row of f.tables.projectHostedLandingRequests.values()) {
    assert.equal(row.phase, 'queued');
    assert.equal(row.runnable, false);
  }
  assert(
    !f
      .pending()
      .some(t => t.name.startsWith('projectConvexSource') || t.name === 'projectHostedLandingDriver:drive'),
    'nothing else re-drives the dead source step',
  );
  const [watchdog] = finishWakes(f, batch.leaderId);
  assert(watchdog, 'the batch leader retains a compose watchdog');
  assert(watchdog.scheduledTime - failedAt <= HOSTED_FINISH_COMPOSE_WATCHDOG_MS);

  let checkingAt = null;
  for (let tick = 0; states(f).some(s => s.phase !== 'landed'); tick++) {
    assert(tick < 200, JSON.stringify({ task: f.pending()[0]?.name, batch: batchOf(f).phase }));
    assert.notEqual(batchOf(f).phase, 'fallback', 'the shared batch is never abandoned');
    if (checkingAt === null && batchOf(f).phase === 'checking') checkingAt = Date.now();
    if (f.runs().some(run => run.status === 'queued')) await f.passChecks();
    await f.execute(f.pending()[0]);
  }
  assert(checkingAt !== null && checkingAt - failedAt < LANDING_STALL_MS, 'recovered before the stall alarm');
  assert.equal(f.tables.projectSourceSteps.size, 1, 'the same source execution resumed');
  assert.equal(f.runs().length, 1, 'one shared check');
  assert(states(f).every(s => !s.batchSolo && !s.observation.stall));
  await f.drain();
  assert.equal(finishWakes(f, batch.leaderId).length, 0, 'no idle finish wake after landing');
  t.diagnostic(JSON.stringify({ recoveredAfterMs: checkingAt - failedAt, stallMs: LANDING_STALL_MS }));
});

test('incident replay 2026-10-30: the solo fallback recompose that died on fetch failed resumes the same job and lands', async t => {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  await f.drain();
  f.moveMain();
  await f.passChecks();
  await untilStep(f);
  const failedAt = Date.now();
  await assert.rejects(f.execute(f.pending()[0], 'step-fetch-failed'), /fetch failed/);
  const [watchdog] = finishWakes(f, state.id);
  assert(watchdog, 'the finish retains a compose watchdog while its source job runs');
  assert(watchdog.scheduledTime - failedAt <= HOSTED_FINISH_COMPOSE_WATCHDOG_MS);
  const ticks = await f.drain();
  await f.passChecks();
  await f.drain();
  const current = await f.current(state.id);
  assert.equal(current.submission.phase, 'landed');
  assert.equal(f.tables.projectSourceSteps.size, 1, 'no replacement source job');
  assert.equal(finishWakes(f, state.id).length, 0, 'no idle finish wake after landing');
  t.diagnostic(JSON.stringify({ recoveryTicks: ticks }));
});

test('a step that keeps failing re-arms the compose watchdog only inside its bounded window', async t => {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  await f.drain();
  f.moveMain();
  await f.passChecks();
  await untilStep(f);
  const startedAt = Date.now();
  let finishTicks = 0,
    steps = 0;
  for (let tick = 0; f.pending().length; tick++) {
    assert(tick < 200, 'no unbounded poller');
    const task = f.pending()[0];
    if (task.name === 'projectConvexSource:step') {
      steps++;
      await assert.rejects(f.execute(task, 'step-fetch-failed'), /fetch failed/);
      continue;
    }
    if (task.name === 'projectHostedFinishDriver:drive') finishTicks++;
    await f.execute(task);
  }
  // 120 s ticks for 30 minutes, plus the one stall-alarm repair.
  const budget = HOSTED_FINISH_COMPOSE_WATCH_WINDOW_MS / HOSTED_FINISH_COMPOSE_WATCHDOG_MS + 2;
  assert(finishTicks <= budget, `${finishTicks} finish ticks`);
  assert(steps <= budget + 1, `${steps} step retries`);
  assert(Date.now() - startedAt <= HOSTED_FINISH_COMPOSE_WATCH_WINDOW_MS + HOSTED_FINISH_COMPOSE_WATCHDOG_MS);
  const current = await f.current(state.id);
  assert.notEqual(current.submission.phase, 'landed');
  assert(current.submission.observation.stall, 'the stall stays visible once the window closes');
  t.diagnostic(JSON.stringify({ finishTicks, steps, budget }));
});
