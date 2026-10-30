import { randomUUID } from 'node:crypto';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, batchStore, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { compose } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { LANDING_STALL_MS } from '../dist/landing-stall.js';
const stallApi = await import(moduleUrl('../convex/projectHostedLandingStall.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const retained = f => {
  const row = [...f.tables.projectHostedLandingBatches.values()][0];
  return { row, batch: JSON.parse(row.value) };
};
const transaction = (f, name, callback) => f.transaction(name, { _handler: callback }, {});

test('incident replay: fallback detaches and requeues all three members atomically; lost leader wake cannot strand them', async t => {
  const f = await batchesFixture(t, { count: 3 });
  const template = [...f.tables.projectHostedRecords.values()].find(row => row.kind === 'intent');
  for (let i = 0; i < 600; i++) {
    const key = randomUUID();
    const recordId = f.insert('projectHostedRecords', {
      ...template,
      _id: undefined,
      _creationTime: undefined,
      key,
    });
    f.insert('projectHostedRecordHeads', {
      projectId: f.projectId,
      kind: 'intent',
      key,
      version: 0,
      parent: 'owner',
      status: 'active',
      recordId,
    });
  }
  for (let i = 0; i < 575; i++)
    f.insert('projectHostedAcceptances', {
      projectId: f.projectId,
      receiptId: randomUUID(),
      submissionId: randomUUID(),
      attemptId: randomUUID(),
      sequence: i + 100,
      value: '{"unrelated":true}',
    });
  const before = f.counts.length,
    started = performance.now();
  await f.drain();
  await f.fail(f.runs()[0].id);
  for (let tick = 0; retained(f).batch.phase !== 'fallback'; tick++) {
    assert(tick < 100);
    await f.execute(f.pending()[0]);
  }
  const { batch } = retained(f);
  const snapshot = states(f);
  assert(
    snapshot.every(
      s =>
        !s.batchId &&
        s.batchOriginId === batch.id &&
        s.batchSolo &&
        s.batchNeedsSoloCompose &&
        s.phase === 'queued',
    ),
  );
  assert(
    [...f.tables.projectHostedLandingRequests.values()].every(row => row.runnable),
    'all members are independently selectable in the batch transition transaction',
  );
  const versions = snapshot.map(s => s.version),
    pending = f.pending().map(task => task._id);
  await transaction(f, 'repeat-fallback-transition', ctx =>
    batchStore.writeBatch(ctx, { projectId: f.projectId, batchId: batch.id }, batch),
  );
  assert.deepEqual(
    states(f).map(s => s.version),
    versions,
  );
  assert.deepEqual(
    f.pending().map(task => task._id),
    pending,
    'transition replay allocates no duplicate work',
  );
  // The original leader wake is lost. Another member must drive re-selection.
  const leaderWakes = f
    .pending()
    .filter(
      task =>
        task.name === 'projectHostedFinishDriver:drive' &&
        task.args[0].submissionId === (batch.leaderId ?? batch.id),
    );
  assert(leaderWakes.length > 0, 'the original leader wake must actually be removed');
  for (const task of leaderWakes) f.patch('_scheduled_functions', task._id, { state: { kind: 'canceled' } });
  await f.drain();
  for (let i = 0; i < 3; i++) {
    await f.passChecks();
    await f.drain();
  }
  assert(states(f).every(s => s.phase === 'landed' && !s.batchId));
  assert.equal(f.runs().length, 4, 'one failed batch and exactly one individual check per member');
  const counts = f.counts.slice(before),
    admission = f.counts.filter(c => c.name === 'finishEnqueue');
  const sum = (rows, key) => rows.reduce((n, row) => n + row[key], 0);
  const cost = {
    calls: counts.length,
    reads: sum(counts, 'documents'),
    writes: sum(counts, 'writes'),
    wallMs: performance.now() - started,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    includingAdmission: {
      calls: counts.length + admission.length,
      reads: sum(counts, 'documents') + sum(admission, 'documents'),
      writes: sum(counts, 'writes') + sum(admission, 'writes'),
    },
  };
  assert(cost.calls < 220 && cost.reads < 4500 && cost.writes < 1300, JSON.stringify(cost));
  t.diagnostic(JSON.stringify({ members: 3, unrelatedIntents: 600, retainedReceipts: 575, ...cost }));
  assert.equal(f.pending().length, 0);
});

test('batch phase change rolls back when any member cannot be released', async t => {
  const f = await batchesFixture(t, { count: 3 });
  await f.drain();
  const { batch } = retained(f),
    before = states(f);
  const last = [...f.tables.projectHostedLandingRequests.values()][2]._id;
  await assert.rejects(
    transaction(f, 'atomic-release-failure', async ctx => {
      const patch = ctx.db.patch.bind(ctx.db);
      ctx.db.patch = (id, value) => {
        if (id === last && value.phase === 'queued') throw Error('synthetic release write failure');
        return patch(id, value);
      };
      await batchStore.writeBatch(
        ctx,
        { projectId: f.projectId, batchId: batch.id },
        { ...batch, phase: 'fallback' },
      );
    }),
    /synthetic release write failure/,
  );
  assert.equal(retained(f).batch.phase, 'checking');
  assert.deepEqual(states(f), before);
});

for (const endedPhase of ['fallback', 'landed'])
  test(`stall alarm repairs legacy orphaned members of a ${endedPhase} batch without a resume`, async t => {
    const f = await batchesFixture(t, { count: 3 });
    await f.drain();
    await f.fail(f.runs()[0].id);
    await f.drain();
    await f.passChecks();
    for (let tick = 0; states(f)[0].phase !== 'landed'; tick++) {
      assert(tick < 100);
      await f.execute(f.pending()[0]);
    }
    const { row, batch } = retained(f);
    f.patch('projectHostedLandingBatches', row._id, {
      value: JSON.stringify({ ...batch, phase: endedPhase }),
    });
    // Retain a real landed leader and its accepted main bytes. Restore the two
    // pre-fix queued memberships and lose their wakes; only the alarm may act.
    // These legacy rows predate the active-cohort queue field too.
    for (const queue of f.tables.projectHostedLandingQueues.values())
      f.patch('projectHostedLandingQueues', queue._id, { train: undefined });
    for (const task of f.pending())
      f.patch('_scheduled_functions', task._id, { state: { kind: 'canceled' } });
    for (const current of f.tables.projectHostedLandingRequests.values()) {
      const state = JSON.parse(current.value);
      if (state.phase === 'landed') continue;
      state.phase = 'queued';
      state.batchId = batch.id;
      delete state.batchOriginId;
      delete state.batchNeedsSoloCompose;
      delete state.batchSolo;
      state.observation = { state: 'pending', pendingReason: 'queued', cause: null };
      state.error = null;
      state.timing = { submittedAt: state.at };
      f.patch('projectHostedLandingRequests', current._id, {
        phase: state.phase,
        runnable: false,
        value: JSON.stringify(state),
      });
    }
    const baseline = JSON.parse(f.c.objects.get(f.c.baseline.sha256));
    const lateHead = f.c.state(
      [...baseline.files, f.c.file('later-independent', 'later')],
      [f.c.baseline.sha256],
    );
    const lateLane = await f.c.lane(lateHead);
    for (const table of ['projectHostedRecords', 'projectHostedRecordHeads'])
      for (const record of f.tables[table].values())
        if (record.kind === 'lane' && record.key === lateLane.laneId)
          f.patch(table, record._id, { ownerOnly: true });
    const selection = f.c.selection([lateLane]);
    selection.request.expectedMain = { head: f.currentMain().head, receiptId: f.currentMain().receipt.id };
    const candidate = await compose(f.c, selection);
    const late = await f.enqueue(
      f.request({
        governanceVersion: 1,
        expectedMain: { head: f.currentMain().head, receiptId: f.currentMain().receipt.id },
        candidateId: candidate.id,
        expectedHead: candidate.result.head,
        finish: { composeOperationId: selection.request.operationId, after: null },
      }),
    );
    await f.drain();
    await f.passChecks();
    await f.drain();
    assert.equal(
      states(f).find(s => s.id === late.id).phase,
      'landed',
      'later submissions really overtake the legacy orphan before repair',
    );
    const orphan = [...f.tables.projectHostedLandingRequests.values()][1],
      state = JSON.parse(orphan.value);
    const taskId = [...f.tables._scheduled_functions.values()][0]._id;
    f.patch('projectHostedLandingRequests', orphan._id, { alarm: { taskId, lastProgressAt: state.at } });
    f.advanceClock(LANDING_STALL_MS + 1000);
    await f.transaction('orphan-stall-alarm', stallApi.alarm, {
      projectId: f.projectId,
      submissionId: state.id,
      lastProgressAt: state.at,
    });
    const repaired = states(f).filter(
      s => batch.members.some(m => m.submissionId === s.id) && s.id !== (batch.leaderId ?? batch.id),
    );
    assert(repaired.every(s => !s.batchId && s.batchSolo && s.batchOriginId === batch.id));
    assert(f.pending().length > 0, 'the alarm reselects and schedules source work itself');
    await f.drain();
    for (let i = 0; i < 2; i++) {
      await f.passChecks();
      await f.drain();
    }
    assert(
      states(f)
        .filter(s => s.id !== (batch.leaderId ?? batch.id))
        .every(s => s.phase === 'landed'),
    );
    assert(states(f).every(s => s.phase === 'landed'));
    assert.equal(f.runs().length, 5, 'four original batch/fallback checks plus one unrelated later check');
    assert(
      JSON.parse(f.c.objects.get(f.currentMain().head)).files.some(file => file.path === 'later-independent'),
    );
    assert.equal(f.pending().length, 0);
  });

for (const selected of [0, 1])
  test(`cancelling batch ${selected ? 'member' : 'leader'} atomically releases peers and they land`, async t => {
    const { landingApi } = await import('./hosted-finish-fixture.mjs');
    const { randomUUID } = await import('node:crypto');
    const f = await batchesFixture(t, { count: 3 });
    await f.drain();
    const request = {
      operationId: randomUUID(),
      authorityEpoch: 1,
      submissionId: f.entries[selected].state.id,
    };
    await f.transaction('cancel-batch-member', landingApi.cancel, {
      projectId: f.projectId,
      request: JSON.stringify(request),
    });
    const peers = states(f).filter(s => s.id !== request.submissionId);
    assert(peers.every(s => !s.batchId && s.batchSolo && s.batchNeedsSoloCompose && s.phase === 'queued'));
    assert(!states(f)[selected].batchId, 'cancelled membership is detached without reviving it');
    const versions = states(f).map(s => s.version);
    await f.transaction('repeat-cancel', landingApi.cancel, {
      projectId: f.projectId,
      request: JSON.stringify(request),
    });
    assert.deepEqual(
      states(f).map(s => s.version),
      versions,
    );
    await f.drain();
    for (let i = 0; i < 2; i++) {
      await f.passChecks();
      await f.drain();
    }
    assert(
      states(f)
        .filter(s => s.id !== request.submissionId)
        .every(s => s.phase === 'landed'),
    );
    assert.equal(states(f)[selected].error.code, 'LANDING_CANCELLED');
    assert.equal(f.pending().length, 0);
  });

for (const selected of [0, 1])
  test(`abandoning batch ${selected ? 'member' : 'leader'} reselects peers without cancelling shared execution`, async t => {
    const { randomUUID } = await import('node:crypto');
    const lifecycle = await import(moduleUrl('../convex/projectHostedLifecycle.ts'));
    const f = await batchesFixture(t, { count: 3 });
    await f.drain();
    const lane = f.entries[selected].lane;
    const request = {
      operationId: randomUUID(),
      authorityEpoch: 1,
      action: 'abandon',
      reason: 'Synthetic batch abandonment',
      target: {
        kind: 'lane',
        laneId: lane.laneId,
        expected: {
          head: lane.head,
          version: lane.version,
          sourceVersion: lane.sourceVersion,
          lifecycleVersion: lane.lifecycleVersion,
        },
        dirty: false,
        saveOperationId: null,
      },
    };
    await f.transaction('abandon-batch-member', lifecycle.transition, {
      projectId: f.projectId,
      request: JSON.stringify(request),
    });
    await f.drain();
    const cancelled = states(f).find(s => s.id === f.entries[selected].state.id);
    assert.equal(cancelled.phase, 'terminal-failed');
    assert.match(cancelled.error.message, /abandoned.*peers requeued/);
    assert.equal(f.runs()[0].cancelRequested, false, 'abandonment never cancels a shared provider run');
    for (let i = 0; i < 2; i++) {
      await f.passChecks();
      await f.drain();
    }
    assert(
      states(f)
        .filter(s => s.id !== cancelled.id)
        .every(s => s.phase === 'landed'),
    );
    assert.equal((await f.readLane(lane.laneId)).state, 'abandoned');
    assert.equal(f.pending().length, 0);
  });

test('a queue claim racing individual source preparation cannot settle the obsolete shared run', async t => {
  const driver = await import(moduleUrl('../convex/projectHostedLandingDriver.ts'));
  const f = await batchesFixture(t, { count: 3 });
  await f.drain();
  await f.fail(f.runs()[0].id);
  for (let tick = 0; retained(f).batch.phase !== 'fallback'; tick++) {
    assert(tick < 100);
    await f.execute(f.pending()[0]);
  }
  const { batch } = retained(f);
  const queue = [...f.tables.projectHostedLandingQueues.values()][0];
  const claim = await f.transaction('racing-queue-claim', driver.claim, {
    projectId: f.projectId,
    channel: 'main',
    wakeId: queue.wake.id,
  });
  assert(claim);
  const task = f
    .pending()
    .find(
      task =>
        task.name === 'projectHostedFinishDriver:drive' &&
        task.args[0].submissionId === (batch.leaderId ?? batch.id),
    );
  assert(task, 'the batch leader owns a pending source-preparation wake');
  await f.execute(task);
  assert(states(f)[0].batchNeedsSoloCompose, 'guard survives until the new attempt is published');
  await f.transaction('racing-old-queue-advance', driver.advance, claim);
  assert.equal(states(f)[0].phase, 'queued');
  assert.equal(states(f)[0].error, null);
  assert.equal(f.runs().length, 1);
  await f.drain();
  for (let i = 0; i < 3; i++) {
    await f.passChecks();
    await f.drain();
  }
  assert(states(f).every(s => s.phase === 'landed'));
  assert.equal(f.runs().length, 4);
});

for (const selected of [0, 1])
  test(`stall alarm releases a legacy checking batch after its ${selected ? 'member' : 'leader'} was cancelled`, async t => {
    const f = await batchesFixture(t, { count: 3 });
    await f.drain();
    const { batch } = retained(f);
    assert.equal(batch.phase, 'checking');
    // Reproduce the deployed cancellation bug: one terminal member, peers still
    // queued and attached to a checking batch, and every original wake gone.
    for (const task of f.pending())
      f.patch('_scheduled_functions', task._id, { state: { kind: 'canceled' } });
    for (const row of f.tables.projectHostedLandingRequests.values()) {
      const state = JSON.parse(row.value);
      state.phase = state.id === f.entries[selected].state.id ? 'terminal-failed' : 'queued';
      state.observation =
        state.phase === 'terminal-failed'
          ? { state: 'terminal-failed', cause: 'rejected', pendingReason: null }
          : { state: 'pending', cause: null, pendingReason: 'queued' };
      state.error =
        state.phase === 'terminal-failed'
          ? { code: 'LANDING_CANCELLED', message: 'Synthetic legacy cancellation' }
          : null;
      state.timing = { submittedAt: state.at };
      f.patch('projectHostedLandingRequests', row._id, {
        phase: state.phase,
        runnable: false,
        value: JSON.stringify(state),
      });
    }
    const orphan = [...f.tables.projectHostedLandingRequests.values()].find(row => row.phase === 'queued');
    const state = JSON.parse(orphan.value);
    const taskId = [...f.tables._scheduled_functions.values()][0]._id;
    f.patch('projectHostedLandingRequests', orphan._id, { alarm: { taskId, lastProgressAt: state.at } });
    f.advanceClock(LANDING_STALL_MS + 1000);
    await f.transaction('legacy-cancel-stall-alarm', stallApi.alarm, {
      projectId: f.projectId,
      submissionId: state.id,
      lastProgressAt: state.at,
    });
    assert.equal(retained(f).batch.phase, 'fallback');
    assert(states(f).every(s => !s.batchId));
    await f.drain();
    for (let i = 0; i < 2; i++) {
      await f.passChecks();
      await f.drain();
    }
    assert(
      states(f)
        .filter(s => s.id !== f.entries[selected].state.id)
        .every(s => s.phase === 'landed'),
    );
    assert.equal(states(f)[selected].phase, 'terminal-failed');
    assert.equal(f.pending().length, 0);
  });

for (const stalledPhase of ['composing', 'checking'])
  test(`a queued stall reselects every live member of a ${stalledPhase} batch without a terminal leader`, async t => {
    const f = await batchesFixture(t, { count: 3 });
    if (stalledPhase === 'checking') await f.drain();
    else
      for (let tick = 0; f.tables.projectHostedLandingBatches.size === 0; tick++) {
        assert(tick < 100);
        await f.execute(f.pending()[0]);
      }
    assert.equal(retained(f).batch.phase, stalledPhase);
    assert(states(f).every(state => !['landed', 'terminal-failed'].includes(state.phase)));
    for (const task of f.pending())
      f.patch('_scheduled_functions', task._id, { state: { kind: 'canceled' } });
    for (const row of f.tables.projectHostedLandingRequests.values()) {
      const state = JSON.parse(row.value);
      state.phase = 'queued';
      state.observation = { state: 'pending', cause: null, pendingReason: 'queued' };
      state.timing = { submittedAt: state.at };
      f.patch('projectHostedLandingRequests', row._id, {
        phase: 'queued',
        runnable: false,
        value: JSON.stringify(state),
      });
    }
    const target = [...f.tables.projectHostedLandingRequests.values()][1],
      state = JSON.parse(target.value);
    const taskId = [...f.tables._scheduled_functions.values()][0]._id;
    f.patch('projectHostedLandingRequests', target._id, { alarm: { taskId, lastProgressAt: state.at } });
    f.advanceClock(LANDING_STALL_MS + 1000);
    await f.transaction('live-batch-stall-alarm', stallApi.alarm, {
      projectId: f.projectId,
      submissionId: state.id,
      lastProgressAt: state.at,
    });
    assert.equal(retained(f).batch.phase, 'fallback');
    assert(states(f).every(state => !state.batchId && state.batchSolo));
    await f.drain();
    for (let i = 0; i < 3; i++) {
      await f.passChecks();
      await f.drain();
    }
    assert(states(f).every(state => state.phase === 'landed'));
    assert.equal(f.runs().length, stalledPhase === 'checking' ? 4 : 3);
    assert.equal(f.pending().length, 0);
  });

test('resume repairs a legacy queued stall whose alarm was already consumed', async t => {
  const { api } = await import('./hosted-finish-fixture.mjs');
  const { hostedLandingStall } = await import('../dist/hosted-landing-stall.js');
  const f = await batchesFixture(t, { count: 3 });
  await f.drain();
  for (const task of f.pending()) f.patch('_scheduled_functions', task._id, { state: { kind: 'canceled' } });
  f.advanceClock(LANDING_STALL_MS + 1000);
  const target = [...f.tables.projectHostedLandingRequests.values()][1],
    state = JSON.parse(target.value);
  state.phase = 'queued';
  state.timing = { submittedAt: state.at };
  state.observation = { state: 'pending', cause: null, pendingReason: 'queued' };
  state.observation.stall = hostedLandingStall(state);
  assert(state.observation.stall);
  f.patch('projectHostedLandingRequests', target._id, {
    phase: 'queued',
    runnable: false,
    alarm: null,
    value: JSON.stringify(state),
  });
  await f.transaction('resume-consumed-batch-stall', api.resume, {
    projectId: f.projectId,
    submissionId: state.id,
  });
  await f.drain();
  assert(states(f).every(state => !state.batchId));
  for (let i = 0; i < 3; i++) {
    await f.passChecks();
    await f.drain();
  }
  assert(states(f).every(state => state.phase === 'landed'));
  assert.equal(f.runs().length, 4);
  assert.equal(f.pending().length, 0);
});
