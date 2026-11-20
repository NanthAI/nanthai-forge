// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { scaleFixture, saveInput } from './convex-source-scale-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const store = await import(moduleUrl('../convex/projectConvexSourceStore.ts'));
const active = await import(moduleUrl('../convex/projectConvexSourceActive.ts'));
const { keepSourceLease } = await import(moduleUrl('../src/hosted-source-lease.ts'));

// Incident e62d834b (2026-11-20 03:37Z): source steps took 50-100 s, the worker lease was a fixed 60 s
// set once at dispatch, and a step that ran past it was fenced while still working. The fenced failure
// was not recorded and only a client lookup rescheduled it, so three landings sat in source preparation
// for over 50 minutes. These replays scale the clock down: the lease is LEASE_MS and every source read
// takes READ_DELAY_MS, so each step outlives the lease it started with, as the 90 s steps did.
const LEASE_MS = 1_500,
  READ_DELAY_MS = 2_000;
const row = (s, jobId) => s.run('row', () => active.rowFor(s.ctx, s.projectId, jobId));
const renewCalls = s => s.calls.filter(name => name === 'projectConvexSourceLease:renew').length;

test('incident replay e62d834b: a step that runs past its worker lease keeps it and finishes', async () => {
  const s = await scaleFixture({ workerLeaseMs: LEASE_MS, delay: READ_DELAY_MS });
  try {
    const jobId = await s.enqueue(await saveInput(s, 2));
    const result = await s.drain();
    assert(result.maxStepMs > LEASE_MS, `the step outlived the lease (${result.maxStepMs} ms)`);
    const job = await s.job(jobId);
    assert.equal(job.status, 'completed', 'no step was fenced while it was working');
    assert.equal(result.failedActions, 0);
    assert.equal((await row(s, jobId)).failedAttempts, undefined, 'no failure was recorded');
    assert(renewCalls(s) > 0, 'the step renewed its own lease');
  } finally {
    s.restore();
  }
});

test('incident replay e62d834b: a step fenced by its lease is recorded and retried by the server, with no client lookup', async () => {
  const s = await scaleFixture({ workerLeaseMs: LEASE_MS, delay: READ_DELAY_MS });
  try {
    const jobId = await s.enqueue(await saveInput(s, 2));
    // The first attempt's renewals are lost, so it runs past its lease and is fenced mid-step.
    const lost = (message, item) =>
      message.kind === 'mutation' &&
      message.args.name === 'projectConvexSourceLease:renew' &&
      (item.args.generation ?? 0) === 0;
    for (let i = 0; i < 100; i++) s.failRequestOnce.push(lost);
    const result = await s.drain();
    assert(result.failedActions >= 1, 'the first attempt was fenced');
    s.failRequestOnce.length = 0;
    assert(!s.calls.includes('projectConvexSourceStore:lookup'), 'no client lookup ran');
    const job = await s.job(jobId);
    assert.equal(job.status, 'completed', 'the server retried the fenced step on its own');
    const retries = [...s.scheduled.values()].filter(
      item => /^projectConvexSource(Node)?:step$/.test(item.name) && (item.args.generation ?? 0) > 0,
    );
    assert(retries.length >= 1, 'the retry is a new generation of the same execution');
    assert.equal(s.tables.projectSourceSteps.size, 1, 'the same source execution resumed');
  } finally {
    s.restore();
  }
});

test('incident replay e62d834b: a dead worker is retried by the server repair the landing watchdog runs, within its failure backoff', async () => {
  const s = await scaleFixture({ workerLeaseMs: LEASE_MS });
  const real = Date.now;
  let offset = 0;
  Date.now = () => real() + offset;
  try {
    const jobId = await s.enqueue(await saveInput(s, 2));
    // The step action dies before it records anything (a killed or timed-out action).
    s.failOnce.push(item => /^projectConvexSource(Node)?:step$/.test(item.name));
    await s.drain();
    assert.equal((await s.job(jobId)).status, 'running', 'the dead step left its job running');
    const stranded = [...s.scheduled.values()].filter(
      item => /^projectConvexSource(Node)?:step$/.test(item.name) && item.state.kind === 'pending',
    );
    assert.equal(stranded.length, 0, 'nothing re-drives the dead step by itself');
    // The landing watchdog's wake (advance) runs this repair while its compose is not terminal, and
    // only once the worker lease has expired: while it is live the repair reads nothing more and
    // schedules nothing.
    const watchdog = label =>
      s.run(label, () =>
        store.repairConvexSource(s.ctx, { projectId: s.projectId, jobId }, { expiredOnly: true }),
      );
    const before = s.scheduled.size;
    if ((await s.job(jobId)).control.workerUntil > Date.now()) {
      await watchdog('watchdog-live-lease');
      assert.equal(s.scheduled.size, before, 'a live lease is left alone');
    }
    // The dead worker renews nothing, so its lease lapses within one lease length.
    offset += LEASE_MS + 1;
    assert((await s.job(jobId)).control.workerUntil <= Date.now(), 'the lease lapses within one lease');
    await watchdog('watchdog-repair');
    const [retry] = [...s.scheduled.values()].filter(
      item => /^projectConvexSource(Node)?:step$/.test(item.name) && item.state.kind === 'pending',
    );
    assert(retry, 'the repair scheduled the step again');
    assert.equal(retry.args.generation, 1);
    assert(retry.delayMs <= 2_000, `retried within the first failure backoff (${retry.delayMs} ms)`);
    // A second repair while that retry is pending changes nothing.
    const scheduled = s.scheduled.size;
    await watchdog('watchdog-repair-again');
    assert.equal(s.scheduled.size, scheduled, 'a pending retry is left alone');
    await s.drain();
    assert.equal((await s.job(jobId)).status, 'completed');
    assert.equal(s.tables.projectSourceSteps.size, 1);
  } finally {
    Date.now = real;
    s.restore();
  }
});

test('a step that finishes inside the first half of its lease makes no renewal call, whatever its own clock says', async t => {
  // The action's clock is far from the server's (the deadline begin read would look long past);
  // renewals are timed from the lease time left that begin measured, on the action's own timers.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 365 * 24 * 3600 * 1000 });
  let calls = 0;
  const renew = async () => {
    calls++;
    return true;
  };
  const quick = keepSourceLease(renew, { ms: 60_000, remainingMs: 60_000 });
  t.mock.timers.tick(29_999);
  await quick();
  assert.equal(calls, 0, 'a healthy step makes zero extra control calls');
  const slow = keepSourceLease(renew, { ms: 60_000, remainingMs: 60_000 });
  t.mock.timers.tick(30_000);
  assert.equal(calls, 1, 'a step past half its lease renews once');
  await slow();
  t.mock.timers.tick(60_000);
  assert.equal(calls, 1, 'nothing renews after the step ends');
  // A step that began with little of its lease left renews at half of that, not after 30 s.
  const late = keepSourceLease(renew, { ms: 60_000, remainingMs: 4_000 });
  t.mock.timers.tick(2_000);
  assert.equal(calls, 2);
  await late();
});
