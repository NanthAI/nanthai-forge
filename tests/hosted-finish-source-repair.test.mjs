// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { HOSTED_FINISH_COMPOSE_WATCHDOG_MS } from '../dist/hosted-finish.js';
const fanout = await import(moduleUrl('../convex/projectConvexSourceFanout.ts'));
const jobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));
const synthetic = {
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_SOURCE_PROVIDER: 'convex',
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'synthetic',
  R2_ACCESS_KEY_ID: 'synthetic',
  R2_SECRET_ACCESS_KEY: 'synthetic',
};
for (const fenced of [false, true]) {
  test(`all four failed child slots recover on the 120 s server watchdog, fenced=${fenced}`, async t => {
    for (const [key, value] of Object.entries(synthetic)) {
      const old = process.env[key];
      process.env[key] = value;
      t.after(() => (old === undefined ? delete process.env[key] : (process.env[key] = old)));
    }
    const middle = 'unchanged '.repeat(14000) + '\n';
    const files = text =>
      Array.from({ length: 200 }, (_, i) => [`file-${String(i).padStart(4, '0')}.txt`, text]);
    const f = await finishFixture(t, {
      baselineFiles: files('start\n' + middle + 'end\n'),
      selectedFiles: files('ours\n' + middle + 'end\n'),
      mainFiles: files('start\n' + middle + 'theirs\n'),
    });
    const state = await f.enqueue(f.request());
    await f.drain();
    f.moveMain();
    await f.passChecks();
    let steps = 0;
    while (!f.pending().some(x => x.name === 'projectConvexSourceTask:run')) {
      assert(++steps < 30);
      await f.execute();
    }
    const first = f.pending().find(x => x.name === 'projectConvexSourceTask:run');
    // A child can span several bounded generations before its durable output.
    do {
      await f.execute(
        f.pending().find(x => x.name === first.name && x.args[0].index === first.args[0].index),
      );
    } while (![...f.tables.projectSourceTasks.values()].some(x => x.status === 'done'));
    const completedTask = [...f.tables.projectSourceTasks.values()].find(x => x.status === 'done');
    assert(completedTask?.output);
    const retained = JSON.stringify(completedTask);
    const childTasks = f.pending().filter(x => x.name === 'projectConvexSourceTask:run');
    assert.equal(childTasks.length, 4);
    const step = [...f.tables.projectSourceSteps.values()][0];
    const job = await f.tx(
      'repairJob',
      { _handler: ctx => jobs.loadSourceJob(ctx, f.projectId, step.jobId) },
      {},
    );
    const originalFetch = globalThis.fetch;
    let failing = true;
    t.mock.method(globalThis, 'fetch', (url, init) => {
      if (failing && (!init?.method || init.method === 'GET'))
        throw new DOMException('synthetic timeout', 'TimeoutError');
      return originalFetch(url, init);
    });
    for (const child of childTasks) await assert.rejects(f.execute(child), { name: 'SourceIoError' });
    failing = false;
    assert.equal(JSON.stringify(f.tables.projectSourceTasks.get(completedTask._id)), retained);
    assert([...f.tables.projectSourceBatches.values()].every(x => x.failure === null));
    assert.equal(
      f.pending().filter(x => x.name === 'projectConvexSourceTask:run').length,
      4,
      'failed quanta own delayed replacement actions',
    );
    assert.equal([...f.tables.projectSourcePools.values()][0].active.length, 4);
    const watchdog = f.pending().find(x => x.name === 'projectHostedFinishDriver:drive');
    assert(watchdog);
    assert.equal(HOSTED_FINISH_COMPOSE_WATCHDOG_MS, 120000);
    if (fenced) {
      f.advanceClock(61000);
      for (const retry of f.pending().filter(x => x.name === 'projectConvexSourceTask:run'))
        await f.execute(retry);
      await f.tx('otherProjectCompletionDrain', fanout.drain, {});
      assert.equal(f.tables.projectSourceBatches.get(completedTask.batchId).status, 'fenced');
    }
    // No client resume/replay call: the admitted finish already owns this wake.
    await f.execute(watchdog);
    const dispatch = f.pending().find(x => x.name === 'projectConvexSource:dispatch');
    assert(dispatch);
    await f.execute(dispatch);
    const liveBatch = JSON.stringify(f.tables.projectSourceBatches.get(completedTask.batchId));
    for (const child of childTasks) {
      const retry = f.pending().find(x => x.name === child.name && x.args[0].index === child.args[0].index);
      assert(retry && retry.args[0].generation > child.args[0].generation);
      await f.tx('lateMutationReplyDuringRepair', fanout.complete, {
        ...child.args[0],
        done: true,
        progress: null,
        output: null,
        failure: 'SOURCE_HASH_MISMATCH',
      });
    }
    assert.equal(JSON.stringify(f.tables.projectSourceBatches.get(completedTask.batchId)), liveBatch);
    assert.equal([...f.tables.projectSourcePools.values()][0].active.length, 4);
    await f.drain();
    assert.equal(JSON.stringify(f.tables.projectSourceTasks.get(completedTask._id)), retained);
    const renewed = await f.tx(
      'repairedJob',
      { _handler: ctx => jobs.loadSourceJob(ctx, f.projectId, step.jobId) },
      {},
    );
    assert.equal(renewed.status, 'completed');
    for (const key of ['id', 'executionId', 'attempt', 'fence']) assert.equal(renewed[key], job[key]);
    assert.equal(f.tables.projectSourceSteps.size, 1);
    const batch = f.tables.projectSourceBatches.get(completedTask.batchId);
    assert.equal(batch.completed, batch.total);
    assert.equal(batch.status, 'done');
    const joins = [...f.tables._scheduled_functions.values()].filter(
      x =>
        x.name === 'projectConvexSourceNode:step' &&
        x.args[0].step === step.step &&
        x.args[0].jobId === step.jobId,
    );
    assert.equal(joins.length, 1, 'one join');
    // Old generations cannot overwrite an outcome or schedule another join.
    for (const child of childTasks) {
      await f.tx('lateChildReply', fanout.complete, {
        ...child.args[0],
        done: true,
        progress: null,
        output: null,
        failure: 'SOURCE_HASH_MISMATCH',
      });
    }
    await f.passChecks();
    await f.drain();
    assert.equal((await f.current(state.id)).submission.phase, 'landed');
    assert.equal(f.tables.projectHostedCheckRuns.size, 2, 'original check plus exactly one recomposed check');
    assert.equal(f.tables.projectHostedAcceptances.size, 1);
    assert.equal(f.pending().length, 0);
    assert.equal([...f.tables.projectSourcePools.values()][0].active.length, 0);
    const before = f.metrics.convexSourceCalls.length;
    f.advanceClock(120000);
    await f.drain();
    assert.equal(f.metrics.convexSourceCalls.length, before, 'idle is zero');
    t.diagnostic(
      JSON.stringify({
        fenced,
        children: batch.total,
        successfulSiblingRetained: true,
        execution: renewed.executionId,
        watchdogMs: HOSTED_FINISH_COMPOSE_WATCHDOG_MS,
        sourceCalls: before,
      }),
    );
  });
}
