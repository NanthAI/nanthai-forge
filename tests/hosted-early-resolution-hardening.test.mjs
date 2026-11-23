// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finishFixture, desired, landingApi } from './hosted-finish-fixture.mjs';
import { batchesFixture, synthetic, states, batchStore } from './hosted-landing-batches-fixture.mjs';
import { drainReady } from './early-resolution-replay.mjs';
import { moduleUrl } from './convex-module.mjs';
const store = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
const stall = await import(moduleUrl('../convex/projectHostedLandingStall.ts'));
const withdraw = await import(moduleUrl('../convex/projectHostedLandingWithdraw.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const command = f => ({
  operationId: randomUUID(),
  authorityEpoch: 1,
  composeOperationId: f.selection.request.operationId,
  after: null,
  check: f.request().check,
});
const submit = (f, request) =>
  f
    .tx('hardening-desired-submit', desired.submit, {
      projectId: f.projectId,
      request: JSON.stringify(request),
    })
    .then(JSON.parse);

test('8c9b84fc: withdrawing a preparing goal cancels it once and fences late source completion', async t => {
  const f = await finishFixture(t);
  const source = [...f.tables.projectHostedOperations.values()].find(
    r => r.operationId === f.selection.request.operationId,
  );
  const retained = source.value;
  f.patch('projectHostedOperations', source._id, {
    value: JSON.stringify({ ...JSON.parse(retained), terminal: null }),
  });
  const goal = await submit(f, command(f));
  assert.equal(goal.phase, 'composing');
  const request = { operationId: randomUUID(), authorityEpoch: 1, laneId: f.lane.laneId };
  const cancelled = await f
    .tx('withdraw-preparing-goal', withdraw.withdraw, {
      projectId: f.projectId,
      request: JSON.stringify(request),
    })
    .then(JSON.parse);
  assert.equal(cancelled.error?.code, 'LANDING_CANCELLED');
  const replay = await f
    .tx('replay-withdraw-preparing-goal', withdraw.withdraw, {
      projectId: f.projectId,
      request: JSON.stringify(request),
    })
    .then(JSON.parse);
  assert.deepEqual(replay, cancelled);
  f.patch('projectHostedOperations', source._id, { value: retained });
  await f.drain();
  assert.equal(f.tables.projectHostedLandingRequests.size, 0);
  assert.equal(f.tables.projectHostedCheckRuns.size, 0);
  assert.equal(f.pending().length, 0);
});

test('8c9b84fc: another contributor cannot withdraw a preparing goal', async t => {
  const f = await finishFixture(t);
  const source = [...f.tables.projectHostedOperations.values()].find(
    r => r.operationId === f.selection.request.operationId,
  );
  f.patch('projectHostedOperations', source._id, {
    value: JSON.stringify({ ...JSON.parse(source.value), terminal: null }),
  });
  const goal = await submit(f, command(f));
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'other' });
  await assert.rejects(
    f.tx(
      'refuse-peer-preparing-withdraw',
      withdraw.withdraw,
      {
        projectId: f.projectId,
        request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, laneId: f.lane.laneId }),
      },
      'other',
    ),
    e => (e.data?.code ?? e.code) === 'PROJECT_UNAVAILABLE',
  );
  await assert.rejects(
    f.tx(
      'refuse-peer-preparing-cancel-by-id',
      landingApi.cancel,
      {
        projectId: f.projectId,
        request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: goal.id }),
      },
      'other',
    ),
    e => (e.data?.code ?? e.code) === 'PROJECT_UNAVAILABLE',
  );
  assert(
    [...f.tables.projectHostedLandingDesired.values()].every(
      row => JSON.parse(row.value).phase === 'composing',
    ),
  );
});

test('8c9b84fc: a five-minute recovery alarm outside composing rearms the ordinary fifteen-minute alarm', async t => {
  const f = await batchesFixture(t, { count: 2 });
  await drainReady(f);
  const state = states(f)[0],
    key = { projectId: f.projectId, batchId: state.batchId };
  await f.transaction(
    'retry-cohort-for-early-alarm',
    {
      _handler: async ctx =>
        batchStore.retryLandingBatch(ctx, key, (await batchStore.loadBatch(ctx, key)).batch),
    },
    {},
  );
  const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === state.id);
  const group = [...f.tables.projectHostedLandingBatches.values()].find(r => r.batchId === key.batchId);
  // Retry has left composing without changing the leader's progress token yet.
  f.patch('projectHostedLandingBatches', group._id, {
    value: JSON.stringify({ ...JSON.parse(group.value), phase: 'checking' }),
  });
  const alarm = f.tables._scheduled_functions.get(row.alarm.taskId);
  f.advanceClock(alarm.scheduledTime - Date.now());
  await f.transaction('fire-early-recovery-alarm', stall.alarm, alarm.args[0]);
  const next = f.tables.projectHostedLandingRequests.get(row._id).alarm;
  assert(next, 'ordinary alarm survives early recovery');
  const task = f.tables._scheduled_functions.get(next.taskId);
  assert.equal(task.name, 'projectHostedLandingStall:alarm');
  assert.equal(task.scheduledTime, Date.parse(next.lastProgressAt) + 900000);
});

test('8c9b84fc: same-selection retry probes a ready row whose finish wake failed', async t => {
  const f = await finishFixture(t);
  const request = command(f),
    goal = await submit(f, request);
  await f.drain();
  const run = [...f.tables.projectHostedCheckRuns.values()].map(r => JSON.parse(r.value))[0];
  await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  for (let n = 0; n < 50; n++) {
    const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === goal.id);
    if (row?.phase === 'ready') break;
    const task = f
      .pending()
      .find(
        t => t.name !== 'projectHostedFinishDriver:drive' && !/LandingStall|CheckLease:expire/.test(t.name),
      );
    assert(task, 'check event moves the entry ready');
    await f.execute(task);
  }
  const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === goal.id);
  assert.equal(row.phase, 'ready');
  const finish = [...f.tables.projectHostedFinishes.values()].find(r => r.submissionId === goal.id);
  f.patch('_scheduled_functions', finish.wake.taskId, { state: { kind: 'failed' } });
  const joined = await submit(f, { ...request, operationId: randomUUID() });
  assert.equal(joined.id, goal.id, 'retry reuses the same canonical submission');
  const driven = [...f.tables.projectHostedFinishes.values()].find(r => r.submissionId === goal.id);
  assert.equal(f.tables._scheduled_functions.get(driven.wake.taskId).state.kind, 'pending');
  await f.drain();
  assert.equal((await f.current(goal.id)).submission.phase, 'landed');
  assert.equal(f.pending().length, 0);
});

test('8c9b84fc: an advice read failure after parking one rejected member rolls the whole transaction back', async t => {
  const advice = await import(moduleUrl('../convex/projectHostedLandingSpeculativeConflict.ts'));
  const alarm = await import(moduleUrl('../convex/projectHostedLandingStallWake.ts'));
  const f = await batchesFixture(t, {
    count: 0,
    batchMaxSize: 4,
    fileCount: 2,
    baselineFiles: [['shared.txt', 'alpha\nmiddle\nomega\n']],
    memberPaths: ['root.txt', 'shared.txt', 'shared.txt', 'shared.txt'],
    memberContents: [
      'root',
      'alpha-a\nmiddle\nomega\n',
      'alpha-c\nmiddle\nomega-c\n',
      'alpha-d\nmiddle\nomega-d\n',
    ],
  });
  await f.add(0);
  await drainReady(f);
  for (const n of [1, 2, 3]) await f.add(n);
  await drainReady(f);
  const survivor = states(f).find(s => s.id === f.entries[1].state.id);
  const group = JSON.parse(
    [...f.tables.projectHostedLandingBatches.values()].find(r => r.batchId === survivor.batchId).value,
  );
  const pin = await f.transaction(
    'advice-survivor-pin',
    {
      _handler: async ctx => {
        const exact = await store.loadLandingAttempt(ctx, {
          projectId: f.projectId,
          attemptId: survivor.attemptId,
        });
        return { submissionId: survivor.id, head: exact.candidate.head, receiptId: exact.operations.accept };
      },
    },
    {},
  );
  const rejected = f.entries.slice(2).map(entry => entry.state.id);
  await f.transaction(
    'reset-advice-for-fault-replay',
    {
      _handler: async ctx => {
        for (const id of rejected) {
          const { row, state } = await store.loadLanding(ctx, { projectId: f.projectId, submissionId: id });
          await ctx.db.patch(row._id, {
            orderWait: undefined,
            wouldConflict: undefined,
            alarm: await alarm.armLandingAlarm(ctx, row, state.at),
          });
        }
      },
    },
    {},
  );
  const before = [...f.tables.projectHostedLandingRequests.values()].filter(r =>
    rejected.includes(r.submissionId),
  );
  await assert.rejects(
    f.transaction(
      'inject-second-member-advice-read-failure',
      {
        _handler: async ctx => {
          let parked = false;
          const query = ctx.db.query.bind(ctx.db),
            patch = ctx.db.patch.bind(ctx.db);
          ctx.db.patch = async (id, change) => {
            if (
              change.orderWait &&
              rejected.some(member => before.find(r => r.submissionId === member)?._id === id)
            )
              parked = true;
            return patch(id, change);
          };
          ctx.db.query = table => {
            if (parked && table === 'projectHostedLandingAttempts')
              throw new Error('synthetic advice read after first park');
            return query(table);
          };
          await advice.deferSpeculativeConflict(
            ctx,
            { projectId: f.projectId, batchId: group.id },
            group,
            f.entries
              .slice(2)
              .map(entry => ({ candidateId: entry.candidate.id, paths: ['shared.txt'], more: 0 })),
            pin,
          );
        },
      },
      {},
    ),
    /synthetic advice read after first park/,
  );
  for (const old of before)
    assert.deepEqual(
      f.tables.projectHostedLandingRequests.get(old._id),
      old,
      'no parked member may commit after a partial advice failure',
    );
});
