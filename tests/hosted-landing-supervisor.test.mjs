// SPDX-License-Identifier: Apache-2.0
// Issue 19328518: no single driver can strand a landing. Each test loses or
// breaks one driver (finish step, queue claim/advance, check callback, compose
// wake, the supervisor's own repair) and replays the historical stall it
// matches. Recovery must be server-side, bounded in time and calls, never land
// twice, and end a permanent fault with a typed reason and an owner alert.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { finishFixture, desired } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
import { LANDING_STALL_MS } from '../dist/landing-stall.js';
const landingDriver = await import(moduleUrl('../convex/projectHostedLandingDriver.ts'));
const control = await import(moduleUrl('../convex/projectHostedLandingControl.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const stateOf = (f, id) => states(f).find(s => s.id === id);
const rowOf = (f, id) => [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === id);
const runOwner = (f, run) =>
  [...f.tables.projectHostedLandingAttempts.values()].find(
    row => JSON.parse(row.value).check?.runId === run.id,
  )?.submissionId;
const settled = s => s.phase === 'landed' || s.phase === 'terminal-failed';
/** The task ran and threw: nothing of it commits, and Convex never retries it. */
const lose = (f, task) => f.patch('_scheduled_functions', task._id, { state: { kind: 'failed' } });
const enableAlerts = f => {
  const project = [...f.tables.hostedProjects.values()].find(row => row._id === f.projectId);
  const policy = project.autonomyPolicy ?? policyPreset('trusted');
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...policy, agentDefaults: { ...policy.agentDefaults, stallAlerts: { enabled: true } } },
  });
};
const supervisorCalls = (f, from) =>
  f.counts.slice(from).filter(c => ['landingAlarm', 'landingDeadline', 'landingRepair'].includes(c.name))
    .length;

/** Run the queue with real checks passing (once `pass()` allows). `inject(task)`
 * may lose a task (return true) before it runs; stops when every entry settled. */
async function run(f, inject = () => false, max = 600, pass = () => true) {
  for (let tick = 0; ; tick++) {
    assert(tick < max, JSON.stringify(states(f).map(s => [s.id.slice(0, 8), s.phase, s.error?.code])));
    if (pass())
      for (const r of f.runs().filter(r => r.status === 'queued'))
        await f.rawChecks.pass(await f.rawChecks.activate(r.id));
    const task = f.pending()[0];
    if (!task) break;
    if (await inject(task)) continue;
    await f.execute(task);
    if (states(f).every(settled)) break;
  }
}
const isFinish = (task, id) =>
  task.name === 'projectHostedFinishDriver:drive' && task.args[0].submissionId === id;
const isRepair = (task, id) =>
  task.name === 'projectHostedLandingStall:repair' && task.args[0].submissionId === id;

async function twoEntries(t, options = {}) {
  const f = await batchesFixture(t, { count: 2, batching: false, requestCheck: true, ...options });
  const [head, behind] = f.entries.map(entry => entry.state.id);
  return { f, head, behind };
}
/** One entry: no peer landing moves main and re-drives it, so only the
 * supervisor can recover it. */
async function oneEntry(t) {
  const f = await batchesFixture(t, { count: 1, batching: false, requestCheck: true });
  return { f, head: f.entries[0].state.id };
}

test('incident replay 2026-10-26 10:20: a Ready head whose settlement step died is re-driven by the stall alarm', async t => {
  // Then: the owner landing worker parked on an error while settling a passed
  // batch; nothing woke it. Hosted shape: the head's finish step task fails.
  // The stall write's own finish wake is lost too, so only a supervisor round
  // (not the alarm's incidental wake) can resume it.
  const { f, head } = await oneEntry(t);
  let lostAt = null,
    losses = 0;
  await run(f, task => {
    if (losses < 2 && isFinish(task, head) && stateOf(f, head).phase === 'ready') {
      lose(f, task);
      lostAt ??= Date.now();
      losses++;
      return true;
    }
    return false;
  });
  assert.equal(losses, 2, 'the replay lost the settlement step and the alarm wake');
  assert.equal(stateOf(f, head).phase, 'landed', 'the supervisor re-drives the passed head');
  const landedAt = Date.parse(stateOf(f, head).timing.committedAt);
  assert(
    landedAt - lostAt <= 2 * LANDING_STALL_MS + 5 * 60_000,
    `resumed ${landedAt - lostAt} ms after the loss`,
  );
  assert.equal(f.tables.projectHostedAcceptances.size, 1, 'accepted exactly once');
});

test('replay 2026-11-05 88-minute landing: a Ready head whose finish stopped without a next step is re-driven', async t => {
  // A step that ran but scheduled nothing leaves a succeeded wake: not a failed
  // task, so the old lost-step repair (72d50375) did not see it either.
  // The stall write's wake parks the same way, so only a supervisor round can
  // see that no finish step is pending.
  const { f, head } = await oneEntry(t);
  let parkedAt = null,
    parked = 0;
  await run(f, task => {
    if (parked < 2 && isFinish(task, head) && stateOf(f, head).phase === 'ready') {
      f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
      parkedAt ??= Date.now();
      parked++;
      return true;
    }
    return false;
  });
  assert.equal(parked, 2);
  assert.equal(stateOf(f, head).phase, 'landed');
  const landedAt = Date.parse(stateOf(f, head).timing.committedAt);
  assert(
    landedAt - parkedAt <= 2 * LANDING_STALL_MS + 5 * 60_000,
    `resumed ${landedAt - parkedAt} ms after parking`,
  );
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
});

test('incident replay 2026-10-30 13:23/14:20: a step that fails on every retry ends with a typed reason and an alert', async t => {
  // Then: a source step action died on a non-Forge error, nothing retried it,
  // and the 15-minute alarm retry crashed the same way; the queue stalled.
  const { f, head, behind } = await twoEntries(t);
  enableAlerts(f);
  let firstLoss = null,
    losses = 0;
  const calls = f.counts.length;
  await run(f, task => {
    if (isFinish(task, head) && stateOf(f, head).phase === 'ready') {
      firstLoss ??= Date.now();
      losses++;
      lose(f, task);
      return true;
    }
    return false;
  });
  const ended = stateOf(f, head);
  assert.equal(ended.phase, 'terminal-failed', 'a permanent fault never stays pending');
  assert.equal(ended.error.code, 'LANDING_DRIVER_EXHAUSTED');
  assert.match(ended.error.message, /re-drove the lost finish step 2 times/);
  assert.match(ended.error.message, /finish the same Lane again/i);
  assert.equal(stateOf(f, behind).phase, 'landed', 'the queue moves on past the ended head');
  const endedAt = Date.parse(ended.timing.settledAt);
  assert(
    endedAt - firstLoss <= 4 * LANDING_STALL_MS,
    `ended ${(endedAt - firstLoss) / 60_000} min after the fault`,
  );
  assert(losses <= 3, `${losses} replays of the failing step`);
  const operation = [...f.tables.projectHostedOperations.values()]
    .map(row => JSON.parse(row.value))
    .find(op => op.operationId === ended.operationId);
  assert.equal(
    operation.terminal.outcome.error.code,
    'LANDING_DRIVER_EXHAUSTED',
    'the requester gets the reason',
  );
  const cap = [...f.tables.projectHostedStallAlerts.values()].filter(row => row.tier === 3);
  assert.equal(cap.length, 1, 'the stall alert fires once on the cap');
  assert.match(JSON.parse(cap[0].value).text, /^Landing ended: /);
  assert(f.metrics.stallDeliveries.some(d => d.subject.startsWith('[Forge] Landing ended:')));
  // Budget per stuck entry: alarm + 3 rounds + 3 repairs.
  const used = supervisorCalls(f, calls);
  t.diagnostic(JSON.stringify({ supervisorCalls: used, losses }));
  assert(used <= 8, `${used} supervisor calls for one stuck entry`);
});

test('incident replay 2026-10-30 14:20: the supervisor survives its own repair crashing', async t => {
  // The repair runs apart from the stall alarm, so a crashing repair cannot
  // take the alarm, its alert and the next supervisor round down with it.
  const { f, head } = await oneEntry(t);
  enableAlerts(f);
  let lost = false,
    crashed = 0;
  await run(f, task => {
    // The finish fault is permanent (the stall write's own wake fails too), so
    // only the supervisor's rounds can end the entry.
    if (isFinish(task, head) && stateOf(f, head).phase === 'ready') {
      lost = true;
      lose(f, task);
      return true;
    }
    if (isRepair(task, head) && task.args[0].mode !== 'exhaust') {
      crashed++;
      lose(f, task);
      return true;
    }
    return false;
  });
  assert.equal(crashed, 2, 'two crashed repairs prove the fault');
  const ended = stateOf(f, head);
  assert.equal(ended.error?.code, 'LANDING_DRIVER_EXHAUSTED');
  assert.match(ended.error.message, /repair of this landing crashed 2 times in a row at ready/);
  assert.equal([...f.tables.projectHostedStallAlerts.values()].filter(row => row.tier === 1).length, 1);
});

test('the supervisor stops after its ending crashes too: bounded rounds, the cap alert already sent', async t => {
  const { f, head } = await oneEntry(t);
  enableAlerts(f);
  let lost = false;
  const calls = f.counts.length;
  await run(f, task => {
    // The finish fault is permanent (the stall write's own wake fails too), so
    // only the supervisor's rounds can end the entry.
    if (isFinish(task, head) && stateOf(f, head).phase === 'ready') {
      lost = true;
      lose(f, task);
      return true;
    }
    if (isRepair(task, head)) {
      lose(f, task);
      return true;
    }
    return false;
  });
  assert.equal(stateOf(f, head).phase, 'ready', 'nothing could commit the ending');
  assert.equal([...f.tables.projectHostedStallAlerts.values()].filter(row => row.tier === 3).length, 1);
  assert(
    !f.pending().some(task => task.name.startsWith('projectHostedLandingStall:')),
    'no supervisor timer remains',
  );
  assert(supervisorCalls(f, calls) <= 6, 'bounded rounds');
});

/** Lose the queue advance for `id`: the claim commits, then the advance throws
 * and rolls back, every time (a permanent non-Forge fault in the controller). */
async function claimThenThrow(f, task, id, kills) {
  if (task.name !== 'projectHostedLandingDriver:drive') return false;
  f.advanceClock(Math.max(0, task.scheduledTime - Date.now()));
  const claim = await f.transaction('test-claim', landingDriver.claim, task.args[0]);
  if (claim?.submissionId !== id || kills.count >= kills.max) {
    if (claim) await f.transaction('test-advance', landingDriver.advance, claim);
    f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
    return true;
  }
  kills.count++;
  kills.at.push(Date.now());
  lose(f, task);
  return true;
}

test('a queue advance that throws every time is capped: the lease re-claims back off, then the entry ends', async t => {
  const { f, head, behind } = await twoEntries(t);
  const kills = { count: 0, max: Infinity, at: [] };
  await run(f, task => claimThenThrow(f, task, head, kills), 400);
  const ended = stateOf(f, head);
  assert.equal(ended.phase, 'terminal-failed', 'no endless 30-second re-claim loop');
  assert.equal(ended.error.code, 'LANDING_DRIVER_EXHAUSTED');
  assert.match(ended.error.message, /controller step failed 4 times in a row/);
  assert.equal(kills.count, control.LANDING_LEASE_RETRIES + 1, 'one claim plus the capped re-claims');
  const gaps = kills.at.slice(1).map((at, i) => at - kills.at[i]);
  for (let i = 1; i < gaps.length; i++) assert(gaps[i] > gaps[i - 1], `the watchdog backs off: ${gaps}`);
  assert(kills.at.at(-1) - kills.at[0] < LANDING_STALL_MS, 'ended within the stall window');
  assert.equal(stateOf(f, behind).phase, 'landed', 'the queue is released to the next entry');
});

test('incident replay 2026-10-27 05:56: a controller killed once after its claim resumes; nothing is cancelled', async t => {
  // Then: a release restart killed the controller and the checking entry was
  // cancelled. A transient kill must resume the same attempt, not end it.
  const { f, head, behind } = await twoEntries(t);
  const kills = { count: 0, max: 1, at: [] };
  await run(f, task => claimThenThrow(f, task, head, kills), 400);
  assert.equal(kills.count, 1);
  assert.equal(stateOf(f, head).phase, 'landed');
  assert.equal(stateOf(f, behind).phase, 'landed');
  const queue = [...f.tables.projectHostedLandingQueues.values()][0];
  assert.equal(queue.lease, null, 'the lease and its retry count are gone after landing');
});

test('incident replay 2026-10-26 11:16/12:2x: a lost check callback is replayed by the supervisor, not the 12 h watchdog', async t => {
  // Then: checks stayed running up to 63 min after CI finished because the
  // observer was starved. Hosted shape: the check-completion wake task fails.
  const { f, head } = await oneEntry(t);
  let lostAt = null;
  await run(
    f,
    task => {
      if (lostAt === null && task.name === 'projectHostedLandingDriver:checkWake') {
        const r = f.runs().find(r => r.id === task.args[0].runId);
        if (r && runOwner(f, r) === head && r.status === 'passed') {
          lose(f, task);
          lostAt = Date.now();
          return true;
        }
      }
      return false;
    },
    600,
    // CI finishes only after the queue dispatched the entry into checking.
    () => stateOf(f, head).phase === 'checking',
  );
  assert(lostAt !== null, 'the replay lost the check completion wake');
  assert.equal(stateOf(f, head).phase, 'landed');
  const landedAt = Date.parse(stateOf(f, head).timing.committedAt);
  assert(
    landedAt - lostAt <= LANDING_STALL_MS + 5 * 60_000,
    `resumed ${(landedAt - lostAt) / 60_000} min later`,
  );
});

test('a lost compose wake of a goal is replayed by the stall alarm', async t => {
  const f = await finishFixture(t),
    command = {
      operationId: randomUUID(),
      authorityEpoch: 1,
      composeOperationId: f.selection.request.operationId,
      after: null,
      check: f.request().check,
    };
  await f.tx('desiredSubmit', desired.submit, { projectId: f.projectId, request: JSON.stringify(command) });
  let lost = false;
  for (let tick = 0; tick < 200; tick++) {
    for (const row of [...f.tables.projectHostedCheckRuns.values()]) {
      const r = JSON.parse(row.value);
      if (r.status === 'queued') await f.rawChecks.pass(await f.rawChecks.activate(r.id));
    }
    const task = f.pending()[0];
    if (!task) break;
    if (!lost && task.name === 'projectHostedLandingDesired:drive') {
      lost = true;
      lose(f, task);
      continue;
    }
    await f.execute(task);
  }
  assert(lost);
  const row = [...f.tables.projectHostedLandingRequests.values()].find(
    r => r.operationId === command.operationId,
  );
  assert(row, 'the goal was admitted after its compose wake was replayed');
  assert.equal(JSON.parse(row.value).phase, 'landed');
});

test('a healthy landing never runs the supervisor, and an idle queue schedules nothing', async t => {
  const { f, head, behind } = await twoEntries(t);
  const calls = f.counts.length;
  await run(f);
  await f.drain();
  assert.equal(stateOf(f, head).phase, 'landed');
  assert.equal(stateOf(f, behind).phase, 'landed');
  assert.equal(supervisorCalls(f, calls), 0, '0 supervisor calls per healthy landing');
  assert.equal(f.pending().length, 0, 'idle: 0 scheduled functions');
});
