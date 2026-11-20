// SPDX-License-Identifier: Apache-2.0
// Incident e62d834b, line 5 (2026-11-20 05:27-06:41Z): every landing check ended RUNNER_UNAVAILABLE, so
// each landing spent its platform retries on a broken CI and failed for good. The CI-down hold (switch
// FORGE_QUEUE_HOLD_ON_CI_DOWN, off by default) parks them under one reason instead, probes CI with one
// held entry on a backoff, and releases the rest on the first verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { l1Issue } from './queue-sim/invariants.mjs';
const queueView = await import(moduleUrl('../convex/projectHostedQueueView.ts'));
const { landingHold, holdLines } = await import(moduleUrl('../src/hosted-landing-hold.ts'));
const { CI_DOWN_STREAK } = await import(moduleUrl('../convex/projectHostedLandingCiDown.ts'));
const SWITCH = 'FORGE_QUEUE_HOLD_ON_CI_DOWN';
const PROBE = 'projectHostedLandingCiDown:probe';
const prior = Object.fromEntries([...Object.keys(synthetic), SWITCH].map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.afterEach(() => delete process.env[SWITCH]);
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function fixture(t, options) {
  const f = await batchesFixture(t, options);
  f.rows = () => [...f.tables.projectHostedLandingRequests.values()].filter(r => r.projectId === f.projectId);
  f.queue = () => [...f.tables.projectHostedLandingQueues.values()].find(q => q.projectId === f.projectId);
  f.queued = () => f.runs().filter(r => r.status === 'queued');
  f.probes = () => f.pending().filter(task => task.name === PROBE);
  /** Runs every due task except the probe wake, which the test fires itself. */
  f.settle = async () => {
    for (let tick = 0; tick < 300; tick++) {
      const task = f.pending().find(item => item.name !== PROBE);
      if (!task) return;
      await f.execute(task);
    }
    assert.fail('the queue never settled');
  };
  /** CI is down: every check it is handed ends runner-unavailable. */
  f.outage = async () => {
    for (let round = 0; round < 20 && f.queued().length; round++) {
      for (const run of f.queued())
        await f.rawChecks.callback(
          f.rawChecks.complete(await f.rawChecks.activate(run.id), 'runner-unavailable'),
        );
      await f.settle();
    }
  };
  f.passAll = async () => {
    for (let round = 0; round < 20 && f.queued().length; round++) {
      for (const run of f.queued()) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
      await f.settle();
    }
  };
  f.fireProbe = async () => {
    const [probe] = f.probes();
    assert(probe, 'a probe wake is armed');
    await f.execute(probe);
    await f.settle();
  };
  return f;
}
const held = f => f.rows().filter(r => r.hold === 'ci-down' && r.phase === 'queued' && r.runnable === false);
const phases = f => JSON.stringify(states(f).map(s => [s.phase, s.error?.code]));

function assertHeldLive(f) {
  const byId = new Map(f.rows().map(row => [row.submissionId, row]));
  for (const row of held(f))
    assert.equal(l1Issue(f, row, byId, f.queue()), null, 'L1: a held row has an owner');
}

test('incident replay e62d834b line 5: a cohort whose CI fails every check waits under one CI-down reason, then lands when CI runs again', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 4 });
  await f.settle();
  assert.equal(f.queued().length, 1, 'one shared check for the cohort');
  await f.outage();
  // Before: the cohort spent its two platform retries and every member ended CHECK_NOT_PASSED.
  assert(
    states(f).every(state => state.phase === 'queued'),
    `not terminal-failed: the changes were never judged ${phases(f)}`,
  );
  assert.equal(held(f).length, 4, 'every member waits under the CI-down hold');
  for (const state of states(f)) {
    assert.equal(state.error.code, 'CI_DOWN');
    assert.match(
      state.error.message,
      /CI is failing for every check: the last 3 landing checks ended without a verdict \(latest: runner-unavailable\)/,
    );
    const hold = landingHold(state);
    assert.equal(hold.kind, 'ci-down');
    assert.match(holdLines(hold)[0], /^HELD: CI IS DOWN; not landed yet/);
  }
  assert.equal(f.runs().length, CI_DOWN_STREAK, 'the shared check and its two retries; no solo re-checks');
  for (const row of f.rows()) assert.equal(row.alarm ?? null, null, 'an event wait holds no stall alarm');
  const queue = f.queue();
  assert.equal(queue.ciDown.streak, CI_DOWN_STREAK);
  assert.equal(f.probes().length, 1, 'one probe wake for the whole queue');
  assert.equal(f.probes()[0].scheduledTime, queue.ciDown.probeAt, 'the queue row names the next probe');
  assertHeldLive(f);
  const view = JSON.parse(await f.transaction('queue-view', queueView.read, { projectId: f.projectId }));
  assert.equal(view.ciDown?.streak, CI_DOWN_STREAK, 'the queue reply names the hold');
  assert.match(view.ciDown.reason, /CI is failing for every check/);

  // A probe while CI is still down: one entry checks again and parks again; the next probe waits longer.
  await f.fireProbe();
  assert.equal(f.queued().length, 1, 'the probe released one held entry');
  await f.outage();
  assert.equal(held(f).length, 4, JSON.stringify(phases(f)));
  assert.equal(f.probes().length, 1);
  assert.equal(f.queue().ciDown.probes, 1);
  assertHeldLive(f);

  // CI recovers: the probe's check passes, the hold ends and every held entry lands.
  await f.fireProbe();
  await f.passAll();
  assert(
    states(f).every(state => state.phase === 'landed'),
    phases(f),
  );
  assert.equal(f.queue().ciDown, undefined, 'the verdict ended the hold');
  assert.equal(f.probes().length, 0, 'nothing is left armed (idle costs nothing)');
  const files = JSON.parse(f.c.objects.get(f.currentMain().head)).files.map(file => file.path);
  for (let i = 0; i < 4; i++) assert(files.includes(`member-${i}`), 'every change is on main');
});

test('incident replay e62d834b line 5: one entry whose own checks all end runner-unavailable waits instead of failing', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 1 });
  await f.settle();
  await f.outage();
  assert.equal(held(f).length, 1, phases(f));
  assert.equal(states(f)[0].error.code, 'CI_DOWN');
  assert.equal(f.rows()[0].mainRedHolds, undefined, 'a CI-down park is not a main-red hold record');
  assertHeldLive(f);
  await f.fireProbe();
  await f.passAll();
  assert.equal(states(f)[0].phase, 'landed', phases(f));
  assert.equal(f.queue().ciDown, undefined);
});

test('incident replay e62d834b line 5 (review 2bf14e44 B1): a probe that ends on another infrastructure cause keeps the hold, so a later verdict releases every held entry', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 2 });
  await f.settle();
  await f.outage();
  assert.equal(held(f).length, 2, phases(f));
  await f.fireProbe();
  // The runner now dies mid-run: the probe's check ends interrupted, not runner-unavailable.
  const [probed] = f.queued();
  assert(probed, 'the probe released one held entry');
  await f.rawChecks.callback(f.rawChecks.complete(await f.rawChecks.activate(probed.id), 'interrupted'));
  await f.settle();
  // Before: the streak restarted at 1 below the trip, the probe was cancelled and the entry took its
  // platform retry; when that passed, the verdict released nothing and the other entry was stranded.
  assert.equal(held(f).length, 2, `still held under one hold ${phases(f)}`);
  assert.equal(f.queue().ciDown.cause, 'interrupted');
  assert.equal(f.probes().length, 1, 'the hold keeps its probe');
  assertHeldLive(f);
  await f.fireProbe();
  await f.passAll();
  assert(
    states(f).every(state => state.phase === 'landed'),
    phases(f),
  );
  assert.equal(f.queue().ciDown, undefined);
  assert.equal(f.probes().length, 0);
});

test('e62d834b line 5: with the switch off a CI outage fails the landings as on main, and nothing is recorded', async t => {
  const f = await fixture(t, { count: 4 });
  await f.settle();
  await f.outage();
  assert.equal(held(f).length, 0);
  assert(
    states(f).every(state => state.phase === 'terminal-failed' && state.error.code === 'CHECK_NOT_PASSED'),
    phases(f),
  );
  assert.equal(f.queue().ciDown, undefined, 'the switch off writes no streak');
  assert.equal(f.probes().length, 0);
});

test('e62d834b line 5: a healthy queue with the switch on writes no streak and arms no probe', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 4 });
  await f.settle();
  await f.passAll();
  assert(
    states(f).every(state => state.phase === 'landed'),
    phases(f),
  );
  assert.equal(f.queue().ciDown, undefined);
  assert.equal(f.probes().length, 0);
});

test('e62d834b line 5: a verdict between infrastructure ends resets the streak, so a lone outage does not trip the hold', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 1 });
  await f.settle();
  // One runner-unavailable end, then the retry passes: the streak ends at the verdict.
  const [first] = f.queued();
  await f.rawChecks.callback(
    f.rawChecks.complete(await f.rawChecks.activate(first.id), 'runner-unavailable'),
  );
  await f.settle();
  assert.equal(f.queue().ciDown?.streak, 1);
  await f.passAll();
  assert.equal(states(f)[0].phase, 'landed');
  assert.equal(f.queue().ciDown, undefined);
});

test('e62d834b line 5: a lost probe wake is armed again by the redrive backstop', async t => {
  process.env[SWITCH] = '1';
  const f = await fixture(t, { count: 1 });
  await f.settle();
  await f.outage();
  const [probe] = f.probes();
  f.patch('_scheduled_functions', probe._id, { state: { kind: 'failed' } });
  const redrive = await import(moduleUrl('../convex/projectHostedLandingRedrive.ts'));
  const [row] = held(f);
  const done = await f.tx(
    'redrive',
    {
      _handler: ctx =>
        // The stored row, read through the request-body hydration every server ctx applies.
        redrive.redriveLanding(
          ctx,
          { projectId: f.projectId, submissionId: row.submissionId },
          { queueChecked: true },
        ),
    },
    {},
  );
  assert(done.includes('ci-down'), JSON.stringify(done));
  assert.equal(f.probes().length, 1, 'a fresh probe is armed');
  assertHeldLive(f);
});

// Item 0d8a85a3 line 4: the 05:27-06:37Z timeouts came through the webhook as a job-API failure (the
// runner ended before Forge took its plan), not as runner-unavailable from the runner itself.
const checkStore = await import(moduleUrl('../convex/projectHostedCheckStore.ts'));
const direct = await import(moduleUrl('../convex/projectHostedActionsDirect.ts'));
const { jobApiReason, infraWaitSince } = await import(moduleUrl('../src/ci-provider-recovery.ts'));
const { landingStateOf } = await import(moduleUrl('../src/landing-state.ts'));
/** CI's job API hangs: every check the webhook settles ends with the job-API reason. */
async function jobApiOutage(f) {
  for (let round = 0; round < 20 && f.queued().length; round++) {
    for (const run of f.queued()) {
      await f.rawChecks.activate(run.id);
      await f.transaction(
        'job-api-timeout',
        {
          _handler: async ctx => {
            const selected = await checkStore.writableHostedCheck(ctx, {
              projectId: f.projectId,
              runId: run.id,
            });
            await direct.settleDirectActions(
              ctx,
              selected,
              'runner-unavailable',
              jobApiReason('failure', infraWaitSince(selected.run.failureReason)),
            );
          },
        },
        {},
      );
    }
    await f.settle();
  }
}
for (const on of [false, true])
  test(`incident replay 0d8a85a3 line 4: job-API timeouts ${on ? 'trip the CI-down hold, wait since its start and land on recovery' : 'without the hold fail every landing after its retries'}`, async t => {
    if (on) process.env[SWITCH] = '1';
    const f = await fixture(t, { count: 3 });
    await f.settle();
    await jobApiOutage(f);
    assert.equal(f.runs().length, CI_DOWN_STREAK, 'the shared check and its two platform retries');
    assert(
      f.runs().every(run => run.failureReason?.startsWith('Check infrastructure:')),
      'the cause is named',
    );
    if (!on) {
      assert(
        states(f).every(state => state.phase === 'terminal-failed'),
        phases(f),
      );
      return;
    }
    assert.equal(held(f).length, 3, phases(f));
    const since = infraWaitSince(states(f)[0].error.message);
    assert.match(since, /^\d\d:\d\dZ$/);
    for (const state of states(f))
      assert.equal(landingStateOf(state).label, `Waiting for check infrastructure since ${since}`);
    const view = JSON.parse(await f.transaction('queue-view', queueView.read, { projectId: f.projectId }));
    assert(
      view.entries.length &&
        view.entries.every(e => e.landingState.label === `Waiting for check infrastructure since ${since}`),
      'the Lanes page and cockpit read the same since from the queue reply',
    );
    // Still down at the first probe: one probe run, parked again; the start does not move.
    await f.fireProbe();
    await jobApiOutage(f);
    assert.equal(held(f).length, 3);
    assert.equal(infraWaitSince(states(f)[0].error.message), since);
    // Recovery: the next probe's check passes and every landing goes in, one check after recovery.
    await f.fireProbe();
    await f.passAll();
    assert(
      states(f).every(state => state.phase === 'landed'),
      phases(f),
    );
    assert.equal(
      f.runs().length,
      CI_DOWN_STREAK + 3,
      'streak + one failed probe + the passing probe + one shared check for the released rest',
    );
    assert.equal(f.probes().length, 0);
  });
