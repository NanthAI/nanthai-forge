// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { landingApi } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { queuedConflict } from '../dist/hosted-agent-finish.js';
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const conflictStore = await import(moduleUrl('../convex/projectHostedLandingBatchConflict.ts'));
const sync = await import(moduleUrl('../convex/projectHostedSync.ts'));
const stall = await import(moduleUrl('../convex/projectHostedLandingStall.ts'));
const speculative = await import(moduleUrl('../convex/projectHostedLandingSpeculativeConflict.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const rowOf = (f, id) =>
  [...f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === id);
const batches = f => [...f.tables.projectHostedLandingBatches.values()].map(row => JSON.parse(row.value));
const current = (f, index) => states(f).find(state => state.id === f.entries[index].state.id);
async function drainActive(f) {
  let steps = 0;
  for (;;) {
    const task = f.pending().find(task => !task.name.startsWith('projectHostedLandingStall:'));
    if (!task) return steps;
    assert(
      ++steps < 2000,
      JSON.stringify(states(f).map(state => ({ phase: state.phase, error: state.error }))),
    );
    await f.execute(task);
  }
}
const fixture = (t, count = 10) =>
  batchesFixture(t, {
    count,
    batching: 'default',
    batchMaxSize: 3,
    // Entry 1 belongs to the predecessor; entry 3 belongs to its successor.
    memberPaths: Array.from({ length: count }, (_, index) =>
      index === 1 || index === 3 ? 'collision' : `member-${index}`,
    ),
  });
async function parked(f) {
  await drainActive(f);
  const state = current(f, 3),
    row = rowOf(f, state.id);
  assert.equal(state.phase, 'queued');
  assert.equal(state.observation.state, 'pending');
  assert.equal(state.error, null);
  for (const member of batches(f).find(batch => batch.id === state.batchId).members)
    assert.equal(
      rowOf(f, member.submissionId).alarm,
      null,
      'the predecessor owns progress, including for a non-conflicting member',
    );
  const advice = JSON.parse(row.wouldConflict);
  const predecessor = current(f, 2);
  assert.equal(advice.code, 'COMPOSITION_CONFLICT');
  assert.deepEqual(advice.paths, ['collision'], 'reuse the signed whole/stepped-worker file summary');
  assert.equal(advice.more, 0);
  assert.match(advice.next, /collision/);
  assert.equal(advice.predecessor.submissionId, predecessor.id);
  assert.equal(advice.predecessor.groupId, predecessor.batchId);
  assert.match(advice.next, /stays queued.*recompose.*No agent action/);
  assert.equal(
    rowOf(f, state.id).attemptId,
    f.entries[3].state.attemptId,
    'no conflict attempt replaces the original selection',
  );
  const operation = [...f.tables.projectHostedOperations.values()]
    .map(row => JSON.parse(row.value))
    .find(op => op.operationId === state.operationId);
  assert.equal(operation.terminal, null, 'advice never settles the original operation');
  return { state, advice, predecessor };
}
async function finishGood(f, rejectedIndex = null) {
  let waves = 0;
  while (states(f).some(state => !['landed', 'terminal-failed'].includes(state.phase))) {
    assert(++waves < 30);
    const pending = f.runs().filter(run => run.status === 'queued');
    assert(pending.length, JSON.stringify(states(f)));
    for (const run of pending) {
      const files = JSON.parse(f.c.objects.get(run.request.expectedHead)).files;
      const rejected = rejectedIndex === null ? null : f.c.file('collision', `member ${rejectedIndex}`);
      if (rejected && files.some(file => file.path === rejected.path && file.blob === rejected.blob))
        await f.fail(run.id);
      else await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
    await drainActive(f);
  }
  assert.equal(f.pending().length, 0, 'zero idle tasks/calls');
  return waves;
}

test('predecessor landing rechecks a speculative rejection on real main and reports the terminal conflict promptly', async t => {
  const f = await fixture(t);
  const { state, advice } = await parked(f);
  const status = await f.status(state.id);
  assert.deepEqual(status.wouldConflict, advice);
  const page = JSON.parse(
    await f.transaction('speculative-observe', observe.page, {
      projectId: f.projectId,
      operationId: state.operationId,
      nextVersion: state.version,
    }),
  );
  assert.deepEqual(page.wouldConflict, advice);
  assert.deepEqual(page.events[0].wouldConflict, advice);
  assert.equal(page.events[0].submission.observation.state, 'pending');
  const lateAlarm = [...f.tables._scheduled_functions.values()].find(
    task =>
      task.name === 'projectHostedLandingStall:alarm' && task.args[0].submissionId === f.entries[4].state.id,
  );
  assert(lateAlarm, 'the non-conflicting cohort member previously owned a compose alarm');
  await f.transaction(
    'late-waiting-member-alarm',
    { _handler: ctx => stall.raiseLandingAlarm(ctx, lateAlarm.args[0], Date.now() + 60 * 60_000) },
    {},
  );
  assert.equal(current(f, 4).observation.stall, undefined);
  assert.equal(
    current(f, 4).batchId,
    state.batchId,
    'a stale alarm cannot split a cohort whose predecessor owns progress',
  );
  const replay = await queuedConflict(
    {
      root: '/fixture/lane',
      query: async () => ({ wouldConflict: advice }),
    },
    state,
  );
  assert.equal(replay.next, 'wait-for-predecessor');
  assert.match(replay.nextCommand, /wait /);
  assert.doesNotMatch(replay.nextCommand, /sync|land --save/);
  const fresh = { ...state, version: state.version + 1 },
    queue = { position: 2, entriesAhead: 3 },
    canonicalReplay = await queuedConflict(
      {
        root: '/fixture/lane',
        query: async () => ({ request: fresh, queuePosition: 2, queue, wouldConflict: advice }),
      },
      state,
    );
  assert.deepEqual(canonicalReplay.submission, fresh, 'advice retains the fresh canonical submission');
  assert.deepEqual(canonicalReplay.queue, queue);
  assert.equal(canonicalReplay.queuePosition, 2);
  assert.equal(canonicalReplay.next, 'wait-for-predecessor');
  const checking = { ...fresh, phase: 'checking' },
    settled = await queuedConflict(
      { query: async () => ({ request: checking, wouldConflict: advice }) },
      state,
    );
  assert.deepEqual(settled.submission, checking);
  assert.equal(settled.wouldConflict, undefined, 'a fresh nonqueued state retires stale advice');
  assert.equal(settled.nextCommand, undefined);
  const originalRuns = f.runs();
  assert.equal(originalRuns.length, 1, 'the rejected speculative cohort reserves no check');
  await f.rawChecks.pass(await f.rawChecks.activate(originalRuns[0].id));
  await drainActive(f);
  const failed = current(f, 3);
  assert.equal(failed.phase, 'terminal-failed', 'no other CI result or agent action is required');
  assert.equal(failed.error.code, 'COMPOSITION_CONFLICT');
  const failedAttempt = [...f.tables.projectHostedLandingAttempts.values()]
    .map(row => JSON.parse(row.value))
    .find(attempt => attempt.id === failed.attemptId);
  const candidateRow = [...f.tables.projectHostedRecords.values()].find(
    row => row.kind === 'candidate' && row.key === failedAttempt.candidate.id,
  );
  assert.equal(
    candidateRow.ownerOnly,
    true,
    'terminal recovery retains the authenticated speculative prefix',
  );
  assert.equal(candidateRow.provenanceEpoch, 1);
  const candidateBody = JSON.parse(f.tables.projectHostedRecordBodies.get(candidateRow.bodyId).value);
  const preparedResolution = JSON.parse(
    await f.transaction('prepare-speculative-recovery', sync.prepare, {
      projectId: f.projectId,
      request: JSON.stringify({
        operationId: randomUUID(),
        authorityEpoch: 1,
        kind: 'resolution',
        candidateId: candidateBody.id,
        conflicts: candidateBody.result.conflicts,
        message: 'Retain prefix provenance',
      }),
    }),
  );
  assert.equal(preparedResolution.state.ownerInputs, true);

  assert.equal(rowOf(f, state.id).wouldConflict, undefined);
  const attempt = JSON.parse(
    [...f.tables.projectHostedLandingAttempts.values()].find(row => row.attemptId === failed.attemptId).value,
  );
  assert.equal(attempt.candidate.head, null);
  const candidate = await f.c.run(
    'read-real-conflict',
    (await import(moduleUrl('../convex/projectHostedRecords.ts'))).readHostedRecord,
    {
      ...f.c.auth,
      kind: 'candidate',
      key: attempt.candidate.id,
    },
  );
  assert.notEqual(
    JSON.parse(candidate.value).base.receiptId,
    f.entries[3].state.request.expectedMain.receiptId,
  );
  await finishGood(f);
  assert.equal(states(f).filter(state => state.phase === 'landed').length, 9);
});

test('a conflict against already-landed main stays immediately terminal without a speculative wait or another CI result', async t => {
  const f = await batchesFixture(t, {
    count: 6,
    batching: 'default',
    batchMaxSize: 3,
    concurrency: 1,
    memberPaths: ['member-0', 'collision', 'member-2', 'collision', 'member-4', 'member-5'],
  });
  await drainActive(f);
  assert.equal(f.runs().length, 1);
  assert.equal(current(f, 3).phase, 'queued');
  assert.equal(rowOf(f, current(f, 3).id).wouldConflict, undefined);
  await f.rawChecks.pass(await f.rawChecks.activate(f.runs()[0].id));
  await drainActive(f);
  assert.equal(current(f, 1).phase, 'landed');
  assert.equal(current(f, 3).phase, 'terminal-failed');
  assert.equal(current(f, 3).error.code, 'COMPOSITION_CONFLICT');
  assert.equal(rowOf(f, current(f, 3).id).wouldConflict, undefined);
  await finishGood(f);
  assert.equal(states(f).filter(state => state.phase === 'landed').length, 5);
});

for (const count of [10, 50])
  test(`N=${count}: failed predecessor discards speculative advice and lands the member without agent action, with bounded cost`, async t => {
    const f = await fixture(t, count),
      before = f.counts.length,
      start = performance.now();
    await parked(f);
    await f.fail(f.runs()[0].id, 'tests/combined.test.mjs');
    await drainActive(f);
    assert.notEqual(current(f, 3).phase, 'terminal-failed');
    assert.equal(rowOf(f, current(f, 3).id).wouldConflict, undefined);
    const waves = await finishGood(f, 1);
    assert.equal(current(f, 1).phase, 'terminal-failed');
    assert.equal(current(f, 3).phase, 'landed');
    assert(
      ![...f.tables.projectHostedLandingObservations.values()]
        .map(row => JSON.parse(row.value).submission)
        .some(state => state.id === f.entries[3].state.id && state.error?.code === 'COMPOSITION_CONFLICT'),
      'no historical terminal conflict is emitted for a discarded speculative prefix',
    );
    assert.equal(
      JSON.parse(f.c.objects.get(f.currentMain().head)).files.find(file => file.path === 'collision').blob,
      f.c.file('collision', 'member 3').blob,
      'surviving main contains the originally queued member bytes',
    );
    assert.equal(states(f).filter(state => state.phase === 'landed').length, count - 1);
    const counts = f.counts.slice(before),
      cost = {
        count,
        waves,
        calls: counts.length,
        reads: counts.reduce((sum, count) => sum + count.documents, 0),
        writes: counts.reduce((sum, count) => sum + count.writes, 0),
        maxReads: Math.max(...counts.map(count => count.documents)),
        maxWrites: Math.max(...counts.map(count => count.writes)),
        wallMs: performance.now() - start,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
      };
    assert(cost.calls / count < 100, JSON.stringify(cost));
    assert(cost.maxReads < 320, JSON.stringify(cost));
    assert(cost.maxWrites < 160, JSON.stringify(cost));
    const idle = f.counts.length;
    assert.equal(await drainActive(f), 0);
    assert.equal(f.counts.length, idle);
    t.diagnostic(JSON.stringify(cost));
  });

for (const count of [10, 50])
  test(`N=${count}: a full-size speculative cohort parks/replays in one O(group size) transaction`, async t => {
    const f = await batchesFixture(t, {
      count,
      batching: 'default',
      batchMaxSize: 8,
      memberPaths: Array.from({ length: count }, (_, index) =>
        index === 1 || index === 8 ? 'collision' : `member-${index}`,
      ),
    });
    await drainActive(f);
    const state = current(f, 8),
      row = rowOf(f, state.id);
    assert.equal(state.phase, 'queued');
    assert(row.wouldConflict);
    const batch = batches(f).find(batch => batch.id === state.batchId);
    assert.equal(batch.members.length, Math.min(8, count - 8));
    const source = await f.c.progress({ request: { operationId: batch.composeOperationId } });
    const before = f.counts.length;
    await f.transaction(
      'replay-speculative-defer-budget',
      {
        _handler: ctx =>
          speculative.deferSpeculativeConflict(
            ctx,
            { projectId: f.projectId, batchId: batch.id },
            batch,
            source.state.dropped,
          ),
      },
      {},
    );
    const calls = f.counts.slice(before);
    assert.equal(calls.length, 1);
    assert(calls[0].documents <= batch.members.length + 2, JSON.stringify(calls));
    assert.equal(calls[0].writes, 0, 'unchanged settlement wait/advice is idempotent');
    assert.equal(await drainActive(f), 0, 'no periodic queue or finish wake');
    t.diagnostic(
      JSON.stringify({
        count,
        groupSize: batch.members.length,
        calls: calls.length,
        reads: calls[0].documents,
        writes: calls[0].writes,
      }),
    );
  });

test('predecessor invalidation mid-check restores the pending member and fences late shared results', async t => {
  const f = await fixture(t);
  const { state } = await parked(f),
    oldBatch = current(f, 3).batchId,
    oldAttempt = state.attemptId;
  const run = await f.rawChecks.activate(f.runs()[0].id);
  await f.transaction('cancel-speculative-predecessor-member', landingApi.cancel, {
    projectId: f.projectId,
    request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: current(f, 1).id }),
  });
  await drainActive(f);
  assert(batches(f).some(batch => batch.id === oldBatch && batch.phase === 'superseded'));
  assert.notEqual(current(f, 3).attemptId, oldAttempt);
  assert.equal(rowOf(f, state.id).wouldConflict, undefined);
  // A late provider reply belongs to the old exact shared run only.
  await f.rawChecks.pass(run);
  await drainActive(f);
  await finishGood(f);
  assert.equal(current(f, 3).phase, 'landed');
  assert.equal(current(f, 1).error.code, 'LANDING_CANCELLED');
  assert.equal(states(f).filter(state => state.phase === 'landed').length, 9);
});

test('an all-dropped singleton successor remains live until its predecessor settles', async t => {
  const f = await fixture(t, 4);
  await parked(f);
  await f.fail(f.runs()[0].id, 'tests/combined.test.mjs');
  await drainActive(f);
  await finishGood(f, 1);
  assert.equal(current(f, 3).phase, 'landed');
});

test('terminal conflict retention rejects a speculative base before creating a Candidate or settling an operation', async t => {
  const f = await fixture(t);
  const { state } = await parked(f);
  const batch = batches(f).find(batch => batch.id === state.batchId);
  const source = await f.c.progress({ request: { operationId: batch.composeOperationId } });
  const member = batch.members.find(member => member.submissionId === state.id);
  const before = f.tables.projectHostedRecords.size;
  await assert.rejects(
    f.transaction(
      'reject-speculative-terminal-retention',
      {
        _handler: ctx =>
          conflictStore.retainBatchConflict(ctx, {
            projectId: f.projectId,
            member,
            main: batch.predecessor,
            conflict: source.state.dropped[0],
            ownerInputs: source.state.ownerProvenance === 1 && source.state.ownerInputs === true,
            at: batch.at,
          }),
      },
      {},
    ),
    error => error.code === 'CHANNEL_CHANGED',
  );
  assert.equal(f.tables.projectHostedRecords.size, before);
  assert.equal(current(f, 3).phase, 'queued');
});
