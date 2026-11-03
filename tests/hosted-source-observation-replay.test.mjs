// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { waitHostedAgentSource } from '../dist/hosted-agent-source-wait.js';
const jobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));
const progress = await import(moduleUrl('../convex/projectSourceProgress.ts'));
const store = await import(moduleUrl('../convex/projectConvexSourceStore.ts'));
const synthetic = {
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_SOURCE_PROVIDER: 'convex',
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'synthetic',
  R2_ACCESS_KEY_ID: 'synthetic',
  R2_SECRET_ACCESS_KEY: 'synthetic',
};

test('three 60 s source observation windows replay one progressing execution without new batches or sibling work', async t => {
  for (const [key, value] of Object.entries(synthetic)) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => (old === undefined ? delete process.env[key] : (process.env[key] = old)));
  }
  const begins = [],
    middle = 'unchanged '.repeat(14000) + '\n',
    files = text => Array.from({ length: 1000 }, (_, i) => [`file-${String(i).padStart(4, '0')}.txt`, text]);
  const f = await finishFixture(t, {
    baselineFiles: files('start\n' + middle + 'end\n'),
    selectedFiles: files('ours\n' + middle + 'end\n'),
    mainFiles: files('start\n' + middle + 'theirs\n'),
    beforeSourceMutation(name, args) {
      if (name === 'projectConvexSourceFanout:begin') begins.push(structuredClone(args));
    },
  });
  const request = f.request(),
    state = await f.enqueue(request);
  await f.drain();
  f.moveMain();
  await f.passChecks();
  for (let i = 0; !f.pending().some(x => x.name === 'projectConvexSourceTask:run'); i++) {
    assert(i < 30);
    await f.execute();
  }
  const step = [...f.tables.projectSourceSteps.values()][0],
    load = () =>
      f.tx('windowLoad', { _handler: ctx => jobs.loadSourceJob(ctx, f.projectId, step.jobId) }, {}),
    snapshot = () =>
      f.tx('windowProgress', { _handler: ctx => progress.sourceProgress(ctx, f.projectId, step.jobId) }, {}),
    original = await load();
  // A completed sibling must survive both a transient failure and client replay.
  while (![...f.tables.projectSourceTasks.values()].some(x => x.status === 'done'))
    await f.execute(f.pending().find(x => x.name === 'projectConvexSourceTask:run'));
  const sibling = [...f.tables.projectSourceTasks.values()].find(x => x.status === 'done'),
    retainedSibling = JSON.stringify(sibling),
    beginCount = begins.length;
  const fetch = globalThis.fetch;
  let fail = true;
  t.mock.method(globalThis, 'fetch', (url, init) => {
    if (fail && (!init?.method || init.method === 'GET')) {
      fail = false;
      throw new DOMException('synthetic reset', 'TimeoutError');
    }
    return fetch(url, init);
  });
  const failed = f.pending().find(x => x.name === 'projectConvexSourceTask:run');
  await assert.rejects(f.execute(failed), { name: 'SourceIoError' });
  const failedTask = [...f.tables.projectSourceTasks.values()].find(
    x =>
      x.jobId === failed.args[0].jobId && x.step === failed.args[0].step && x.index === failed.args[0].index,
  );
  assert.equal(failedTask.failedAttempts, 1);

  let observationMs = 0,
    subscriptions = 0,
    closes = 0,
    unsubscribes = 0;
  t.mock.method(performance, 'now', () => observationMs);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const windows = [];
  for (let window = 0; window < 3; window++) {
    const beforeBatches = [...f.tables.projectSourceBatches.keys()],
      beforeStep = f.tables.projectSourceSteps.get(step._id).step;
    const replay = await f.enqueue(request);
    assert.equal(replay.id, state.id);
    await f.tx('windowReconcile', store.dispatch, { projectId: f.projectId, jobId: step.jobId });
    assert.deepEqual([...f.tables.projectSourceBatches.keys()], beforeBatches, 'replay allocates no batches');
    assert.equal(f.tables.projectSourceSteps.get(step._id).step, beforeStep, 'replay does no source quantum');
    let update;
    const waiting = waitHostedAgentSource(
      { url: 'https://fixture.invalid', projectId: f.projectId },
      original.operationId,
      await snapshot(),
      undefined,
      () => ({
        onUpdate(_ref, args, callback) {
          assert.equal(args.operationId, original.operationId);
          subscriptions++;
          update = callback;
          return () => unsubscribes++;
        },
        async close() {
          closes++;
        },
      }),
    );
    const heartbeat = (await load()).control.heartbeat;
    for (let pulse = 0; pulse < 3; pulse++) {
      const next = f.pending().find(x => /^projectConvexSource(?:Node|Task)?:/.test(x.name));
      assert(next, 'source keeps progressing through the observation window');
      await f.execute(next);
      update(await snapshot());
      f.advanceClock(20000);
      observationMs += 20000;
      t.mock.timers.tick(20000);
      await new Promise(resolve => setImmediate(resolve));
    }
    const observed = await waiting,
      job = await load();
    assert.equal(observed.status, 'submitted');
    assert.equal(observed.jobId, original.id);
    assert(job.control.heartbeat > heartbeat, 'each window advances server progress');
    for (const key of ['id', 'executionId', 'attempt', 'fence', 'inputDigest'])
      assert.equal(job[key], original[key]);
    assert.equal(f.tables.projectSourceSteps.size, 1);
    assert.equal(JSON.stringify(f.tables.projectSourceTasks.get(sibling._id)), retainedSibling);
    assert(
      !begins
        .slice(beginCount)
        .some(
          args => args.jobId === sibling.jobId && args.step === sibling.step && args.index === sibling.index,
        ),
      'completed sibling is never read or executed again',
    );
    windows.push({ observationMs, heartbeat: job.control.heartbeat, phase: observed.source.phase });
  }
  t.mock.timers.reset();
  t.mock.method(performance, 'now', () => observationMs);
  await f.drain();
  const terminalJob = await load();
  assert.equal(terminalJob.status, 'completed');
  assert.equal(f.tables.projectSourceSteps.size, 1);
  const repairedTask = f.tables.projectSourceTasks.get(failedTask._id);
  assert.equal(repairedTask.status, 'done');
  assert.equal(repairedTask.failure, null);
  assert.equal(repairedTask.failedAttempts, 1, 'terminal completion retains the existing failure accounting');
  assert.equal(JSON.stringify(f.tables.projectSourceTasks.get(sibling._id)), retainedSibling);
  await f.passChecks();
  await f.drain();
  const terminal = (await f.current(state.id)).submission;
  assert.equal(terminal.phase, 'landed');
  const batches = [...f.tables.projectSourceBatches.keys()],
    sourceCalls = f.metrics.convexSourceCalls.length;
  await f.enqueue(request);
  assert.deepEqual((await f.current(state.id)).submission, terminal);
  assert.deepEqual(await load(), terminalJob, 'terminal source receipt is immutable');
  assert.deepEqual([...f.tables.projectSourceBatches.keys()], batches);
  assert.equal(f.metrics.convexSourceCalls.length, sourceCalls);
  assert.equal(f.metrics.convexStorageCalls, 0);
  assert.deepEqual([subscriptions, unsubscribes, closes], [3, 3, 3]);
  t.diagnostic(JSON.stringify({ windows, jobs: 1, executions: 1, transientFailures: 1, replayBatches: 0 }));
});
