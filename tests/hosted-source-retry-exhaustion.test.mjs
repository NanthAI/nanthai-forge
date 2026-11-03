// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { saveBytes } from '../dist/hosted-save.js';
import { initialSourceStep } from '../dist/hosted-source-step.js';
import { saveSourceProgress } from '../dist/hosted-source-step-progress.js';
import { sourceWorkerPlan } from '../dist/convex-source-provider.js';
import { hostedPayloadHash } from '../dist/hosted-source-operation.js';
import { normalizeHostedFinishResult } from '../dist/hosted-agent-finish-result.js';
import { assertAgentResponseShape } from './agent-response-shape.mjs';
import { HOSTED_FINISH_COMPOSE_WATCH_WINDOW_MS } from '../dist/hosted-finish.js';
const jobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));
const store = await import(moduleUrl('../convex/projectConvexSourceStore.ts'));
const fanout = await import(moduleUrl('../convex/projectConvexSourceFanout.ts'));
const { sourceStorage } = await import(moduleUrl('../convex/projectConvexSourceStorage.ts'));
async function fixture(t, fork = true) {
  for (const [key, value] of Object.entries({
    FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
    FORGE_SOURCE_PROVIDER: 'convex',
    R2_ACCOUNT_ID: 'synthetic',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
  })) {
    const prior = process.env[key];
    process.env[key] = value;
    t.after(() => (prior === undefined ? delete process.env[key] : (process.env[key] = prior)));
  }
  const middle = 'unchanged '.repeat(14000) + '\n';
  const files = text =>
    Array.from({ length: 120 }, (_, i) => [`file-${String(i).padStart(4, '0')}.txt`, text]);
  const f = await finishFixture(t, {
    baselineFiles: files('start\n' + middle + 'end\n'),
    selectedFiles: files('ours\n' + middle + 'end\n'),
    mainFiles: files('start\n' + middle + 'theirs\n'),
  });
  const state = await f.enqueue(f.request());
  await f.drain();
  f.moveMain();
  await f.passChecks();
  for (
    let i = 0;
    !f.pending().some(x => x.name === (fork ? 'projectConvexSourceTask:run' : 'projectConvexSource:step'));
    i++
  ) {
    assert(i < 30);
    await f.execute();
  }
  const step = [...f.tables.projectSourceSteps.values()][0];
  const load = () =>
    f.tx('retryReadJob', { _handler: ctx => jobs.loadSourceJob(ctx, f.projectId, step.jobId) }, {});
  return { f, state, step, load };
}
function failingReads(t) {
  const original = globalThis.fetch;
  let enabled = true;
  t.mock.method(globalThis, 'fetch', (url, init) => {
    if (enabled && (!init?.method || init.method === 'GET'))
      return new Response('private-retry-sentinel', { status: 503 });
    return original(url, init);
  });
  return () => {
    enabled = false;
  };
}
function assertRetry(state, operationId) {
  const root = '/synthetic/checkout',
    selection = { operationId, laneId: state.request.laneIds?.[0] ?? randomUUID() };
  const result = normalizeHostedFinishResult(root, selection, {
    status: 'submitted',
    progress: { status: 'submitted' },
    submission: state,
  });
  const next = assertAgentResponseShape({ operationId, result }, root);
  assert.equal(result.status, 'failed');
  assert.equal(result.terminal, true);
  assert.equal(next.action, 'finish');
  assert.equal(next.body.retry, true);
  assert.equal(next.body.operationId, undefined);
  assert(!JSON.stringify(result).includes('private-retry-sentinel'));
}
async function queuedProject(f) {
  const projectId = f.insert('hostedProjects', {
    key: 'other',
    name: 'Other',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  const page = f.c.put(
    saveBytes({ schema: 1, kind: 'forge-source-worker-page', objects: [], files: [], next: null }),
  );
  const input = f.c.put(
    saveBytes({
      schema: 1,
      kind: 'forge-source-worker-state',
      parents: [],
      pages: page,
      message: '',
      at: new Date(Date.now()).toISOString(),
    }),
  );
  for (const pin of [page, input])
    f.insert('projectObjects', {
      projectId,
      digest: pin.sha256,
      size: pin.size,
      removed: false,
      nonce: randomUUID(),
      location: 'r2',
      r2Committed: true,
      r2Key: `v1/p/${projectId}/o/${pin.sha256}`,
    });
  const operationId = randomUUID(),
    jobId = randomUUID(),
    expected = { authorityEpoch: 1 };
  const payload = { jobKind: 'register-state', input, inputDigest: input.sha256, ...sourceWorkerPlan({}) };
  await f.tx(
    'queueOtherJob',
    {
      _handler: ctx =>
        jobs.enqueueSourceJob(ctx, {
          projectId,
          actor: 'owner',
          request: {
            schema: 1,
            projectId,
            actor: 'owner',
            operationId,
            expected,
            payloadHash: hostedPayloadHash(payload, expected),
          },
          payload,
          firstAttempt: {
            projectId,
            operationId,
            id: randomUUID(),
            parentAttemptId: null,
            at: new Date(Date.now()).toISOString(),
            expected,
            ids: { job: jobId },
          },
        }),
    },
    {},
  );
  await f.tx('dispatchOtherJob', store.dispatch, { projectId, jobId });
  const row = [...f.tables.projectSourceSteps.values()].find(x => x.jobId === jobId);
  await f.tx('cancelOtherSerialDelivery', { _handler: ctx => ctx.scheduler.cancel(row.scheduledId) }, {});
  const cursor = (
    await saveSourceProgress(initialSourceStep(input), null, sourceStorage({ storage: {} }, projectId).store)
  ).id;
  await f.tx('queueOtherBatch', fanout.fork, {
    projectId,
    jobId,
    step: 0,
    cursor,
    kind: 'verify',
    end: 0,
    tasks: [JSON.stringify({ kind: 'verify', refs: [] })],
  });
  assert.equal([...f.tables.projectSourceTasks.values()].find(x => x.jobId === jobId).status, 'queued');
  return { projectId, jobId };
}
test('four poisoned slots reach six failed attempts, settle visibly, and release another queued project', async t => {
  const { f, state, step, load } = await fixture(t),
    original = await load();
  let other;
  const recover = failingReads(t);
  const counts = new Map(),
    delays = [];
  for (let actions = 0; (await load()).status !== 'failed'; actions++) {
    assert(actions < 25, 'a poisoned quantum cannot retry without a cap');
    const action = f
      .pending()
      .find(x => x.name === 'projectConvexSourceTask:run' && x.args[0].jobId === step.jobId);
    assert(action);
    if (action.scheduledTime >= (await load()).control.workerUntil) {
      await f.execute(f.pending().find(x => x.name === 'projectHostedFinishDriver:drive'));
      await f.execute(
        f.pending().find(x => x.name === 'projectConvexSource:dispatch' && x.args[0].jobId === step.jobId),
      );
      if (!other) other = await queuedProject(f);
      continue;
    }
    const index = action.args[0].index;
    counts.set(index, (counts.get(index) ?? 0) + 1);
    await assert.rejects(f.execute(action), { name: 'SourceIoError' });
    const task = [...f.tables.projectSourceTasks.values()].find(
      x => x.jobId === step.jobId && x.index === index,
    );
    assert.equal(task.failedAttempts, counts.get(index));
    assert(task.failedAttempts <= 6);
    const replacement = f
      .pending()
      .find(x => x.name === action.name && x.args[0].jobId === step.jobId && x.args[0].index === index);
    if (replacement) delays.push(replacement.scheduledTime - Date.now());
    assert([...f.tables.projectSourcePools.values()][0].active.length <= 4);
    await f.tx('unrelatedPoolActivity', fanout.drain, {});
    assert.equal(
      [...f.tables.projectSourceTasks.values()].find(x => x._id === task._id).failedAttempts,
      task.failedAttempts,
      'unrelated drains cannot bypass the count',
    );
  }
  const failed = await load();
  for (const key of ['id', 'executionId', 'attempt', 'fence', 'inputDigest'])
    assert.equal(failed[key], original[key]);
  assert.equal(failed.control.failureCode, 'SOURCE_RETRY_EXHAUSTED');
  assert.equal(failed.control.failureCause.stage, 'source-headers');
  assert.equal(failed.control.failureCause.httpStatus, 503);
  assert.equal(Math.max(...counts.values()), 6);
  assert.equal(counts.size, 4);
  assert(
    delays.includes(2000) &&
      delays.includes(4000) &&
      delays.includes(8000) &&
      delays.includes(16000) &&
      delays.includes(32000),
  );
  // Only the selected poisoned project failed. The queued project's empty
  // verification window and ordinary serial publication now run normally.
  recover();
  for (let i = 0; f.pending().length; i++) {
    assert(i < 30);
    await f.execute();
  }
  const settled = (await f.current(state.id)).submission;
  assert.equal(settled.phase, 'terminal-failed');
  assert.equal(settled.error.code, 'SOURCE_RETRY_EXHAUSTED');
  assert.match(settled.error.message, /Last bounded cause:/);
  assertRetry(settled, state.operationId ?? state.id);
  assert(other, 'another project queued while all four poisoned slots remained reserved');
  const otherJob = await f.tx(
    'otherCompleted',
    { _handler: ctx => jobs.loadSourceJob(ctx, other.projectId, other.jobId) },
    {},
  );
  assert.equal(otherJob.status, 'completed');
  assert.equal([...f.tables.projectSourcePools.values()][0].active.length, 0);
  const snapshot = JSON.stringify(await load()),
    calls = f.metrics.convexSourceCalls.length;
  await f.tx('terminalReplay', store.dispatch, { projectId: f.projectId, jobId: step.jobId });
  assert.equal(JSON.stringify(await load()), snapshot);
  f.advanceClock(300000);
  await f.drain();
  assert.equal(f.metrics.convexSourceCalls.length, calls);
  t.diagnostic(
    JSON.stringify({ failures: [...counts.values()], delays, otherProjectCompleted: true, slots: 0 }),
  );
});
for (const running of [false, true])
  test(`compose watch-window exhaustion settles retained work, running=${running}`, async t => {
    const { f, state, step, load } = await fixture(t),
      original = await load();
    const watchdog = f.pending().find(x => x.name === 'projectHostedFinishDriver:drive');
    assert(watchdog);
    if (running) {
      const action = f.pending().find(x => x.name === 'projectConvexSourceTask:run');
      f.patch('_scheduled_functions', action._id, { state: { kind: 'inProgress' } });
    }
    f.advanceClock(HOSTED_FINISH_COMPOSE_WATCH_WINDOW_MS + 1);
    await f.execute(watchdog);
    assert.equal((await load()).control.failureCode, 'SOURCE_RETRY_EXHAUSTED');
    for (const key of ['id', 'executionId', 'attempt', 'fence'])
      assert.equal((await load())[key], original[key]);
    const settled = (await f.current(state.id)).submission;
    assert.equal(settled.phase, 'terminal-failed');
    assert.equal(settled.error.code, 'SOURCE_RETRY_EXHAUSTED');
    assertRetry(settled, state.id);
    if (running) {
      const action = [...f.tables._scheduled_functions.values()].find(
        x => x.name === 'projectConvexSourceTask:run' && x.state.kind === 'inProgress',
      );
      assert.equal(
        [...f.tables.projectSourcePools.values()][0].active.length,
        1,
        'a running computation retains its slot',
      );
      await f.execute(action);
    }
    await f.drain();
    assert.equal([...f.tables.projectSourcePools.values()][0].active.length, 0);
    assert.equal(f.pending().length, 0);
  });

test('the compose watch retains the latest recorded cause independently of pool order', async t => {
  const { f, state, step, load } = await fixture(t);
  const tasks = [...f.tables.projectSourceTasks.values()].filter(x => x.jobId === step.jobId);
  assert(tasks.length >= 2);
  const latest = {
    stage: 'source-body',
    exception: 'TimeoutError',
    code: 'ETIMEDOUT',
    elapsedMs: 123,
    httpStatus: null,
  };
  const older = { stage: 'source-head', exception: 'Error', code: null, elapsedMs: 45, httpStatus: 503 };
  f.patch('projectSourceTasks', tasks[0]._id, { lastFailure: latest, lastFailureAt: Date.now() });
  f.patch('projectSourceTasks', tasks[1]._id, { lastFailure: older, lastFailureAt: Date.now() - 100 });
  const watch = f.pending().find(x => x.name === 'projectHostedFinishDriver:drive');
  f.advanceClock(HOSTED_FINISH_COMPOSE_WATCH_WINDOW_MS + 1);
  await f.execute(watch);
  assert.deepEqual((await load()).control.failureCause, latest);
  const settled = (await f.current(state.id)).submission;
  assert(settled.error.message.includes(JSON.stringify(latest)));
  assertRetry(settled, state.id);
  await f.drain();
});

test('the compose watch preserves a terminal job cause while an older physical slot remains running', async t => {
  const { f, state, step, load } = await fixture(t);
  const action = f.pending().find(x => x.name === 'projectConvexSourceTask:run');
  const task = [...f.tables.projectSourceTasks.values()].find(
    x => x.jobId === step.jobId && x.index === action.args[0].index,
  );
  const cause = {
    stage: 'source-body',
    exception: 'TimeoutError',
    code: 'ETIMEDOUT',
    elapsedMs: 123,
    httpStatus: null,
  };
  const older = { stage: 'source-head', exception: 'Error', code: null, elapsedMs: 45, httpStatus: 503 };
  f.patch('_scheduled_functions', action._id, { state: { kind: 'inProgress' } });
  f.patch('projectSourceTasks', task._id, { lastFailure: older, lastFailureAt: Date.now() - 100 });
  const failure = await import(moduleUrl('../convex/projectConvexSourceFailure.ts'));
  await f.tx(
    'terminalSourceBeforeWatch',
    {
      _handler: ctx =>
        failure.exhaustSourceExecution(
          ctx,
          { projectId: f.projectId, jobId: step.jobId, step: step.step },
          cause,
        ),
    },
    {},
  );
  assert.deepEqual((await load()).control.failureCause, cause);
  const watch = f.pending().find(x => x.name === 'projectHostedFinishDriver:drive');
  f.advanceClock(HOSTED_FINISH_COMPOSE_WATCH_WINDOW_MS + 1);
  await f.execute(watch);
  const settled = (await f.current(state.id)).submission;
  assert(settled.error.message.includes(JSON.stringify(cause)));
  await f.execute(action);
  await f.drain();
  assert.equal([...f.tables.projectSourcePools.values()][0].active.length, 0);
});

test('a failure report lost after rescheduling is idempotent; successful progress resets only the failed quantum', async t => {
  const { f, step } = await fixture(t);
  const action = f.pending().find(x => x.name === 'projectConvexSourceTask:run');
  const initial = [...f.tables.projectSourceTasks.values()].find(
    x => x.jobId === step.jobId && x.index === action.args[0].index,
  );
  const taskInput = JSON.parse(initial.input);
  assert.equal(taskInput.kind, 'calculate');
  // A valid calculation window spanning two quanta exercises a real successful
  // continuation, rather than a terminal completion or a fabricated heartbeat.
  taskInput.requests.push(...structuredClone(taskInput.requests));
  await f.tx(
    'multiQuantumInput',
    { _handler: ctx => ctx.db.patch(initial._id, { input: JSON.stringify(taskInput) }) },
    {},
  );
  const recover = failingReads(t);
  await assert.rejects(f.execute(action), { name: 'SourceIoError' });
  const failed = [...f.tables.projectSourceTasks.values()].find(
    x => x.jobId === step.jobId && x.index === action.args[0].index,
  );
  const retry = f
    .pending()
    .find(x => x.name === action.name && x.args[0].jobId === step.jobId && x.args[0].index === failed.index);
  assert.equal(failed.failedAttempts, 1);
  assert.equal(failed.lastFailureAt, Date.now());
  const retained = JSON.stringify(failed);
  await f.tx('replayedFailureReport', fanout.failed, { ...action.args[0], cause: failed.lastFailure });
  assert.equal(JSON.stringify(f.tables.projectSourceTasks.get(failed._id)), retained);
  recover();
  await f.execute(retry);
  const advanced = f.tables.projectSourceTasks.get(failed._id);
  assert(
    advanced.generation > failed.generation,
    'the bounded calculation spans another successful continuation',
  );
  assert.equal(advanced.failedAttempts, undefined);
  assert.equal(advanced.failedGeneration, undefined);
  assert.equal(advanced.lastFailure, undefined);
  assert.equal(advanced.lastFailureAt, undefined);
  await f.drain();
  await f.passChecks();
  await f.drain();
});

test('a stopped sixth failure discovered by a pool drain cannot restore previously cancelled slots', async t => {
  const { f, step, load } = await fixture(t);
  const other = await queuedProject(f);
  const children = f.pending().filter(x => x.name === 'projectConvexSourceTask:run');
  assert.equal(children.length, 4);
  const stopped = children.at(-1),
    task = [...f.tables.projectSourceTasks.values()].find(
      x => x.jobId === step.jobId && x.index === stopped.args[0].index,
    );
  f.patch('_scheduled_functions', stopped._id, { state: { kind: 'failed' } });
  f.patch('projectSourceTasks', task._id, { failedAttempts: 5 });
  await f.tx('poolFindsSixthFailure', fanout.drain, {});
  assert.equal((await load()).control.failureCode, 'SOURCE_RETRY_EXHAUSTED');
  assert.equal(f.tables.projectSourceTasks.get(task._id).failedAttempts, 6);
  const active = [...f.tables.projectSourcePools.values()][0].active;
  assert(active.every(slot => f.tables.projectSourceTasks.get(slot.task ?? slot).jobId === other.jobId));
  await f.drain();
  const finished = await f.tx(
    'queuedProjectCompleted',
    { _handler: ctx => jobs.loadSourceJob(ctx, other.projectId, other.jobId) },
    {},
  );
  assert.equal(finished.status, 'completed');
  assert.equal([...f.tables.projectSourcePools.values()][0].active.length, 0);
});

test('serial source failures also stop at six attempts under the original finish watchdog', async t => {
  const { f, state, step, load } = await fixture(t, false),
    original = await load();
  const recover = failingReads(t);
  let firstArgs;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const action = f.pending().find(x => x.name === 'projectConvexSource:step');
    assert(action);
    firstArgs ??= action.args[0];
    await assert.rejects(f.execute(action), { name: 'SourceIoError' });
    const row = f.tables.projectSourceSteps.get(step._id);
    assert.equal(row.failedAttempts, attempt);
    if (attempt < 6) {
      await f.execute(f.pending().find(x => x.name === 'projectHostedFinishDriver:drive'));
      await f.execute(f.pending().find(x => x.name === 'projectConvexSource:dispatch'));
      const before = JSON.stringify(f.tables.projectSourceSteps.get(step._id));
      assert.equal(await f.tx('lateSerialBegin', store.begin, firstArgs), null);
      assert.equal(JSON.stringify(f.tables.projectSourceSteps.get(step._id)), before);
    }
  }
  recover();
  await f.drain();
  const failed = await load();
  assert.equal(failed.control.failureCode, 'SOURCE_RETRY_EXHAUSTED');
  for (const key of ['id', 'executionId', 'attempt', 'fence', 'inputDigest'])
    assert.equal(failed[key], original[key]);
  assert.equal(f.tables.projectSourceTasks.size, 0);
  const result = (await f.current(state.id)).submission;
  assert.equal(result.error.code, 'SOURCE_RETRY_EXHAUSTED');
  assertRetry(result, state.id);
  assert.equal(f.pending().length, 0);
});

for (const delivery of ['begin', 'complete'])
  test(`watch cutoff retires the old physical run after lease repair, ${delivery}`, async t => {
    const { f, step } = await fixture(t);
    const { requeueSourceBatch } = await import(moduleUrl('../convex/projectConvexSourcePool.ts'));
    const { exhaustSourceExecution } = await import(moduleUrl('../convex/projectConvexSourceFailure.ts'));
    const action = f.pending().find(x => x.name === 'projectConvexSourceTask:run');
    f.patch('_scheduled_functions', action._id, { state: { kind: 'inProgress' } });
    const batch = f.tables.projectSourceBatches.get(step.batchId);
    await f.tx('leaseRepairWithRunningOldAction', { _handler: ctx => requeueSourceBatch(ctx, batch) }, {});
    const task = [...f.tables.projectSourceTasks.values()].find(
      x => x.jobId === step.jobId && x.index === action.args[0].index,
    );
    assert(task.generation > action.args[0].generation);
    await f.tx('cutoffAfterRepair', { _handler: ctx => exhaustSourceExecution(ctx, step) }, {});
    assert.equal([...f.tables.projectSourcePools.values()][0].active.length, 1);
    await f.tx(
      'oldPhysicalRunStops',
      fanout[delivery],
      delivery === 'begin'
        ? action.args[0]
        : { ...action.args[0], done: true, progress: null, output: null, failure: null },
    );
    f.patch('_scheduled_functions', action._id, { state: { kind: 'success' } });
    assert.equal([...f.tables.projectSourcePools.values()][0].active.length, 0);
    await f.drain();
    assert.equal(f.pending().length, 0);
  });

test('a terminal old reply cannot release a physically running replacement', async t => {
  const { f, step } = await fixture(t);
  const { exhaustSourceExecution } = await import(moduleUrl('../convex/projectConvexSourceFailure.ts'));
  const original = f.pending().find(x => x.name === 'projectConvexSourceTask:run');
  const recover = failingReads(t);
  await assert.rejects(f.execute(original), { name: 'SourceIoError' });
  recover();
  const replacement = f
    .pending()
    .find(x => x.name === original.name && x.args[0].index === original.args[0].index);
  f.patch('_scheduled_functions', replacement._id, { state: { kind: 'inProgress' } });
  await f.tx('exhaustWithReplacementRunning', { _handler: ctx => exhaustSourceExecution(ctx, step) }, {});
  assert.equal([...f.tables.projectSourcePools.values()][0].active.length, 1);
  const finish = action =>
    f.tx('lateTerminalReply', fanout.complete, {
      ...action.args[0],
      done: true,
      progress: null,
      output: null,
      failure: null,
    });
  await finish(original);
  assert.equal([...f.tables.projectSourcePools.values()][0].active.length, 1);
  await finish(replacement);
  f.patch('_scheduled_functions', replacement._id, { state: { kind: 'success' } });
  assert.equal([...f.tables.projectSourcePools.values()][0].active.length, 0);
  await f.drain();
});

test('the watch settles a reserved source job before any provider step exists', async t => {
  // Reuse setup from the normal fixture, but stop its explicit pending dispatch
  // before it starts the retained source execution.
  for (const [key, value] of Object.entries({
    FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
    FORGE_SOURCE_PROVIDER: 'convex',
    R2_ACCOUNT_ID: 'synthetic',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
  })) {
    const prior = process.env[key];
    process.env[key] = value;
    t.after(() => (prior === undefined ? delete process.env[key] : (process.env[key] = prior)));
  }
  const f = await finishFixture(t),
    state = await f.enqueue(f.request());
  await f.drain();
  f.moveMain();
  await f.passChecks();
  for (let i = 0; !f.pending().some(x => x.name === 'projectConvexSource:dispatch'); i++) {
    assert(i < 30);
    await f.execute();
  }
  const dispatch = f.pending().find(x => x.name === 'projectConvexSource:dispatch'),
    jobId = dispatch.args[0].jobId;
  assert.equal(f.tables.projectSourceSteps.size, 0);
  f.advanceClock(HOSTED_FINISH_COMPOSE_WATCH_WINDOW_MS + 1);
  await f.execute(f.pending().find(x => x.name === 'projectHostedFinishDriver:drive'));
  await f.drain();
  const job = await f.tx(
    'reservedJobTerminal',
    { _handler: ctx => jobs.loadSourceJob(ctx, f.projectId, jobId) },
    {},
  );
  assert.equal(job.status, 'failed');
  assert.equal(job.control.failureCode, 'SOURCE_RETRY_EXHAUSTED');
  assert.equal(job.executionId, null);
  assert.equal(
    f.tables.projectSourceSteps.size,
    0,
    'a late dispatch cannot create an execution after cutoff',
  );
  assert.equal((await f.current(state.id)).submission.error.code, 'SOURCE_RETRY_EXHAUSTED');
  assert.equal(f.pending().length, 0);
});
