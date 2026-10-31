// SPDX-License-Identifier: Apache-2.0
// Replays Issue 108a24e3 (2026-10-30): batch members waiting for their
// individual fallback turn were orphaned when the member holding the turn was
// cancelled. The one-shot stall alarm had already fired, so nothing ever
// re-drove them and they stayed queued for 36 hours with no terminal outcome.
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, batchStore, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { LANDING_STALL_MS, LANDING_DROP_MS } from '../dist/landing-stall.js';
const stallApi = await import(moduleUrl('../convex/projectHostedLandingStall.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const retained = f => JSON.parse([...f.tables.projectHostedLandingBatches.values()][0].value);
const rowOf = (f, id) =>
  [...f.tables.projectHostedLandingRequests.values()].find(row => JSON.parse(row.value).id === id);
const stateOf = (f, id) => JSON.parse(rowOf(f, id).value);
const progressAt = state =>
  [state.at, ...Object.values(state.timing ?? {})].sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);

/** Drain without the stall timers: the runner is live and moving in real time,
 * so no 15-minute or 60-minute clock jump happens while the batch progresses. */
async function drainLive(f) {
  for (let tick = 0; f.pending().length; tick++) {
    assert(tick < 300);
    const task = f.pending()[0];
    if (task.name.startsWith('projectHostedLandingStall'))
      f.patch('_scheduled_functions', task._id, { state: { kind: 'canceled' } });
    else await f.execute(task);
  }
}
/** Batch -> fallback; the selected member runs its individual check while the
 * others wait their turn (queued, batchNeedsSoloCompose, not runnable). */
async function fallbackWithRunner(t) {
  const f = await batchesFixture(t, { count: 3 });
  await drainLive(f);
  await f.transaction(
    'fallback-trigger',
    {
      _handler: async ctx => {
        const batch = retained(f),
          key = { projectId: f.projectId, batchId: batch.id };
        await batchStore.writeBatch(ctx, key, { ...batch, phase: 'fallback' });
        await batchStore.wakeBatch(ctx, key);
      },
    },
    {},
  );
  await drainLive(f);
  const runner = states(f).find(s => s.batchSolo && !s.batchNeedsSoloCompose && s.phase !== 'landed');
  const waiting = states(f).filter(s => s.batchNeedsSoloCompose);
  assert(runner, 'one member holds the individual fallback turn');
  assert.equal(waiting.length, 2);
  for (const s of waiting) assert.equal(rowOf(f, s.id).runnable, false, 'peers wait for their turn');
  return { f, runner, waiting };
}
async function cancel(f, submissionId) {
  const { landingApi } = await import('./hosted-finish-fixture.mjs');
  await f.transaction('cancel-fallback-runner', landingApi.cancel, {
    projectId: f.projectId,
    request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId }),
  });
}
async function landRest(f) {
  for (let i = 0; i < 3; i++) {
    await f.drain();
    await f.passChecks();
  }
  await f.drain();
}

test('replay 108a24e3: cancelling the member holding the fallback turn hands the turn to a waiting member', async t => {
  const { f, runner, waiting } = await fallbackWithRunner(t);
  await cancel(f, runner.id);
  assert(f.pending().length > 0, 'cancellation itself schedules the next member; no alarm is needed');
  await landRest(f);
  for (const s of waiting) assert.equal(stateOf(f, s.id).phase, 'landed');
  assert.equal(stateOf(f, runner.id).error.code, 'LANDING_CANCELLED');
  assert.equal(f.pending().length, 0);
});

/** The order of events behind 321d3b71: the member's one-shot alarm fires while
 * the runner is still live (correct no-op), then the runner is cancelled by the
 * pre-fix path (no hand-on) and every wake is gone. Only the deadline remains. */
async function legacyOrphan(t) {
  const { f, runner, waiting } = await fallbackWithRunner(t);
  const target = waiting[0];
  const at = progressAt(stateOf(f, target.id));
  f.advanceClock(LANDING_STALL_MS + 1000);
  const taskId = [...f.tables._scheduled_functions.values()][0]._id;
  f.patch('projectHostedLandingRequests', rowOf(f, target.id)._id, { alarm: { taskId, lastProgressAt: at } });
  await f.transaction('alarm-while-runner-live', stallApi.alarm, {
    projectId: f.projectId,
    submissionId: target.id,
    lastProgressAt: at,
  });
  assert.equal(stateOf(f, target.id).batchNeedsSoloCompose, true, 'the runner still held the turn');
  for (const task of f.pending())
    if (task.name !== 'projectHostedLandingStall:deadline')
      f.patch('_scheduled_functions', task._id, { state: { kind: 'canceled' } });
  const row = rowOf(f, runner.id),
    dead = JSON.parse(row.value);
  Object.assign(dead, {
    phase: 'terminal-failed',
    version: dead.version + 1,
    observation: { state: 'terminal-failed', cause: 'rejected', pendingReason: null },
    error: { code: 'LANDING_CANCELLED', message: 'Synthetic pre-fix cancellation' },
  });
  f.patch('projectHostedLandingRequests', row._id, {
    phase: 'terminal-failed',
    runnable: false,
    value: JSON.stringify(dead),
  });
  return { f, runner, waiting, target, at };
}

test('the stall alarm arms one deadline at the dropped-landing limit, and nothing else', async t => {
  const { f, target, at } = await legacyOrphan(t);
  assert(stateOf(f, target.id).observation.stall, 'the alarm recorded the stall');
  const deadlines = f.pending().filter(task => task.name === 'projectHostedLandingStall:deadline');
  assert.equal(deadlines.length, 1);
  assert.equal(deadlines[0].args[0].submissionId, target.id);
  assert.equal(deadlines[0].scheduledTime, Date.parse(at) + LANDING_DROP_MS);
});

test('replay 108a24e3: the deadline re-drives a member orphaned after fallback and it lands', async t => {
  const { f, waiting, target, at } = await legacyOrphan(t);
  const before = Object.fromEntries(waiting.map(s => [s.id, progressAt(stateOf(f, s.id))]));
  assert.equal(before[target.id], at);
  for (const s of waiting) assert.equal(rowOf(f, s.id).runnable, false, 'orphaned: nobody will claim it');
  const deadline = f.pending().find(task => task.name === 'projectHostedLandingStall:deadline');
  f.advanceClock(Math.max(0, deadline.scheduledTime - Date.now()));
  f.patch('_scheduled_functions', deadline._id, { state: { kind: 'success' } });
  await f.transaction('stall-deadline', stallApi.deadline, deadline.args[0]);
  assert(
    waiting.some(s => progressAt(stateOf(f, s.id)) !== before[s.id]),
    're-driven: a waiting member took the fallback turn',
  );
  await landRest(f);
  for (const s of waiting) assert.equal(stateOf(f, s.id).phase, 'landed');
  assert.equal(f.pending().length, 0);
});

test('a member still pointing at a retired batch gets a terminal outcome at the deadline', async t => {
  // The live state of c7744083: an unreleased member of a batch that can no
  // longer drive it (its leader was cancelled before cancellation released peers).
  const f = await batchesFixture(t, { count: 2 });
  await drainLive(f);
  const batchRow = [...f.tables.projectHostedLandingBatches.values()][0];
  f.patch('projectHostedLandingBatches', batchRow._id, {
    value: JSON.stringify({ ...retained(f), phase: 'superseded' }),
  });
  const [leader, member] = states(f);
  const dead = {
    ...leader,
    phase: 'terminal-failed',
    observation: { state: 'terminal-failed', cause: 'rejected', pendingReason: null },
    error: { code: 'LANDING_CANCELLED', message: 'Synthetic pre-fix cancellation' },
  };
  f.patch('projectHostedLandingRequests', rowOf(f, leader.id)._id, {
    phase: 'terminal-failed',
    runnable: false,
    value: JSON.stringify(dead),
  });
  const queued = {
    ...member,
    phase: 'queued',
    observation: { state: 'pending', cause: null, pendingReason: 'queued' },
    error: null,
  };
  f.patch('projectHostedLandingRequests', rowOf(f, member.id)._id, {
    phase: 'queued',
    runnable: false,
    value: JSON.stringify(queued),
  });
  const at = progressAt(queued);
  f.advanceClock(LANDING_DROP_MS + 1000);
  await f.transaction('retired-batch-deadline', stallApi.deadline, {
    projectId: f.projectId,
    submissionId: member.id,
    lastProgressAt: at,
    attempt: 0,
  });
  const after = stateOf(f, member.id);
  assert.equal(after.phase, 'terminal-failed');
  assert.equal(after.error.code, 'LANDING_STALLED', 'a Forge outcome, not an operator cancel');
  assert.match(after.error.message, /no landing progress for 60 minutes/i);
  assert.match(after.error.message, /finish the same Lane again/i);
  const operation = [...f.tables.projectHostedOperations.values()]
    .map(row => JSON.parse(row.value))
    .find(op => op.operationId === member.operationId);
  assert.equal(operation.terminal.outcome.status, 'failed', 'the requester receives the outcome');
  assert.equal(operation.terminal.outcome.error.code, 'LANDING_STALLED');
  await f.drain();
  assert.equal(f.pending().length, 0, 'a terminal outcome leaves nothing scheduled');
});

test('a member waiting behind a live runner is not dropped; the deadline re-arms once with backoff', async t => {
  const { f, runner, waiting } = await fallbackWithRunner(t);
  const target = waiting[0];
  const at = progressAt(stateOf(f, target.id));
  // The runner made progress recently, the waiting member did not.
  f.advanceClock(LANDING_DROP_MS + 1000);
  const live = rowOf(f, runner.id),
    runnerState = JSON.parse(live.value);
  runnerState.timing = { ...runnerState.timing, ciProgressAt: new Date().toISOString() };
  f.patch('projectHostedLandingRequests', live._id, { value: JSON.stringify(runnerState) });
  await f.transaction('owned-deadline', stallApi.deadline, {
    projectId: f.projectId,
    submissionId: target.id,
    lastProgressAt: at,
    attempt: 0,
  });
  assert.equal(stateOf(f, target.id).phase, 'queued');
  const rearmed = f.pending().filter(task => task.name === 'projectHostedLandingStall:deadline');
  assert.equal(rearmed.length, 1);
  assert.equal(rearmed[0].args[0].attempt, 1);
  assert.equal(rearmed[0].scheduledTime, Date.now() + 2 * LANDING_DROP_MS);
});

test('the deadline is a no-op after progress, and stops re-arming after its last attempt', async t => {
  const { f, runner, waiting } = await fallbackWithRunner(t);
  const target = waiting[0];
  await f.transaction('progressed-deadline', stallApi.deadline, {
    projectId: f.projectId,
    submissionId: target.id,
    lastProgressAt: '2000-01-01T00:00:00.000Z',
    attempt: 0,
  });
  assert.equal(stateOf(f, target.id).phase, 'queued');
  assert(!f.pending().some(task => task.name === 'projectHostedLandingStall:deadline'));
  // Last attempt behind a live runner: never end work something still drives,
  // and leave no further timer (the runner's own path re-selects the member).
  const at = progressAt(stateOf(f, target.id));
  f.advanceClock(40 * LANDING_DROP_MS);
  assert.equal(rowOf(f, runner.id).phase, 'checking');
  await f.transaction('last-deadline', stallApi.deadline, {
    projectId: f.projectId,
    submissionId: target.id,
    lastProgressAt: at,
    attempt: stallApi.LANDING_DROP_ATTEMPTS,
  });
  assert.equal(stateOf(f, target.id).phase, 'queued');
  assert(!f.pending().some(task => task.name === 'projectHostedLandingStall:deadline'));
});
test('stall deadline and cancel hand-on stay within constant DB I/O budgets', async t => {
  const { f, runner, waiting } = await fallbackWithRunner(t);
  const target = waiting[0];
  const at = progressAt(stateOf(f, target.id));
  const deadline = (name, lastProgressAt) =>
    f.transaction(name, stallApi.deadline, {
      projectId: f.projectId,
      submissionId: target.id,
      lastProgressAt,
      attempt: 0,
    });
  await deadline('budget-progressed', '2000-01-01T00:00:00.000Z');
  f.advanceClock(LANDING_DROP_MS + 1000);
  await deadline('budget-owned', at);
  await cancel(f, runner.id);
  const cost = name => f.counts.find(c => c.name === name);
  // Measured 2026-10-31 on a 3-member batch: 1, 17 and 88 documents (cancel was
  // 47 before it handed on the turn; the hand-on is work the next member's own
  // finish step used to do, or never did when the runner was cancelled).
  assert.equal(cost('budget-progressed').documents, 1, 'progress since: one indexed read, no writes');
  assert.equal(cost('budget-progressed').writeBytes, 0);
  assert(cost('budget-owned').documents <= 30, `owned deadline ${cost('budget-owned').documents}`);
  assert(
    cost('cancel-fallback-runner').documents <= 120,
    `cancel ${cost('cancel-fallback-runner').documents}`,
  );
  for (const name of ['budget-owned', 'cancel-fallback-runner'])
    assert(
      !cost(name).touched.some(k => /Pages|Shards|WorkRecords|Backups/.test(k)),
      `${name}: no history fan-in`,
    );
});
