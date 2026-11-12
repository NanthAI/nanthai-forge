// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { reportFoldFixture } from './hosted-report-fold-guard.mjs';
import { moduleUrl } from './convex-module.mjs';
const collector = await import(moduleUrl('../convex/projectHostedActionsBatch.ts'));
const batchStore = await import(moduleUrl('../convex/projectHostedActionsBatchStore.ts'));
const results = await import(moduleUrl('../convex/projectHostedActionsResults.ts'));
const timingStore = await import(moduleUrl('../convex/projectHostedTestTimings.ts'));
const ingests = l => l.s.counts.filter(count => count.name === 'projectHostedActionsResults:batch');

for (const owner of ['U', 'W'])
  test(`S3 ${owner} collector coalesces concurrent ingress and consumes its arriving conclusion`, async t => {
    const l = await reportFoldFixture(t),
      request = globalThis.fetch;
    let reached, resume;
    const blocked = new Promise(resolve => {
      reached = resolve;
    });
    const gate = new Promise(resolve => {
      resume = resolve;
    });
    let paused = false;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      if (!paused && !init?.method && new URL(url).pathname.includes('/check-results/')) {
        paused = true;
        reached();
        await gate;
      }
      return request(url, init);
    });
    const first = l.events[owner]();
    await blocked;
    try {
      await l.events.U();
      await l.events.W();
      await l.events.C();
      assert.equal(ingests(l).length, 0, 'losing ingress never calls ingestion while the winner reads');
    } finally {
      resume();
    }
    await first;
    assert.equal(ingests(l).length, 1);
    assert.equal(l.stored().status, 'passed', 'the first collector uses the conclusion written during I/O');
    const row = [...l.s.tables.projectHostedCheckRuns.values()][0];
    assert.equal(row.reportConclusion, 'success');
    assert.equal(row.reportTimingComplete, true);
    assert.equal(row.reportCollection, undefined);
  });

test('S3 a lost final-output response repairs output without another ingestion or report PUT', async t => {
  const l = await reportFoldFixture(t),
    invoke = l.ctx.runMutation;
  let lose = true;
  l.ctx.runMutation = async (ref, input) => {
    const { getFunctionName } = await import('convex/server');
    if (getFunctionName(ref) === 'projectHostedActionsBatchStore:output' && lose) {
      lose = false;
      throw new Error('synthetic loss before output commit');
    }
    return invoke(ref, input);
  };
  await assert.rejects(l.events.U(), /synthetic loss/);
  assert.equal(ingests(l).length, 1);
  assert.equal([...l.s.tables.projectHostedOutputHeads.values()][0]?.final, undefined);
  await l.events.U();
  assert.equal(ingests(l).length, 1);
  assert([...l.s.tables.projectHostedOutputHeads.values()][0].final);
  await l.events.W();
  assert.equal(l.stored().status, 'passed');
  assert.equal(ingests(l).length, 1);
});

test('S3 interrupted timing repair resumes its pages without ingestion or duplicate samples', async t => {
  const l = await reportFoldFixture(t),
    invoke = l.ctx.runMutation;
  await l.events.U();
  l.ctx.runMutation = async (ref, input) => {
    const { getFunctionName } = await import('convex/server');
    if (getFunctionName(ref) === 'projectHostedTestTimings:argumentsPage')
      throw new Error('synthetic loss before timing page');
    return invoke(ref, input);
  };
  await assert.rejects(l.events.W(), /synthetic loss/);
  assert.equal(l.stored().status, 'passed');
  assert.equal(l.s.tables.projectHostedTestTimings.size, 0);
  l.ctx.runMutation = invoke;
  await l.events.W();
  assert.equal(ingests(l).length, 1);
  const row = [...l.s.tables.projectHostedCheckRuns.values()][0];
  assert.equal(row.reportTimingComplete, true);
  const before = l.s.counts.length;
  await l.s.transaction('timing-replay', timingStore.argumentsPage, {
    ...l.id,
    reportDigest: l.stored().reportPointer.digest,
    durations: JSON.stringify({ 'tests/fold-0.test.mjs': 17, 'tests/fold-1.test.mjs': 17 }),
    final: true,
  });
  assert(l.s.counts.slice(before).every(count => count.written.length === 0));
});

test('S3 identical direct settlement is a no-write replay; a changed report pointer is refused', async t => {
  const l = await reportFoldFixture(t),
    invoke = l.ctx.runMutation;
  let original;
  l.ctx.runMutation = async (ref, input) => {
    const { getFunctionName } = await import('convex/server');
    if (getFunctionName(ref) === 'projectHostedActionsResults:batch') original = structuredClone(input);
    return invoke(ref, input);
  };
  await l.events.U();
  await l.events.W();
  const before = l.s.counts.length;
  await l.s.transaction('direct-replay', results.batch, original);
  assert(l.s.counts.slice(before).every(count => count.written.length === 0));
  const header = JSON.parse(original.reportHeader);
  header.reportPointer.digest = '0'.repeat(64);
  await assert.rejects(
    l.s.transaction('changed-report', results.batch, {
      ...original,
      reportHeader: JSON.stringify(header),
    }),
    error => error.code === 'EVIDENCE_CHANGED',
  );
});

test('S3 a subsequent event can reclaim an abandoned collection; its stale owner cannot settle', async t => {
  const l = await reportFoldFixture(t);
  const first = JSON.parse(await l.s.transaction('reserve-first', batchStore.prepare, l.input));
  const again = JSON.parse(await l.s.transaction('reserve-busy', batchStore.prepare, l.input));
  assert.equal(again.collect, false);
  const row = [...l.s.tables.projectHostedCheckRuns.values()][0];
  // Synthetic expired execution, no timer, polling or real sleep.
  row.reportCollection.until = Date.now() - 1;
  const next = JSON.parse(await l.s.transaction('reserve-recovery', batchStore.prepare, l.input));
  assert.equal(next.collect, true);
  assert.notEqual(next.collectionToken, first.collectionToken);
  await assert.rejects(
    collector.collectResultBatch(l.ctx, l.input, undefined, first),
    error => error.code === 'EVIDENCE_CHANGED',
  );
  await collector.collectResultBatch(l.ctx, l.input, undefined, next);
  await l.events.W();
  assert.equal(l.stored().status, 'passed');
});

test('S3 confirmation replay repairs terminal timings after losing its first repair', async t => {
  const l = await reportFoldFixture(t),
    invoke = l.ctx.runMutation;
  await l.events.U();
  l.ctx.runMutation = async (ref, input) => {
    const { getFunctionName } = await import('convex/server');
    if (getFunctionName(ref) === 'projectHostedTestTimings:argumentsPage')
      throw new Error('synthetic confirmation timing loss');
    return invoke(ref, input);
  };
  await assert.rejects(l.events.C(), /synthetic confirmation timing loss/);
  assert.equal(l.stored().status, 'passed');
  l.ctx.runMutation = invoke;
  await l.events.C();
  assert.equal([...l.s.tables.projectHostedCheckRuns.values()][0].reportTimingComplete, true);
  assert.equal(ingests(l).length, 1);
});

test('S3 a completed webhook binds a dispatch with a lost run-id reply before collecting', async t => {
  const l = await reportFoldFixture(t);
  const row = [...l.s.tables.projectHostedCheckRuns.values()][0],
    run = JSON.parse(row.value);
  run.executionId = null;
  delete run.actions.workflowSha;
  run.actions.dispatchedWithoutId = true;
  row.value = JSON.stringify(run);
  await l.events.W();
  assert.equal(l.stored().executionId, '123');
  assert.equal(l.stored().status, 'passed');
  assert.equal(ingests(l).length, 1);
});

test('S3 every failure/cancellation ingress order retains reports and never samples a cancelled provider run', async t => {
  for (const failed of [false, true])
    for (const order of ['UWC', 'UCW', 'WUC', 'WCU', 'CUW', 'CWU']) {
      const l = await reportFoldFixture(t, { failed, conclusion: 'cancelled' });
      for (const event of order + order) {
        try {
          await l.events[event]();
        } catch (error) {
          assert.equal(event, 'U');
          assert.equal(
            error.data?.code,
            'CHECK_CANCELLED',
            'cancelled uploader retains its established refusal',
          );
        }
      }
      assert.equal(ingests(l).length, 1, order);
      assert.equal(l.s.tables.projectHostedTestTimings.size, 0, order);
      assert(
        !l.scheduled.some(task => task.name === 'projectHostedActionsBatch:collect'),
        'pinned cancellations never schedule a redundant collector',
      );
      assert.equal(l.stored().reportPointer.files, 2);
      assert.equal(l.stored().testFiles.counts.failed, failed ? 1 : 0);
    }
});

for (const state of ['failed', 'canceled', 'success'])
  for (const event of ['W', 'C', 'U'])
    test(`S3 ${event} immediately reclaims a scheduled holder ${state} without a fold`, async t => {
      const l = await reportFoldFixture(t);
      await l.s.transaction('reserve-interrupted', batchStore.prepare, l.input);
      const row = [...l.s.tables.projectHostedCheckRuns.values()][0];
      // Retained reservation of a scheduled collector that stopped before its fold.
      // The actual cancel/watchdog producer's id persistence is exercised below.
      row.reportCollection.scheduledFunctionId = 'scheduled-interrupted-collector';
      const holder = row.reportCollection;
      assert.equal(l.stored().reportPointer, undefined);
      assert(holder.until > Date.now(), 'recovery does not wait for the time backstop');
      l.scheduledStates.set(holder.scheduledFunctionId, { state: { kind: state } });
      await l.events[event]();
      assert.equal(ingests(l).length, 1);
      assert.equal(l.stored().reportPointer.files, 2);
      if (event === 'U') await l.events.W();
      assert.equal(l.stored().status, 'passed');
      assert.equal([...l.s.tables.projectHostedCheckRuns.values()][0].reportCollection, undefined);
      assert.equal([...l.s.tables.projectHostedCheckRuns.values()][0].reportTimingComplete, true);
    });

for (const state of ['pending', 'inProgress'])
  test(`S3 ${state} scheduled holder cannot be stolen even after the timestamp backstop`, async t => {
    const l = await reportFoldFixture(t, { conclusion: 'cancelled' });
    await l.s.cancel(l.id.runId);
    const row = [...l.s.tables.projectHostedCheckRuns.values()][0],
      holder = structuredClone(row.reportCollection);
    row.reportCollection.until = Date.now() - 1;
    l.scheduledStates.set(holder.scheduledFunctionId, { state: { kind: state } });
    await l.events.W();
    await l.events.C();
    await collector.collectResultBatch(l.ctx, { ...l.input, claims: undefined });
    assert.equal(ingests(l).length, 0);
    assert.equal(row.reportCollection.token, holder.token);
    const task = l.scheduled.find(task => task.id === holder.scheduledFunctionId);
    l.scheduledStates.set(holder.scheduledFunctionId, { state: { kind: 'inProgress' } });
    await collector.collect._handler(l.ctx, task.input);
    assert.equal(ingests(l).length, 1, 'the scheduled holder itself can settle');
    assert.equal(l.stored().reportPointer.files, 2);
  });

test('S3 an explicit unknown provider conclusion settles in either ingress order and never trains timings', async t => {
  for (const order of ['UW', 'WU']) {
    const l = await reportFoldFixture(t, { conclusion: null });
    for (const event of order) await l.events[event]();
    assert.equal(l.stored().status, 'runner-unavailable', order);
    assert.equal(ingests(l).length, 1);
    assert.equal(l.s.tables.projectHostedTestTimings.size, 0);
  }
});

test('S3 a null provider event arriving during collection is preserved by the owner', async t => {
  const l = await reportFoldFixture(t, { conclusion: null }),
    request = globalThis.fetch;
  let reached, resume;
  const blocked = new Promise(resolve => {
    reached = resolve;
  });
  const gate = new Promise(resolve => {
    resume = resolve;
  });
  let paused = false;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (!paused && !init?.method && new URL(url).pathname.includes('/check-results/')) {
      paused = true;
      reached();
      await gate;
    }
    return request(url, init);
  });
  const first = l.events.U();
  await blocked;
  try {
    await l.events.W();
  } finally {
    resume();
  }
  await first;
  assert.equal(l.stored().status, 'runner-unavailable');
  assert.equal(ingests(l).length, 1);
  assert.equal(l.s.tables.projectHostedTestTimings.size, 0);
  const start = l.s.counts.length;
  await l.events.W();
  assert(l.s.counts.slice(start).every(count => count.written.length === 0));
});

test('S3 a still-running provider confirmation immediately recovers every stopped scheduled holder', async t => {
  for (const kind of ['failed', 'canceled', 'success']) {
    const l = await reportFoldFixture(t);
    await l.s.transaction('reserve-interrupted', batchStore.prepare, l.input);
    const row = [...l.s.tables.projectHostedCheckRuns.values()][0];
    row.reportCollection.scheduledFunctionId = 'scheduled-interrupted-collector';
    l.scheduledStates.set(row.reportCollection.scheduledFunctionId, { state: { kind } });
    l.provider.completed = false;
    await l.events.C();
    assert.equal(ingests(l).length, 1, kind);
    assert.equal(l.stored().status, 'running', 'a non-final read is never an unknown completed conclusion');
    assert.equal(l.s.tables.projectHostedTestTimings.size, 0);
    await l.events.W();
    assert.equal(l.stored().status, 'passed');
    assert.equal(ingests(l).length, 1);
  }
});
