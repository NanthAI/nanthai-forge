// SPDX-License-Identifier: Apache-2.0
// L1 (Item 687d1eda, option B; reviews e7137e30 and a66aa1ce): the inspector's own branches, each
// with a case that must pass and one that must fail, on stored rows of a real parked queue. A
// branch that silently excuses a dead chain would let a stranded follower through every sim seed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { l1Issue, liveCheck, requestRows, STALL_MS, CHECK_WALL_MS } from './queue-sim/invariants.mjs';
import { parkedBehindHead, setMainRed } from './queue-sim/chain-scenarios.mjs';
const environment = { ...synthetic, FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-l1-invariant' };
const prior = Object.fromEntries(Object.keys(environment).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, environment));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const row = (f, id) => requestRows(f).find(r => r.submissionId === id);
const finish = (f, id) => [...f.tables.projectHostedFinishes.values()].find(r => r.submissionId === id);
let tasks = 0;
/** An armed scheduled task, as the fixture scheduler stores one. */
function task(f, name, args = {}, at = Date.now() + 60_000) {
  const _id = `l1-task-${++tasks}`;
  f.tables._scheduled_functions.set(_id, {
    _id,
    name,
    args: [args],
    scheduledTime: at,
    state: { kind: 'pending' },
  });
  return _id;
}
const cancel = (f, id) => id && f.patch('_scheduled_functions', id, { state: { kind: 'canceled' } });
/** Remove every driver the row owns: its alarm, its finish wake and its queue runnability. */
function quiet(f, id) {
  cancel(f, row(f, id).alarm?.taskId);
  cancel(f, finish(f, id)?.wake?.taskId);
  f.patch('projectHostedLandingRequests', row(f, id)._id, { runnable: false });
}
const setAlarm = (f, id, taskId) =>
  f.patch('projectHostedLandingRequests', row(f, id)._id, { alarm: { ...row(f, id).alarm, taskId } });
const setWake = (f, id, taskId) => {
  const current = finish(f, id);
  const at = f.tables._scheduled_functions.get(taskId).scheduledTime;
  f.patch('projectHostedFinishes', current._id, { wake: { id: current.wake?.id ?? 'l1-wake', taskId, at } });
};
const savedRun = (f, id) =>
  [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === row(f, id).runId);
function setRun(f, id, change) {
  const saved = savedRun(f, id);
  const run = JSON.parse(saved.value);
  change(run);
  f.patch('projectHostedCheckRuns', saved._id, { value: JSON.stringify(run) });
  return run;
}
function setState(f, id, change) {
  const current = row(f, id);
  const state = JSON.parse(current.value);
  change(state);
  f.patch('projectHostedLandingRequests', current._id, { value: JSON.stringify(state) });
}
const l1 = (f, id) => {
  const rows = requestRows(f);
  const queue = [...f.tables.projectHostedLandingQueues.values()].find(r => r.projectId === f.projectId);
  return l1Issue(
    f,
    rows.find(r => r.submissionId === id),
    new Map(rows.map(r => [r.submissionId, r])),
    queue,
  );
};
/** The newest follower waits on the checking head; neither owns a driver yet. */
async function undrivenChain(t) {
  const { f, head, followers } = await parkedBehindHead(t);
  const waiter = followers[1];
  f.patch('projectHostedLandingRequests', row(f, waiter)._id, { orderWait: head });
  quiet(f, head);
  quiet(f, waiter);
  setRun(f, head, run => {
    run.actions = {};
    delete run.lease;
    delete run.ownerDeadline;
  });
  assert.equal(row(f, head).phase, 'checking');
  return { f, head, waiter, followers };
}

test('L1 liveCheck: only a checking entry whose run has a bounded driver', async t => {
  const { f, head } = await undrivenChain(t);
  assert.equal(liveCheck(f, row(f, head)), false, 'a running run alone drives nothing');
  const confirm = task(f, 'projectHostedCheckRun:confirm');
  setRun(f, head, run => (run.actions = { confirm }));
  assert.equal(liveCheck(f, row(f, head)), true, 'an armed verdict confirmation');
  f.patch('projectHostedLandingRequests', row(f, head)._id, { phase: 'queued' });
  assert.equal(liveCheck(f, row(f, head)), false, 'only while the entry is checking');
  f.patch('projectHostedLandingRequests', row(f, head)._id, { phase: 'checking' });
  cancel(f, confirm);
  assert.equal(liveCheck(f, row(f, head)), false, 'a cancelled confirmation');
  const watchdog = task(f, 'projectHostedCheckRun:watchdog');
  setRun(f, head, run => (run.actions = { watchdog, outcome: 'unknown' }));
  assert.equal(liveCheck(f, row(f, head)), false, 'a watchdog before the provider accepted the dispatch');
  setRun(f, head, run => (run.actions = { watchdog, outcome: 'accepted' }));
  assert.equal(liveCheck(f, row(f, head)), true, 'a watchdog once the dispatch was accepted');
  cancel(f, watchdog);
  const until = Date.now() + 60_000;
  const run = setRun(f, head, value => {
    value.actions = {};
    value.lease = { until };
    value.fence = 7;
  });
  assert.equal(liveCheck(f, row(f, head)), false, 'a bare lease timestamp');
  task(f, 'projectHostedCheckRun:anything', { runId: run.id });
  assert.equal(liveCheck(f, row(f, head)), false, 'any other task naming the run');
  const stale = task(f, 'projectHostedCheckLease:expire', { runId: run.id, fence: 7, until: until + 1 });
  assert.equal(liveCheck(f, row(f, head)), false, 'an expiry for another until');
  cancel(f, stale);
  task(f, 'projectHostedCheckLease:expire', { runId: run.id, fence: 6, until });
  assert.equal(liveCheck(f, row(f, head)), false, 'an expiry for another fence');
  task(f, 'projectHostedCheckLease:expire', { runId: run.id, fence: 7, until });
  assert.equal(liveCheck(f, row(f, head)), true, 'the lease with its exact armed expiry');
  setRun(f, head, value => (value.lease = { until: Date.now() - 1 }));
  task(f, 'projectHostedCheckLease:expire', { runId: run.id, fence: 7, until: Date.now() - 1 });
  assert.equal(liveCheck(f, row(f, head)), true, 'just past until, the armed expiry still owns the lease');
});

test('L1 chain ends: a dead end fails whatever the claim; only a near claim excuses an undriven end', async t => {
  const { f, head, waiter } = await undrivenChain(t);
  assert.match(l1(f, waiter), /undriven/, 'an undriven end with no claim');
  setWake(f, waiter, task(f, 'projectHostedFinishDriver:wake', {}, Date.now() + CHECK_WALL_MS - 1000));
  assert.equal(l1(f, waiter), null, "the waiter's own claim within one check wall");
  quiet(f, waiter);
  setWake(f, waiter, task(f, 'projectHostedFinishDriver:wake', {}, Date.now() + CHECK_WALL_MS + 60_000));
  assert.match(l1(f, waiter), /undriven/, 'a claim later than one check wall is a timer, not a driver');
  setAlarm(f, head, task(f, 'projectHostedLandingStall:raise', {}, Date.now() + STALL_MS));
  assert.equal(l1(f, waiter), null, "the end's armed stall alarm drives the chain");
  // Dead ends, each with the waiter holding an immediate claim.
  quiet(f, waiter);
  setWake(f, waiter, task(f, 'projectHostedFinishDriver:wake', {}, Date.now()));
  f.patch('projectHostedLandingRequests', row(f, head)._id, { phase: 'landed' });
  assert.match(l1(f, waiter), /landed/, 'a terminal end');
  f.patch('projectHostedLandingRequests', row(f, head)._id, { phase: 'checking', orderWait: waiter });
  assert.match(l1(f, waiter), /cycle/, 'a looping chain');
  f.patch('projectHostedLandingRequests', row(f, head)._id, { orderWait: undefined });
  f.patch('projectHostedLandingRequests', row(f, waiter)._id, { orderWait: 'missing-submission' });
  assert.match(l1(f, waiter), /missing/, 'a missing end');
  f.patch('projectHostedLandingRequests', row(f, waiter)._id, { orderWait: head });
  assert.equal(l1(f, waiter), null, 'control: the driven head again');
  f.patch('projectHostedLandingRequests', row(f, head)._id, { hold: 'main-red' });
  setMainRed(f);
  assert.match(l1(f, waiter), /holds no order/, 'an end held for red main, though itself live');
});

test('L1 hops: a live landing reservation still parks waiters; an expired or held one does not', async t => {
  const { f, head, waiter } = await undrivenChain(t);
  setAlarm(f, head, task(f, 'projectHostedLandingStall:raise', {}, Date.now() + STALL_MS));
  f.patch('projectHostedLandingRequests', row(f, head)._id, { reservedUntil: undefined });
  assert.equal(l1(f, waiter), null, 'control: the driven head holds the order');
  setState(f, head, state => (state.observation.pendingReason = 'waiting-for-dependency'));
  assert.match(l1(f, waiter), /holds no order/, 'a dependency wait gives up its order place');
  f.patch('projectHostedLandingRequests', row(f, head)._id, { reservedUntil: Date.now() + 10 * 60_000 });
  assert.equal(l1(f, waiter), null, 'its live reservation still parks same-file waiters');
  f.patch('projectHostedLandingRequests', row(f, head)._id, { reservedUntil: Date.now() - 1 });
  assert.match(l1(f, waiter), /holds no order/, 'an expired reservation');
  f.patch('projectHostedLandingRequests', row(f, head)._id, {
    reservedUntil: Date.now() + 10 * 60_000,
    hold: 'main-red',
  });
  assert.match(l1(f, waiter), /holds no order/, 'a reservation held for red main holds nothing');
});

test('L1 waits: a red-main hold and a dependency wait need an event that still has an owner', async t => {
  const { f, head, followers } = await undrivenChain(t);
  const held = followers[0];
  quiet(f, held);
  f.patch('projectHostedLandingRequests', row(f, held)._id, { orderWait: undefined, hold: 'main-red' });
  assert.match(l1(f, held), /red main/, 'held while main is green with no release page');
  task(f, 'projectHostedMainAudit:releaseHeld', { projectId: 'another-project' });
  assert.match(l1(f, held), /red main/, "another project's release page");
  const release = task(f, 'projectHostedMainAudit:releaseHeld', { projectId: f.projectId });
  assert.equal(l1(f, held), null, 'an armed release page');
  cancel(f, release);
  setMainRed(f);
  assert.equal(l1(f, held), null, 'main is red: the release on green owns it');
  // A dependency waiter on the checking head.
  f.patch('projectHostedLandingRequests', row(f, held)._id, { hold: undefined });
  f.patch('projectHostedFinishes', finish(f, held)._id, { waiting: true, parentSubmissionId: head });
  assert.match(l1(f, held), /dependency/, 'a parent that owns no progress');
  setAlarm(f, head, task(f, 'projectHostedLandingStall:raise', {}, Date.now() + STALL_MS));
  assert.equal(l1(f, held), null, 'a live parent');
  quiet(f, head);
  f.patch('projectHostedLandingRequests', row(f, head)._id, { phase: 'terminal-failed' });
  assert.match(l1(f, held), /dependency/, 'an ended parent with no dependents page');
  task(f, 'projectHostedFinishDriver:dependents', { submissionId: 'another-submission' });
  assert.match(l1(f, held), /dependency/, "another parent's dependents page");
  task(f, 'projectHostedFinishDriver:dependents', { submissionId: head });
  assert.equal(l1(f, held), null, "an ended parent's armed dependents page");
});
