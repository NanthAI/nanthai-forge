// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const jobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));
const store = await import(moduleUrl('../convex/projectConvexSourceStore.ts'));
const fanout = await import(moduleUrl('../convex/projectConvexSourceFanout.ts'));
const pool = await import(moduleUrl('../convex/projectConvexSourcePool.ts'));

async function fixture(t, shape = 'terminal') {
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
  // Distinct per-file bodies keep a later calculation round above the inline bound, so it
  // still forks real children ('fork'); identical bodies would share three small blobs.
  const middle = i =>
    shape === 'fork'
      ? `unchanged ${i} `.repeat(10000) + '\n'
      : shape === 'children'
        ? 'unchanged '.repeat(14000) + '\n'
        : 'same\n';
  const files = text =>
    Array.from({ length: shape === 'serial' ? 12000 : 120 }, (_, i) => [
      `file-${String(i).padStart(5, '0')}.txt`,
      text(middle(i)),
    ]);
  let boundary = () => {};
  const f = await finishFixture(t, {
    ...(shape === 'terminal'
      ? {}
      : {
          baselineFiles: files(middle => 'start\n' + middle + 'end\n'),
          selectedFiles: files(middle => 'ours\n' + middle + 'end\n'),
          mainFiles: files(middle => 'start\n' + middle + 'theirs\n'),
        }),
    beforeSourceMutation: (name, args) => boundary(name, args),
  });

  const state = await f.enqueue(f.request());
  await f.drain();
  f.moveMain();
  await f.passChecks();
  const target =
    shape === 'children' || shape === 'fork' ? 'projectConvexSourceTask:run' : 'projectConvexSource:step';
  for (let i = 0; !f.pending().some(x => x.name === target); i++) {
    assert(i < 30);
    await f.execute();
  }
  const row = [...f.tables.projectSourceSteps.values()][0];
  const load = () =>
    f.tx('deadlineReadJob', { _handler: ctx => jobs.loadSourceJob(ctx, f.projectId, row.jobId) }, {});
  return { f, state, row, load, boundary: fn => (boundary = fn) };
}

async function nearDeadline(x) {
  const original = await x.load(),
    deadline = original.control.retryUntil;
  assert(Number.isFinite(deadline), 'use the actual retained compose deadline');
  x.f.advanceClock(deadline - Date.now() - 1);
  // Supported repair renews the same execution, without editing its deadline,
  // pins or lease by hand. The action begins one millisecond before cutoff.
  await x.f.tx('deadlineRenew', store.dispatch, { projectId: x.f.projectId, jobId: x.row.jobId });
  assert.equal((await x.load()).control.retryUntil, deadline);
  return { original, deadline };
}

function assertPins(job, original) {
  for (const key of ['id', 'executionId', 'attempt', 'fence', 'inputDigest'])
    assert.equal(job[key], original[key]);
  assert.deepEqual(job.input, original.input);
  assert.equal(job.control.retryUntil, original.control.retryUntil);
}

for (const watchdogFirst of [false, true])
  test(`terminal source success crosses cutoff; watchdog first=${watchdogFirst}`, async t => {
    const x = await fixture(t),
      { f, state, row, load } = x;
    const { original, deadline } = await nearDeadline(x);
    const watch = f.pending().find(x => x.name === 'projectHostedFinishDriver:drive');
    let commits = 0,
      watchedJob;
    x.boundary(async (name, args) => {
      if (name !== 'projectConvexSourceStore:commit') return;
      assert(args.output, 'the real Node wrapper computed the whole-job result');
      assert.equal(args.failure, null);
      assert.equal(Date.now(), deadline - 1);
      f.advanceClock(2);
      commits++;
      if (watchdogFirst) {
        await f.execute(watch);
        watchedJob = JSON.stringify(await load());
      }
    });
    await f.execute(f.pending().find(x => x.name === 'projectConvexSource:step'));
    assert.equal(commits, 1);
    assertPins(await load(), original);
    if (watchdogFirst) {
      assert.equal((await load()).control.failureCode, 'SOURCE_RETRY_EXHAUSTED');
      assert.equal(JSON.stringify(await load()), watchedJob, 'late real success is fenced');
    } else {
      assert.equal((await load()).status, 'completed');
      // Publish the winning terminal result before delivering the delayed watch.
      await f.execute(f.pending().find(x => /^projectHostedComposeJobs:(complete|publish)$/.test(x.name)));
      await f.execute(watch);
    }
    await f.drain();
    await f.passChecks();
    await f.drain();
    const settled = (await f.current(state.id)).submission;
    assert.equal(settled.phase, watchdogFirst ? 'terminal-failed' : 'landed');
    if (watchdogFirst) assert.equal(settled.error.code, 'SOURCE_RETRY_EXHAUSTED');
    assert.equal(f.tables.projectSourceSteps.size, 1);
    assert.equal(f.pending().length, 0);
    assert.equal([...f.tables.projectSourceSteps.values()][0].jobId, row.jobId);
  });

for (const shape of ['serial', 'fork', 'child-continue', 'child-join'])
  test(`post-deadline ${shape} success settles without scheduling new work`, async t => {
    const x = await fixture(t, shape.startsWith('child') ? 'children' : shape),
      { f, state, row, load } = x;
    let action, runningSibling;
    if (shape === 'fork') {
      // The initial serial action already forked. Finish its children and use
      // the next real fork (calculation) as the scheduling boundary instead.
      while (!f.pending().some(x => x.name === 'projectConvexSourceNode:step'))
        await f.execute(f.pending().find(x => x.name === 'projectConvexSourceTask:run'));
      action = f.pending().find(x => x.name === 'projectConvexSourceNode:step');
    } else if (shape.startsWith('child')) {
      action = f.pending().find(x => x.name === 'projectConvexSourceTask:run');
      const task = [...f.tables.projectSourceTasks.values()].find(
        x => x.jobId === row.jobId && x.index === action.args[0].index,
      );
      if (shape === 'child-continue') {
        const input = JSON.parse(task.input);
        assert.equal(input.kind, 'calculate');
        input.requests.push(...structuredClone(input.requests));
        f.patch('projectSourceTasks', task._id, { input: JSON.stringify(input) });
        runningSibling = f.pending().find(x => x.name === action.name && x._id !== action._id);
        assert(runningSibling);
        f.patch('_scheduled_functions', runningSibling._id, { state: { kind: 'inProgress' } });
      } else {
        for (let i = 0; ; i++) {
          assert(i < 30);
          const sibling = f.pending().find(x => x.name === action.name && x._id !== action._id);
          if (!sibling) break;
          await f.execute(sibling);
        }
        const batch = f.tables.projectSourceBatches.get(task.batchId);
        assert.equal(batch.completed, batch.total - 1, 'this completion would schedule the parent join');
      }
    } else action = f.pending().find(x => x.name === 'projectConvexSource:step');
    const { original, deadline } = await nearDeadline(x);
    const retained = f.tables.projectSourceSteps.get(row._id);
    const cause = {
      stage: 'source-body',
      exception: 'TimeoutError',
      code: 'ETIMEDOUT',
      elapsedMs: 2,
      httpStatus: null,
    };
    f.patch('projectSourceSteps', row._id, { lastFailure: cause });
    const heartbeat = (await load()).control.heartbeat;
    let commits = 0,
      scheduled;
    x.boundary((name, args) => {
      const expected =
        shape === 'serial'
          ? 'projectConvexSourceStore:commit'
          : shape === 'fork'
            ? 'projectConvexSourceFanout:fork'
            : 'projectConvexSourceFanout:complete';
      if (name !== expected) return;
      assert.equal(Date.now(), deadline - 1, 'real action began before cutoff');
      if (shape === 'serial') {
        assert.equal(args.output, null);
        assert.equal(args.failure, null);
        assert(args.cursor);
      } else if (shape === 'fork') assert(args.tasks.length > 0);
      else {
        assert.equal(args.failure, null);
        assert.equal(args.done, shape === 'child-join');
      }
      scheduled = new Set(f.tables._scheduled_functions.keys());
      f.advanceClock(2);
      commits++;
    });
    await f.execute(action);
    assert.equal(commits, 1, 'the expected real success reducer was reached');
    const failed = await load();
    assert.equal(failed.control.failureCode, 'SOURCE_RETRY_EXHAUSTED');
    assert.deepEqual(failed.control.failureCause, cause);
    assertPins(failed, original);
    assert.equal(failed.control.heartbeat, heartbeat);
    assert.equal(f.tables.projectSourceSteps.get(row._id).step, retained.step);
    const newSource = [...f.tables._scheduled_functions.values()].filter(
      x => !scheduled.has(x._id) && /projectConvexSource(?:Node|Task)?:/.test(x.name),
    );
    assert.deepEqual(newSource, [], 'no new quantum, child or join was scheduled');
    if (runningSibling) {
      assert.equal(
        [...f.tables.projectSourcePools.values()][0].active.length,
        1,
        'the other physical run retains its slot',
      );
      await f.execute(runningSibling);
      assert.equal(
        [...f.tables.projectSourcePools.values()][0].active.length,
        0,
        'its fenced reply retires the physical slot',
      );
    }
    await f.drain();
    assert.equal((await f.current(state.id)).submission.error.code, 'SOURCE_RETRY_EXHAUSTED');
    assert.equal([...f.tables.projectSourcePools.values()][0]?.active.length ?? 0, 0);
    assert.equal(f.pending().length, 0, 'settlement retained a wake and drained completely');
  });

test('an unrelated pool drain cannot schedule queued work after its retained deadline', async t => {
  const x = await fixture(t, 'children'),
    { f, state, row, load } = x;
  const { original } = await nearDeadline(x);
  const batch = f.tables.projectSourceBatches.get(f.tables.projectSourceSteps.get(row._id).batchId);
  // The supported batch repair cancels pending deliveries and retains unfinished
  // input/progress. A later unrelated drain must not start this queued batch.
  await f.tx('deadlineRequeue', { _handler: ctx => pool.requeueSourceBatch(ctx, batch) }, {});
  assert.equal([...f.tables.projectSourcePools.values()][0].active.length, 0);
  assert.equal(f.tables.projectSourceBatches.get(batch._id).status, 'queued');
  const scheduled = new Set(f.tables._scheduled_functions.keys());
  f.advanceClock(2);
  await f.tx('unrelatedDeadlineDrain', fanout.drain, {});
  const failed = await load();
  assert.equal(failed.control.failureCode, 'SOURCE_RETRY_EXHAUSTED');
  assertPins(failed, original);
  assert.deepEqual(
    [...f.tables._scheduled_functions.values()].filter(
      x => !scheduled.has(x._id) && x.name === 'projectConvexSourceTask:run',
    ),
    [],
  );
  await f.drain();
  assert.equal((await f.current(state.id)).submission.error.code, 'SOURCE_RETRY_EXHAUSTED');
  assert.equal([...f.tables.projectSourcePools.values()][0].active.length, 0);
  assert.equal(f.pending().length, 0);
});
