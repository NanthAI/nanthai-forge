// SPDX-License-Identifier: Apache-2.0
// Replays Issue 108a24e3 (2026-10-30): batch members waiting for their
// individual fallback turn were orphaned when the member holding the turn was
// cancelled. The one-shot stall alarm had already fired, so nothing ever
// re-drove them and they stayed queued for 36 hours with no terminal outcome.
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { feedProjectionCounts, landingBodyCounts } from './observer-projection-budget.mjs';
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
/** The deadline decides; its repair runs as its own scheduled step (19328518), so
 * a repair that throws cannot take the supervisor round down with it. */
async function runRepair(f, submissionId) {
  const task = f
    .pending()
    .find(
      task => task.name === 'projectHostedLandingStall:repair' && task.args[0].submissionId === submissionId,
    );
  assert(task, 'the deadline scheduled its repair');
  f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
  await f.transaction('stall-repair', stallApi.repair, task.args[0]);
  return task.args[0];
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
  // ab5c0017: when the last member ends by landing, its own path settles the batch.
  assert.equal(retained(f).phase, 'landed', 'a fallback batch settles when its last member lands');
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
  assert.equal(
    stateOf(f, target.id).observation.stall,
    undefined,
    'a live fallback runner owns the wait; no false follower alarm',
  );
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
  assert.equal((await runRepair(f, target.id)).mode, 'drop');
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
  await runRepair(f, member.id);
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
  assert.equal(
    f.pending().filter(task => !task.name.startsWith('projectHostedLandingStall:')).length,
    0,
    'a live runner keeps recovery ownership without an extra controller redrive',
  );
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
  const cost = name => {
    const c = f.counts.find(c => c.name === name);
    return { ...c, documents: c.documents - landingBodyCounts(c).reads - feedProjectionCounts(c).reads };
  };
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

// Replays Issue ab5c0017 (2026-11-20): 15 dev batches stayed composing, checking or fallback
// after every member was terminal, so their capsule waits were never released. Each member ended
// on a path that never re-entered the batch (a cancel or supersede of a rejected member, failFinish).
const finishStore = await import(moduleUrl('../convex/projectHostedFinishStore.ts'));
const cancelApi = await import(moduleUrl('../convex/projectHostedLandingCancel.ts'));
const finishWake = await import(moduleUrl('../convex/projectHostedFinishWake.ts'));
const batchRowOf = f => [...f.tables.projectHostedLandingBatches.values()][0];
// f.pending() hides capsule packs; a released wait is the pack scheduled with the wait's own dueAt.
const heldDueAt = 1_700_000_000_000;
const releasedWaits = (f, id) =>
  [...f.tables._scheduled_functions.values()].filter(
    task =>
      task.name === 'projectLandingCapsuleRun:pack' &&
      task.args[0].submissionId === id &&
      task.args[0].dueAt === heldDueAt,
  );
/** The batch in `shape`, holding one capsule wait per member, as the 7-day packer leaves it. */
function leak(f, shape) {
  const row = batchRowOf(f);
  f.patch('projectHostedLandingBatches', row._id, {
    value: JSON.stringify({ ...retained(f), ...shape }),
    capsuleWaits: retained(f).members.map(m => ({ submissionId: m.submissionId, dueAt: heldDueAt })),
  });
}
const failFinish = (f, submissionId, code, message) =>
  f.transaction(
    `fail-finish-${code}`,
    { _handler: ctx => finishStore.failFinish(ctx, { projectId: f.projectId, submissionId }, code, message) },
    {},
  );
const supersede = (f, submissionId) =>
  f.transaction(
    'supersede-rejected-member',
    {
      _handler: ctx =>
        cancelApi.cancelHostedLanding(ctx, {
          projectId: f.projectId,
          actor: stateOf(f, submissionId).actor,
          request: { operationId: randomUUID(), authorityEpoch: 1, submissionId },
          supersede: { laneId: randomUUID(), head: 'a'.repeat(40) },
        }),
    },
    {},
  );
/** Late compose and check results for a settled batch change nothing and schedule nothing new. */
async function lateIoIsNoOp(f) {
  const before = JSON.stringify([...f.tables.projectHostedLandingBatches.values()].map(r => r.value));
  const tickets = JSON.stringify(states(f));
  const batch = retained(f);
  await f.transaction(
    'late-compose-result',
    { _handler: ctx => finishWake.notifyFinishCompose(ctx, f.projectId, batch.composeOperationId) },
    {},
  );
  await f.passChecks();
  await drainLive(f);
  assert.equal(
    JSON.stringify([...f.tables.projectHostedLandingBatches.values()].map(r => r.value)),
    before,
    'the settled batch stays settled',
  );
  assert.equal(JSON.stringify(states(f)), tickets, 'no member is revived or rewritten');
}
function assertSettled(f) {
  const row = batchRowOf(f);
  assert.equal(retained(f).phase, 'landed', 'a batch with no live member settles terminal');
  assert.equal(row.capsuleWaits, undefined, 'its capsule waits are released');
  for (const member of retained(f).members)
    assert.equal(releasedWaits(f, member.submissionId).length, 1, 'each held landing gets its pack wake');
}

test('replay ab5c0017: a parked rejected-all cohort (composing, included: []) whose only member is superseded by a Lane re-save settles terminal and releases its capsule waits', async t => {
  const f = await batchesFixture(t, { count: 2 });
  await drainLive(f);
  // The shared compose dropped every member against a pending predecessor; each waits parked on it.
  leak(f, { phase: 'composing', included: [] });
  for (const s of states(f))
    f.patch('projectHostedLandingRequests', rowOf(f, s.id)._id, {
      phase: 'queued',
      runnable: false,
      value: JSON.stringify({
        ...s,
        phase: 'queued',
        observation: { state: 'pending', cause: null, pendingReason: 'queued' },
      }),
    });
  const [first, last] = states(f);
  await supersede(f, first.id);
  assert.equal(retained(f).phase, 'composing', 'a live member keeps the cohort open');
  await supersede(f, last.id);
  for (const s of states(f)) assert.equal(s.error.code, 'LANDING_SUPERSEDED');
  assertSettled(f);
  await lateIoIsNoOp(f);
});

test('replay ab5c0017: a checking batch whose included member ends through failFinish (a precompose conflict) settles terminal', async t => {
  const f = await batchesFixture(t, { count: 2 });
  await drainLive(f);
  const [included, rejected] = states(f);
  leak(f, { phase: 'checking', included: [included.id] });
  // The rejected member is cancelled first; cancel skips the batch write for a rejected member.
  await cancel(f, rejected.id);
  assert.equal(retained(f).phase, 'checking');
  await failFinish(f, included.id, 'COMPOSITION_CONFLICT', 'Synthetic precompose conflict against main.');
  assert.equal(stateOf(f, included.id).error.code, 'COMPOSITION_CONFLICT');
  assertSettled(f);
  await lateIoIsNoOp(f);
});

test('replay ab5c0017: a fallback batch whose last member ends through failFinish settles terminal', async t => {
  const { f, runner, waiting } = await fallbackWithRunner(t);
  leak(f, {});
  for (const s of waiting) await cancel(f, s.id);
  assert.equal(retained(f).phase, 'fallback', 'the individual runner is still live');
  await failFinish(f, runner.id, 'CHECK_FAILED', 'Synthetic individual check failure.');
  assertSettled(f);
  await lateIoIsNoOp(f);
});

const capture = await import(moduleUrl('../convex/projectLandingCapsuleCapture.ts'));
const { landingCapsuleGraceMs } = await import(moduleUrl('../convex/projectLandingCapsuleWake.ts'));
const failureRows = f =>
  [...(f.tables.projectFailures?.values() ?? [])].filter(
    row => JSON.parse(row.value).code === 'LANDING_BATCH_LEAKED',
  );
const begin = (f, submissionId) =>
  f
    .transaction('capsule-begin', capture.begin, { projectId: f.projectId, submissionId, dueAt: 0 })
    .then(JSON.parse);
/** A leak no write reaches: both members already ended while the batch stayed composing. */
function endedWithoutHook(f) {
  leak(f, { phase: 'composing', included: [] });
  for (const s of states(f))
    f.patch('projectHostedLandingRequests', rowOf(f, s.id)._id, {
      phase: 'terminal-failed',
      runnable: false,
      value: JSON.stringify({
        ...s,
        phase: 'terminal-failed',
        observation: { state: 'superseded', pendingReason: null, cause: null },
        error: { code: 'LANDING_SUPERSEDED', message: 'Synthetic missed-hook supersede' },
      }),
    });
}

test('guard ab5c0017: the capsule pass settles a batch still open after every member ended, flags it once in the failure log and packs', async t => {
  const f = await batchesFixture(t, { count: 2 });
  await drainLive(f);
  endedWithoutHook(f);
  f.advanceClock(landingCapsuleGraceMs + 86_400_000);
  const [first, second] = states(f);
  const answer = await begin(f, first.id);
  assert.equal(answer.deferred, undefined, 'the landing packs instead of waiting on the batch forever');
  assert.equal(answer.anchor.id, first.id);
  assert.equal(answer.anchor.version, stateOf(f, first.id).version, 'the pack anchors the row as settled');
  assertSettled(f);
  const flags = failureRows(f);
  assert.equal(flags.length, 1, 'one failure-log row names the leaked batch');
  assert.equal(flags[0].operationId, `landing-batch-leak:${retained(f).id}`);
  assert.equal((await begin(f, second.id)).deferred, undefined);
  assert.equal(failureRows(f).length, 1, 'a settled batch is not flagged again');
});

test('guard ab5c0017: a batch with a live member stays open and the capsule pass keeps waiting on it', async t => {
  const f = await batchesFixture(t, { count: 2 });
  await drainLive(f);
  const [ended, live] = states(f);
  leak(f, { phase: 'checking', included: [ended.id, live.id] });
  f.patch('projectHostedLandingRequests', rowOf(f, ended.id)._id, {
    phase: 'terminal-failed',
    value: JSON.stringify({
      ...ended,
      phase: 'terminal-failed',
      error: { code: 'CHECK_FAILED', message: 'x' },
    }),
  });
  f.advanceClock(landingCapsuleGraceMs + 86_400_000);
  assert.equal((await begin(f, ended.id)).deferred, 'batch');
  assert.equal(retained(f).phase, 'checking', 'a live member keeps its batch open');
  assert.equal(failureRows(f).length, 0, 'nothing is flagged');
});

const landingStore = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
const { landingObservation } = await import('../dist/hosted-landing.js');
/** One synthetic ticket transition through the real writer (the version and identity rules apply). */
const writeTicket = (f, name, id, change) =>
  f.transaction(
    name,
    {
      _handler: async ctx => {
        const { row, state } = await landingStore.loadLanding(ctx, {
          projectId: f.projectId,
          submissionId: id,
        });
        await landingStore.writeLanding(ctx, row, { ...change(state), version: state.version + 1 }, false);
      },
    },
    {},
  );

test('review 000e2d4f: the rejected member that recomposes solo and lands last settles its still-checking batch', async t => {
  const f = await batchesFixture(t, { count: 2 });
  await drainLive(f);
  const [included, rejected] = states(f);
  leak(f, { phase: 'checking', included: [included.id] });
  await failFinish(f, included.id, 'COMPOSITION_CONFLICT', 'Synthetic precompose conflict against main.');
  assert.equal(retained(f).phase, 'checking', 'the rejected member is still live');
  // settleBatchConflicts on a moved main: the rejected member leaves the cohort and recomposes alone.
  await writeTicket(f, 'recompose-rejected-solo', rejected.id, ({ batchId, ...state }) => ({
    ...state,
    batchOriginId: batchId,
    batchSolo: true,
  }));
  assert.equal(retained(f).phase, 'checking');
  await writeTicket(f, 'solo-landing', rejected.id, state => ({
    ...state,
    phase: 'landed',
    observation: landingObservation('accepted'),
    error: null,
  }));
  assertSettled(f);
});

for (const end of ['cancel', 'failFinish'])
  test(`review 000e2d4f: the last live member of a predecessor cohort ending (${end}) still retires its pipelined successor`, async t => {
    const f = await batchesFixture(t, { count: 10, batching: 'default', batchMaxSize: null });
    await drainLive(f);
    const batches = () =>
      [...f.tables.projectHostedLandingBatches.values()].map(row => JSON.parse(row.value));
    const successor = batches().find(b => b.predecessor);
    assert(successor, 'cohorts check stacked on their predecessor cohort');
    const pin = successor.predecessor.submissionId;
    const predecessor = batches().find(b => b.members.some(m => m.submissionId === pin));
    assert(predecessor.members.length > 1);
    // The others were rejected by the shared compose and ended first; a rejected member's end skips the batch.
    leak(f, {});
    const row = [...f.tables.projectHostedLandingBatches.values()].find(
      r => JSON.parse(r.value).id === predecessor.id,
    );
    f.patch('projectHostedLandingBatches', row._id, {
      value: JSON.stringify({ ...JSON.parse(row.value), included: [pin] }),
    });
    for (const member of predecessor.members)
      if (member.submissionId !== pin) await cancel(f, member.submissionId);
    const after = id => batches().find(b => b.id === id);
    assert.equal(after(successor.id).phase, successor.phase, 'rejected ends leave the successor alone');
    // The successor's own check passed first: its members wait Ready on the pinned predecessor.
    await f.rawChecks.pass(await f.rawChecks.activate(successor.runId));
    await drainLive(f);
    for (const member of successor.members) assert.equal(stateOf(f, member.submissionId).phase, 'ready');
    if (end === 'cancel') await cancel(f, pin);
    else await failFinish(f, pin, 'COMPOSITION_CONFLICT', 'Synthetic precompose conflict against main.');
    assert.equal(
      after(predecessor.id).phase,
      'landed',
      'the predecessor cohort has no live member and settles',
    );
    assert.equal(after(successor.id).phase, 'superseded', 'its speculative successor generation is retired');
    for (const member of successor.members)
      assert.notEqual(
        stateOf(f, member.submissionId).batchId,
        successor.id,
        'the successor member re-selects',
      );
  });

test('review 2a9d4b2e: settling keeps the successor pinned on a member that landed; only failed members retire successors', async t => {
  const f = await batchesFixture(t, { count: 10, batching: 'default', batchMaxSize: null });
  await drainLive(f);
  const batches = () => [...f.tables.projectHostedLandingBatches.values()].map(row => JSON.parse(row.value));
  const successor = batches().find(b => b.predecessor);
  assert(successor, 'cohorts check stacked on their predecessor cohort');
  const pin = successor.predecessor.submissionId;
  const predecessor = batches().find(b => b.members.some(m => m.submissionId === pin));
  const others = predecessor.members.map(m => m.submissionId).filter(id => id !== pin);
  assert(others.length > 0);
  await f.rawChecks.pass(await f.rawChecks.activate(successor.runId));
  await drainLive(f);
  for (const member of successor.members) assert.equal(stateOf(f, member.submissionId).phase, 'ready');
  // The pinned member left the cohort, recomposed alone and landed; its peers are still live.
  await writeTicket(f, 'recompose-pin-solo', pin, ({ batchId, ...state }) => ({
    ...state,
    batchOriginId: batchId,
    batchSolo: true,
  }));
  await writeTicket(f, 'pin-solo-landing', pin, state => ({
    ...state,
    phase: 'landed',
    observation: landingObservation('accepted'),
    error: null,
  }));
  const after = id => batches().find(b => b.id === id);
  assert.equal(after(predecessor.id).phase, predecessor.phase, 'live peers keep the cohort open');
  for (const id of others) await failFinish(f, id, 'COMPOSITION_CONFLICT', 'Synthetic precompose conflict.');
  assert.equal(after(predecessor.id).phase, 'landed', 'the cohort has no live member and settles');
  assert.equal(
    after(successor.id).phase,
    successor.phase,
    'the successor stacked on the landed member keeps its check',
  );
  for (const member of successor.members) {
    assert.equal(
      stateOf(f, member.submissionId).batchId,
      successor.id,
      'the successor member stays in its cohort',
    );
    assert.equal(stateOf(f, member.submissionId).phase, 'ready');
  }
});
