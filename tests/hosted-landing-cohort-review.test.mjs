// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic, batchStore } from './hosted-landing-batches-fixture.mjs';
import { landingApi } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const finishCompose = await import(moduleUrl('../convex/projectHostedFinishCompose.ts'));
const finishStore = await import(moduleUrl('../convex/projectHostedFinishStore.ts'));
const finishWake = await import(moduleUrl('../convex/projectHostedFinishWake.ts'));
const landingStore = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
const wake = await import(moduleUrl('../convex/projectHostedLandingWake.ts'));
const pipeline = await import(moduleUrl('../convex/projectHostedLandingPipeline.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const current = (f, index) => states(f).find(state => state.id === f.entries[index].state.id);
const batches = f => [...f.tables.projectHostedLandingBatches.values()].map(row => JSON.parse(row.value));
const rowOf = (f, id) =>
  [...f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === id);
const queueOf = f => [...f.tables.projectHostedLandingQueues.values()][0];
const invoke = (f, name, handler) => f.transaction(name, { _handler: handler }, {});
async function drain(f, skip = () => false) {
  for (let steps = 0; ; steps++) {
    const task = f.pending().find(task => !task.name.startsWith('projectHostedLandingStall:') && !skip(task));
    if (!task) return;
    assert(steps < 2000, 'finite event-driven progress');
    await f.execute(task);
  }
}
async function finish(f) {
  for (let wave = 0; states(f).some(state => !['landed', 'terminal-failed'].includes(state.phase)); wave++) {
    assert(wave < 20);
    const runs = f.runs().filter(run => run.status === 'queued');
    assert(runs.length, JSON.stringify(states(f).map(({ phase, error }) => ({ phase, error }))));
    for (const run of runs) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await drain(f);
  }
  assert.equal(f.pending().length, 0);
}
const mixed = {
  count: 6,
  batching: 'default',
  batchMaxSize: 3,
  memberPaths: ['independent-0', 'collision', 'independent-2', 'collision', 'independent-4', 'independent-5'],
};

for (const change of ['retry', 'head', 'receipt', 'fail', 'cancel'])
  test(`solo predecessor ${change} invalidates all descendant generations in its transition`, async t => {
    const f = await batchesFixture(t, { count: 1, batching: 'default', batchMaxSize: 2 });
    await drain(f);
    for (let index = 1; index < 6; index++) await f.add(index);
    await drain(f);
    const descendants = batches(f).filter(batch => batch.predecessor);
    assert(descendants.length >= 2, 'exercise transitive descendants');
    const active = await f.rawChecks.activate(descendants[0].runId);
    const solo = current(f, 0),
      key = { projectId: f.projectId, submissionId: solo.id };
    if (change === 'retry')
      await invoke(f, 'reserve-solo-repin', async ctx => {
        const old = await finishStore.loadFinish(ctx, key);
        await finishCompose.reserveFinishRetry(ctx, old.row, old.value);
      });
    else if (change === 'fail')
      await invoke(f, 'fail-solo', ctx =>
        finishStore.failFinish(ctx, key, 'SOURCE_UNAVAILABLE', 'synthetic failure'),
      );
    else if (change === 'cancel')
      await f.transaction('cancel-solo', landingApi.cancel, {
        projectId: f.projectId,
        request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: solo.id }),
      });
    else
      await invoke(f, 'replace-solo-pins', async ctx => {
        const old = await landingStore.loadLanding(ctx, key);
        const parent = await landingStore.loadLandingAttempt(ctx, {
          projectId: f.projectId,
          attemptId: old.state.attemptId,
        });
        const next = {
          ...parent,
          id: randomUUID(),
          parentAttemptId: parent.id,
          number: parent.number + 1,
          candidate: { ...parent.candidate, ...(change === 'head' ? { head: 'b'.repeat(64) } : {}) },
          operations: { ...parent.operations, ...(change === 'receipt' ? { accept: randomUUID() } : {}) },
        };
        await landingStore.insertLandingAttempt(ctx, next);
        await landingStore.writeLanding(
          ctx,
          old.row,
          { ...old.state, attemptId: next.id, version: old.state.version + 1 },
          false,
        );
      });
    for (const old of descendants) {
      assert.equal(batches(f).find(batch => batch.id === old.id).phase, 'superseded');
      for (const member of old.members) {
        const row = rowOf(f, member.submissionId);
        assert.equal(JSON.parse(row.value).batchId, undefined);
        assert.equal(row.runId, null);
      }
      assert.equal(f.runs().find(run => run.id === old.runId).status, 'cancelled');
    }
    if (change === 'retry') {
      const tail = await invoke(f, 'retired-solo-cannot-back-a-new-cohort', ctx =>
        pipeline.pipelinePredecessor(ctx, { projectId: f.projectId, channel: 'main' }),
      );
      assert.equal(tail, undefined);
    }
    if (change === 'fail' || change === 'cancel')
      assert(!queueOf(f).train.includes(solo.id), 'terminal predecessor consumed in its transition');
    const before = states(f).map(state => state.attemptId);
    await assert.rejects(f.rawChecks.pass(active), error => error.data?.code === 'CHECK_CANCELLED');
    assert.deepEqual(
      states(f).map(state => state.attemptId),
      before,
    );
    assert.equal(f.tables.projectHostedAcceptances.size, 0, 'late old proof never lands');
  });

test('failed survivor cohort recomposes parked rejection on actual main without failed peer attribution', async t => {
  const f = await batchesFixture(t, mixed);
  await drain(f);
  const cohort = batches(f).find(batch => batch.predecessor);
  assert.equal(current(f, 3).phase, 'queued');
  await f.fail(cohort.runId);
  await drain(f);
  // 51bbbd00: the failing file names no member and the predecessor has not
  // passed, so the stacked cohort first rechecks once on current main without it.
  const unstacked = batches(f).find(batch => batch.id === cohort.id);
  assert.equal(unstacked.transition?.code, 'STACKED_FAILURE_UNSTACKED');
  assert.equal(unstacked.predecessor, undefined);
  assert.notEqual(unstacked.runId, cohort.runId);
  // Failing again on its own base, it splits as before.
  await f.fail(unstacked.runId);
  await drain(f);
  const rejected = current(f, 3);
  assert.equal(batches(f).find(batch => batch.id === cohort.id).phase, 'split');
  assert.notEqual(rejected.error?.code, 'COMPOSITION_CONFLICT', 'failed survivors were never main');
  assert.equal(rejected.batchId, undefined);
  const attempt = [...f.tables.projectHostedLandingAttempts.values()].find(
    row => row.attemptId === rejected.attemptId,
  );
  assert.equal(JSON.parse(attempt.value).main.head, f.currentMain().head);
  assert.equal(rowOf(f, rejected.id).wouldConflict, undefined);
  await f.rawChecks.pass(await f.rawChecks.activate(f.runs()[0].id));
  await drain(f);
  await finish(f);
  if (current(f, 3).error?.code === 'COMPOSITION_CONFLICT') {
    for (const index of [4, 5]) assert(!current(f, 3).error.message.includes(f.entries[index].lane.laneId));
  }
});

for (const outcome of ['failed', 'cancelled'])
  test(`predecessor ${outcome} retires checking survivors and their parked rejected member together`, async t => {
    const f = await batchesFixture(t, mixed);
    await drain(f);
    const cohort = batches(f).find(batch => batch.predecessor);
    const active = await f.rawChecks.activate(cohort.runId);
    if (outcome === 'failed') await f.fail(f.runs()[0].id);
    else
      await f.transaction('cancel-predecessor-member', landingApi.cancel, {
        projectId: f.projectId,
        request: JSON.stringify({
          operationId: randomUUID(),
          authorityEpoch: 1,
          submissionId: f.entries[0].state.id,
        }),
      });
    await drain(f);
    assert.equal(batches(f).find(batch => batch.id === cohort.id).phase, 'superseded');
    assert.equal(rowOf(f, current(f, 3).id).wouldConflict, undefined);
    assert.notEqual(current(f, 3).error?.code, 'COMPOSITION_CONFLICT');
    await assert.rejects(f.rawChecks.pass(active), error => error.data?.code === 'CHECK_CANCELLED');
    await finish(f);
  });

test('all-dropped speculative cohort leaves the train and later independent cohorts check immediately', async t => {
  const f = await batchesFixture(t, {
    count: 9,
    batching: 'default',
    batchMaxSize: 3,
    memberPaths: ['a', 'b', 'c', 'a', 'b', 'c', 'unrelated-6', 'unrelated-7', 'unrelated-8'],
  });
  await drain(f);
  const dropped = batches(f).find(batch => batch.included?.length === 0);
  assert(dropped);
  for (const member of dropped.members) assert(!queueOf(f).train.includes(member.submissionId));
  for (const index of [6, 7, 8]) assert.equal(current(f, index).phase, 'checking');
  assert.equal(f.runs().length, 2);
  const next = batches(f).find(batch =>
    batch.members.some(member => member.submissionId === current(f, 6).id),
  );
  assert.equal(next.predecessor.submissionId, current(f, 2).id);
  await finish(f);
});

for (const phase of ['checking', 'ready'])
  test(`rejected member evidence error during ${phase} settlement leaves survivor proof unchanged`, async t => {
    const f = await batchesFixture(t, mixed);
    await drain(f);
    const cohort = batches(f).find(batch => batch.predecessor);
    const survivorAttempts = [current(f, 4).attemptId, current(f, 5).attemptId];
    const corrupt = () => {
      const row = [...f.tables.projectHostedLandingBatches.values()].find(row => row.batchId === cohort.id);
      const stale = JSON.parse(row.value);
      stale.members.find(member => member.submissionId === current(f, 3).id).candidate.digest = 'c'.repeat(
        64,
      );
      f.patch('projectHostedLandingBatches', row._id, { value: JSON.stringify(stale) });
    };
    if (phase === 'ready') {
      await f.rawChecks.pass(await f.rawChecks.activate(cohort.runId));
      await drain(f);
      assert.equal(current(f, 4).phase, 'ready');
    }
    corrupt();
    await f.rawChecks.pass(await f.rawChecks.activate(f.runs()[0].id));
    await drain(f);
    assert.equal(current(f, 3).error?.code, 'EVIDENCE_CHANGED');
    assert.equal(
      batches(f).find(batch => batch.id === cohort.id).phase,
      phase === 'ready' ? 'landed' : 'checking',
    );
    assert.deepEqual([current(f, 4).attemptId, current(f, 5).attemptId], survivorAttempts);
    await finish(f);
    for (const index of [4, 5]) assert.equal(current(f, index).phase, 'landed');
    assert.equal(f.runs().length, 2);
  });

for (const retained of ['survivors', 'empty'])
  test(`retry of a trimmed cohort with ${retained} train restores member order and the successor tail receipt`, async t => {
    const f = await batchesFixture(t, {
      ...mixed,
      memberPaths: [
        'independent-0',
        'collision',
        'independent-2',
        'independent-3',
        'independent-4',
        'collision',
      ],
    });
    await drain(f);
    const cohort = batches(f).find(batch => batch.predecessor);
    assert(!queueOf(f).train.includes(current(f, 5).id));
    if (retained === 'empty') f.patch('projectHostedLandingQueues', queueOf(f)._id, { train: undefined });
    await invoke(f, 'retry-trimmed-cohort', ctx =>
      batchStore.retryLandingBatch(ctx, { projectId: f.projectId, batchId: cohort.id }, cohort),
    );
    assert.deepEqual(
      queueOf(f).train.slice(-3),
      cohort.members.map(member => member.submissionId),
    );
    await drain(f);
    const retry = batches(f).find(batch => batch.id === cohort.id);
    assert.deepEqual(
      retry.included,
      cohort.members.map(member => member.submissionId),
    );
    const tail = await invoke(f, 'select-restored-tail', ctx =>
      pipeline.pipelinePredecessor(ctx, { projectId: f.projectId, channel: 'main' }),
    );
    const expected = [...f.tables.projectHostedLandingAttempts.values()]
      .map(row => JSON.parse(row.value))
      .find(attempt => attempt.id === current(f, 5).attemptId);
    assert.deepEqual(tail, {
      submissionId: current(f, 5).id,
      head: expected.candidate.head,
      receiptId: expected.operations.accept,
    });
    await f.add(6);
    await drain(f);
    const successor = batches(f).find(batch => batch.predecessor?.submissionId === current(f, 5).id);
    assert.deepEqual(successor?.predecessor, tail, 'new cohort pins the restored final receipt');
  });

test('terminal solo train row invalidation is consumed once while another cohort keeps checking', async t => {
  const f = await batchesFixture(t, { count: 4, batchMaxSize: 2 });
  await drain(f);
  const terminal = current(f, 0),
    row = rowOf(f, terminal.id),
    queue = queueOf(f);
  // Simulate a retained row written by an older deployment. Its independent
  // successor must keep checking while this legacy terminal row is consumed.
  f.patch('projectHostedLandingRequests', row._id, {
    phase: 'terminal-failed',
    runnable: false,
    value: JSON.stringify({
      ...terminal,
      batchId: undefined,
      phase: 'terminal-failed',
      error: { code: 'SOURCE_UNAVAILABLE', message: 'legacy' },
    }),
  });
  await invoke(f, 'consume-terminal-train', ctx => wake.nextTrainLandingRow(ctx, queue));
  assert(!queueOf(f).train.includes(terminal.id));
  const before = f.counts.length;
  await invoke(f, 'later-queue-event', ctx => wake.nextTrainLandingRow(ctx, queueOf(f)));
  assert.equal(f.counts[before].writes, 0, 'unchanged checking queue has no invalidation writes');
});

for (const index of [4])
  test(`late conflicting precompose for shared member ${index} cannot overwrite the retained shared result`, async t => {
    const f = await batchesFixture(t, mixed);
    await drain(f);
    const member = current(f, index),
      key = { projectId: f.projectId, submissionId: member.id };
    const cohort = batches(f).find(batch => batch.id === member.batchId);
    const before = member.attemptId;
    await invoke(f, 'reserve-late-member-probe', async ctx => {
      const old = await finishStore.loadFinish(ctx, key);
      await finishCompose.reserveFinishRetry(ctx, old.row, old.value, 'CHECK_EVIDENCE_REFRESH', {
        peerLanes: [f.entries[1].lane.laneId],
        paths: ['collision'],
        runnable: false,
      });
    });
    await invoke(f, 'complete-late-conflicting-probe', async ctx => {
      const old = await finishStore.loadFinish(ctx, key);
      // A durable conflicting worker result arrives after the shared compose.
      // It has no ownership of either the installed survivor proof or parked rejection.
      await finishCompose.installFinishCompose(ctx, old.row, old.value, undefined, {
        operation: {
          terminal: {
            outcome: {
              status: 'completed',
              result: {
                ...f.entries[index].candidate,
                result: { status: 'conflict', conflicts: { sha256: 'd'.repeat(64), size: 1 } },
              },
            },
          },
        },
      });
    });
    assert.equal(current(f, index).attemptId, before);
    assert.equal(current(f, index).phase, index === 3 ? 'queued' : 'checking');
    assert.equal(current(f, index).error, null);
    assert.equal(batches(f).find(batch => batch.id === cohort.id).runId, cohort.runId);
    await drain(f);
    await finish(f);
  });

test('revoked rejected member at publication cannot discard passed survivor evidence', async t => {
  const f = await batchesFixture(t, {
    ...mixed,
    memberPaths: [
      'independent-0',
      'collision',
      'independent-2',
      'independent-3',
      'independent-4',
      'collision',
    ],
  });
  await drain(f);
  const cohort = batches(f).find(batch => batch.predecessor);
  await f.rawChecks.pass(await f.rawChecks.activate(cohort.runId));
  await drain(f);
  const attempts = [current(f, 3).attemptId, current(f, 4).attemptId];
  const row = [...f.tables.projectHostedLandingBatches.values()].find(row => row.batchId === cohort.id);
  const retained = JSON.parse(row.value);
  retained.members.at(-1).actor.id = 'revoked-member';
  f.patch('projectHostedLandingBatches', row._id, { value: JSON.stringify(retained) });
  await f.rawChecks.pass(await f.rawChecks.activate(f.runs()[0].id));
  await drain(f);
  assert.equal(current(f, 5).error?.code, 'PROJECT_UNAVAILABLE');
  assert.equal(batches(f).find(batch => batch.id === cohort.id).phase, 'landed');
  assert.deepEqual([current(f, 3).attemptId, current(f, 4).attemptId], attempts);
  for (const index of [3, 4]) assert.equal(current(f, index).phase, 'landed');
  assert.equal(f.runs().length, 2);
});

test('late member probe after predecessor invalidation cannot replace the restored original selection', async t => {
  const f = await batchesFixture(t, mixed);
  await drain(f);
  const member = current(f, 3),
    key = { projectId: f.projectId, submissionId: member.id };
  await invoke(f, 'reserve-before-invalidation', async ctx => {
    const old = await finishStore.loadFinish(ctx, key);
    await finishCompose.reserveFinishRetry(ctx, old.row, old.value, 'CHECK_EVIDENCE_REFRESH', {
      peerLanes: [],
      paths: ['collision'],
      runnable: false,
    });
  });
  const root = batches(f).find(batch => !batch.predecessor);
  await invoke(f, 'invalidate-probed-descendant', ctx =>
    pipeline.invalidatePipeline(ctx, { projectId: f.projectId, batchId: root.id }, root),
  );
  const restored = current(f, 3).attemptId;
  assert.notEqual(restored, member.attemptId);
  await invoke(f, 'complete-obsolete-probe', async ctx => {
    const old = await finishStore.loadFinish(ctx, key);
    await finishCompose.installFinishCompose(ctx, old.row, old.value, undefined, {
      operation: {
        terminal: {
          outcome: {
            status: 'completed',
            result: {
              ...f.entries[3].candidate,
              result: { status: 'conflict', conflicts: { sha256: 'e'.repeat(64), size: 1 } },
            },
          },
        },
      },
    });
  });
  assert.equal(current(f, 3).attemptId, restored);
  assert.equal(current(f, 3).phase, 'queued');
  assert.equal(current(f, 3).error, null);
  await drain(f);
  await finish(f);
});

test('solo re-pin wakes an entirely rejected cohort even after every member left the train', async t => {
  const f = await batchesFixture(t, {
    count: 1,
    batching: 'default',
    batchMaxSize: 2,
    memberPaths: ['collision', 'collision', 'collision'],
  });
  await drain(f);
  await f.add(1);
  await f.add(2);
  await drain(f);
  const cohort = batches(f).find(batch => batch.included?.length === 0);
  assert(cohort);
  assert.deepEqual(queueOf(f).train, [current(f, 0).id]);
  const key = { projectId: f.projectId, submissionId: current(f, 0).id };
  await invoke(f, 'repin-solo-with-off-train-waiters', async ctx => {
    const old = await finishStore.loadFinish(ctx, key);
    await finishCompose.reserveFinishRetry(ctx, old.row, old.value);
  });
  await drain(f);
  assert.notEqual(
    batches(f).find(batch => batch.id === cohort.id).composeOperationId,
    cohort.composeOperationId,
  );
  await finish(f);
});

test('re-pin wake preserves ordinary order waiters across pages and reaches the parked conflict cohort', async t => {
  const f = await batchesFixture(t, {
    count: 1,
    batching: 'default',
    batchMaxSize: 2,
    memberPaths: ['collision', 'collision', 'collision'],
  });
  await drain(f);
  await f.add(1);
  await f.add(2);
  await drain(f);
  const predecessor = current(f, 0).id;
  for (const [offset, index] of [1, 2].entries()) {
    const state = current(f, index),
      row = rowOf(f, state.id);
    f.patch('projectHostedLandingRequests', row._id, {
      sequence: 100 + offset,
      value: JSON.stringify({ ...state, sequence: 100 + offset }),
    });
  }
  const ordinary = [];
  for (let index = 0; index < 40; index++) {
    const id = randomUUID();
    f.insert('projectHostedLandingRequests', {
      projectId: f.projectId,
      channel: 'main',
      submissionId: id,
      operationId: randomUUID(),
      actor: 'owner',
      sequence: index + 10,
      runnable: false,
      phase: 'queued',
      runId: null,
      attemptId: randomUUID(),
      orderWait: predecessor,
      value: '{}',
    });
    ordinary.push(id);
  }
  let pages = 0;
  await invoke(f, 'wake-only-speculative-pages', async ctx => {
    const query = ctx.db.query;
    ctx.db.query = table => {
      if (table === 'projectHostedLandingRequests')
        assert(++pages <= 3, 'page scan must make progress past unchanged ordinary waiters');
      return query(table);
    };
    try {
      await finishWake.wakeLandingOrderWaiters(ctx, rowOf(f, predecessor), true);
    } finally {
      ctx.db.query = query;
    }
  });
  assert.equal(pages, 2);
  for (const id of ordinary) assert.equal(rowOf(f, id).orderWait, predecessor);
  assert.equal(rowOf(f, current(f, 1).id).orderWait, undefined);
  assert(
    f
      .pending()
      .some(
        task =>
          task.name === 'projectHostedFinishDriver:drive' && task.args[0].submissionId === current(f, 1).id,
      ),
  );
});
