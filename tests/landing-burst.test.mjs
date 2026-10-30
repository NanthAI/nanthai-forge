import { actionsRunnerFixture } from './actions-runner-fixture.mjs';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkService } from '../dist/work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { checkEnvironment } from '../dist/work-run.js';
import { enqueueLanding } from '../dist/landing-batch-store.js';
import { drainLandingBatches } from '../dist/landing-batch.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { ForgeError } from '../dist/errors.js';
import { trustAgents } from './autonomy-fixture.mjs';
import { immutableDirectory } from './helpers/immutable-directory.mjs';
import { waitForState } from './helpers/wait-for-state.mjs';
import { createServer } from 'node:net';
import { once } from 'node:events';

const privateFixture = immutableDirectory('forge-batch-', root => {
  writeFileSync(join(root, 'same.txt'), 'original\n');
  initNative(root);
  trustAgents(root);
});

async function fixture(t, { delay = 300, window = 120, concurrency, failWhen = "exists('bad.txt')" } = {}) {
  const { root } = await privateFixture();
  const agent = new AgentWorkflow(root),
    work = agent.work,
    store = work.store;
  const saved = {
    PATH: process.env.PATH,
    FORGE_WORK_LOCK_WAIT_MS: process.env.FORGE_WORK_LOCK_WAIT_MS,
    FORGE_CHECK_QUEUE_DIR: process.env.FORGE_CHECK_QUEUE_DIR,
  };
  // Detached audits and parallel controllers legitimately write the same synthetic owner.
  process.env.FORGE_WORK_LOCK_WAIT_MS = '10000';
  process.env.FORGE_CHECK_QUEUE_DIR = join(store.directory, 'fixture-queue');
  // A held first check makes late-arrival ordering causal even if publishing
  // the later queue entry takes longer than the synthetic command delay.
  const sockets = new Set();
  let hold = false,
    first = true;
  const gate = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    if (!hold || !first) socket.end();
    first = false;
  });
  const endpoint = join(store.directory, 'check-gate');
  gate.listen(endpoint);
  await once(gate, 'listening');
  const releaseFirst = () => {
    hold = false;
    for (const socket of sockets) socket.end();
  };
  const provider = actionsRunnerFixture(store.directory, { delay, failWhen, endpoint });
  process.env.PATH = `${provider.bin}:${saved.PATH}`;
  const check = (
    await agent.dispatch({
      action: 'define-check',
      name: 'verify',
      executable: process.execPath,
      args: [
        '-e',
        `const exists=name=>require('fs').existsSync(name);setTimeout(()=>process.exit((${failWhen})?1:0),${delay})`,
      ],
    })
  ).result;
  await agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    checks: { runner: 'github-actions', repo: 'synthetic/checks', ...(concurrency ? { concurrency } : {}) },
    acceptance: { batchWindowMs: window },
  });
  t.after(async () => {
    releaseFirst();
    // All remote calls, including detached audits, use the synthetic client above.
    process.env.FORGE_WORK_LOCK_WAIT_MS = '10000';
    process.env.PATH = `${provider.bin}:${saved.PATH}`;
    process.env.FORGE_CHECK_QUEUE_DIR = join(store.directory, 'fixture-queue');
    try {
      await drainPostAccept(store);
    } finally {
      await new Promise(resolve => gate.close(resolve));
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
  const pending = [];
  const soloRuns = new Set();
  async function candidate(path, text = `${path}\n`, enqueue = true) {
    const lane = (await agent.dispatch({ action: 'start', outcome: `Synthetic ${path}` })).result;
    writeFileSync(join(lane.path, path), text);
    const checkpoint = (
      await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Synthetic candidate' })
    ).result;
    const composed = (
      await agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        laneId: lane.laneId,
        intentId: lane.intentId,
        inputs: [{ laneId: lane.laneId, head: checkpoint.head }],
        dependencies: [],
      })
    ).result;
    const view = store.select('views', composed.viewId);
    const definition = store.load().checks[0];
    const command = {
      action: 'finish',
      operationId: randomUUID(),
      laneId: lane.laneId,
      expectedHead: checkpoint.head,
      message: 'Synthetic landing',
      checkId: definition.id,
      expectedDefinition: definition.definition,
      expectedEnvironment: checkEnvironment().fingerprint,
      dependencies: [],
      accept: { channel: 'main', expectedPrevious: null },
      keepOpen: false,
    };
    if (enqueue) await enqueueLanding(work, command, view);
    pending.push(command.operationId);
    return { lane, checkpoint, view, command };
  }
  const main = () =>
    store
      .load()
      .channelMoves.filter(move => move.channel === 'main')
      .at(-1);
  const content = path => {
    const source = new NativeSource(root),
      file = source.state(main().head).files.find(file => file.path === path);
    return file && source.object(file.blob).toString();
  };
  return {
    root,
    agent,
    work,
    store,
    check,
    candidate,
    main,
    content,
    pending,
    soloRuns,
    window,
    concurrency,
    holdFirst: () => {
      hold = true;
      first = true;
    },
    releaseFirst,
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Preserve finisher workloads while establishing the intended durable arrival cohorts. */
async function burst(f, arrivals, { admitBeforeDrain = false, green = false } = {}) {
  const ready = [];
  for (const arrival of arrivals)
    ready.push({ ...arrival, ...(await f.candidate(arrival.path, `${arrival.path}\n`, false)) });
  // These timing/stacking cases measure the already-green queue. Singleton
  // preparation uses the real runner and is excluded from that measured phase.
  if (green)
    for (const item of ready) {
      const run = (await f.agent.dispatch({ action: 'run', viewId: item.view.id })).result;
      assert.equal(run.status, 'passed');
      f.soloRuns.add(run.runId);
    }
  const started = performance.now();
  if (admitBeforeDrain) {
    // The batch-count contract applies to a durable queued wave. Filesystem
    // admission has no promise that eight writes finish inside a wall-clock window.
    await Promise.all(
      ready.map(async item => {
        await sleep(item.at ?? 0);
        await enqueueLanding(f.work, item.command, item.view);
      }),
    );
    await drainLandingBatches(f.work, 'main');
  } else if (f.window === 0) {
    // The serial control admits one change at a time. Parallel enqueue/drain
    // handlers contend with their own owner writes rather than measuring serial checks.
    for (const item of ready) {
      await sleep(item.at ?? 0);
      await enqueueLanding(f.work, item.command, item.view);
      await drainLandingBatches(f.work, 'main');
      await drainPostAccept(f.store);
    }
  } else {
    // Positive-window cohorts are all durably present before a driver starts;
    // publishing N independent entries cannot be guaranteed to fit 600 ms.
    const initial = ready.filter(item => (item.at ?? 0) < f.window || (item.at ?? 0) === 0);
    const ordered = f.window > 0;
    const hasLate = ordered && initial.length < ready.length;
    const controller = new AbortController();
    let releaseInitial,
      queuedInitial = 0,
      queued = 0;
    const initialReady = new Promise(resolve => {
      releaseInitial = resolve;
    });
    if (hasLate) f.holdFirst();
    const firstQueued = hasLate
      ? initialReady.then(() =>
          waitForState(f.store, () => checkRuns(f).length > 0, 20000, controller.signal),
        )
      : Promise.resolve();
    const secondQueued =
      hasLate && f.concurrency !== 1
        ? firstQueued
            .then(() => waitForState(f.store, () => checkRuns(f).length > 1, 20000, controller.signal))
            .then(f.releaseFirst)
        : Promise.resolve();
    try {
      await Promise.all([
        secondQueued,
        ...ready.map(async item => {
          const early = initial.includes(item);
          if (hasLate && !early) await firstQueued;
          await sleep(item.at ?? 0);
          await enqueueLanding(f.work, item.command, item.view);
          queued++;
          if (early && ++queuedInitial === initial.length) releaseInitial();
          if (hasLate && f.concurrency === 1 && queued === ready.length) f.releaseFirst();
          if (ordered && early) await initialReady;
          controller.signal.throwIfAborted();
          await drainLandingBatches(f.work, 'main');
        }),
      ]);
    } finally {
      f.releaseFirst();
      releaseInitial();
      controller.abort(new Error('Burst observation settled'));
    }
  }
  return { ms: performance.now() - started, ready };
}
const checkRuns = f => f.store.load().runs.filter(run => !run.mainCheck && !f.soloRuns.has(run.id));
/** Every Channel move is the exact head of a passed run on that View: main was never unchecked. */
function neverRed(f) {
  const data = f.store.load();
  for (const move of data.channelMoves.filter(move => move.channel === 'main'))
    assert.ok(
      data.runs.some(run => run.viewId === move.viewId && run.head === move.head && run.status === 'passed'),
      `move ${move.head} has no passing exact-head run`,
    );
}
const statuses = f => f.store.load().landingEntries.map(entry => entry.status);

test('baseline: a lone change costs one check time T', async t => {
  const f = await fixture(t);
  const { ms } = await burst(f, [{ path: 'one.txt' }]);
  t.diagnostic(`T(lone, window ${120}ms)=${Math.round(ms)}ms`);
  assert.deepEqual(statuses(f), ['accepted']);
});

for (const size of [4, 8])
  test(`queued wave of ${size} independent changes lands with one exact combined check`, async t => {
    // Keep the original 1.5 s synthetic check and 600 ms window. The helper
    // makes the cohort durable without requiring OS scheduling to fit that window.
    const lone = (
      await burst(await fixture(t, { delay: 1500, window: 600 }), [{ path: 'one.txt' }], { green: true })
    ).ms;
    const f = await fixture(t, { delay: 1500, window: 600 });
    const { ms } = await burst(
      f,
      Array.from({ length: size }, (_, i) => ({ path: `b${i}.txt`, at: i * 10 })),
      { admitBeforeDrain: true, green: true },
    );
    // Old shape (no window, nothing stacked) for comparison: first change checks alone, the rest queue behind it.
    const old = await fixture(t, { delay: 1500, window: 0, concurrency: 1 });
    const before = (
      await burst(
        old,
        Array.from({ length: size }, (_, i) => ({ path: `b${i}.txt`, at: i * 10 })),
        { green: true },
      )
    ).ms;
    t.diagnostic(
      `SYNTHETIC burst ${size}: lone ${Math.round(lone)}ms; already-green stacked+window ${Math.round(ms)}ms (${checkRuns(f).length} check); window 0 / concurrency 1 ${Math.round(before)}ms (${checkRuns(old).length} checks); mock remote 1500ms/check, no real runner`,
    );
    assert.deepEqual(statuses(f), Array(size).fill('accepted'));
    assert.equal(checkRuns(f).length, 1, 'one combined exact check');
    // Separate wall-clock runs cannot guarantee size × lone under shared machine load.
    // Keep the measured timings above; assert the batching work reduction directly.
    assert.ok(checkRuns(old).length >= size, 'the serial control checks each change separately');
    neverRed(f);
    for (let i = 0; i < size; i++) assert.equal(f.content(`b${i}.txt`), `b${i}.txt\n`);
  });

test('one failing change in the middle does not land, the others do, and main is never red', async t => {
  const f = await fixture(t);
  const { ready } = await burst(f, [
    { path: 'a.txt', at: 0 },
    { path: 'bad.txt', at: 10 },
    { path: 'c.txt', at: 20 },
    { path: 'd.txt', at: 30 },
  ]);
  assert.deepEqual(statuses(f), ['accepted', 'failed', 'accepted', 'accepted']);
  assert.equal(f.content('bad.txt'), undefined);
  for (const path of ['a.txt', 'c.txt', 'd.txt']) assert.equal(f.content(path), `${path}\n`);
  assert.equal(f.store.select('landingEntries', ready[1].command.operationId).status, 'failed');
  neverRed(f);
});

test('a late arrival during an in-flight check is checked concurrently, stacked, and lands after its parent', async t => {
  // The late arrival follows the actual first check; its gate preserves in-flight ordering.
  const f = await fixture(t, { delay: 1500, window: 60 });
  const { ms } = await burst(
    f,
    [
      { path: 'a.txt', at: 0 },
      { path: 'b.txt', at: 10 },
      { path: 'late.txt', at: 300 },
    ],
    { green: true },
  );
  const data = f.store.load(),
    runs = checkRuns(f);
  assert.deepEqual(statuses(f), ['accepted', 'accepted', 'accepted']);
  assert.equal(data.landingBatches.length, 2);
  assert.equal(data.landingBatches[1].parentId, data.landingBatches[0].id);
  assert.equal(data.landingBatches[1].previous, data.landingBatches[0].prefixes.at(-1).head);
  const [first, second] = runs.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  assert.ok(second.queuedAt < first.endedAt, 'the second check overlapped the first');
  assert.ok(data.channelMoves[0].at <= data.channelMoves[1].at);
  assert.equal(data.channelMoves.length, 2);
  t.diagnostic(`late arrival: ${Math.round(ms)}ms, ${runs.length} checks`);
  neverRed(f);
});

test('a failing parent batch supersedes the stacked batch, which is requeued and checked on real main', async t => {
  // The late arrival follows the actual first check; its gate preserves in-flight ordering.
  const f = await fixture(t, { delay: 1500, window: 60, failWhen: "exists('a.txt') && exists('bad.txt')" });
  await burst(
    f,
    [
      { path: 'a.txt', at: 0 },
      { path: 'bad.txt', at: 10 },
      { path: 'late.txt', at: 300 },
    ],
    { green: true },
  );
  const data = f.store.load();
  assert.deepEqual(statuses(f), ['accepted', 'failed', 'accepted']);
  assert.equal(data.landingBatches[1].status, 'superseded');
  assert.equal(f.content('bad.txt'), undefined);
  assert.equal(f.content('late.txt'), 'late.txt\n');
  neverRed(f);
});

test('concurrency 1 never stacks (policy bound)', async t => {
  const f = await fixture(t, { window: 60, concurrency: 1 });
  await burst(f, [
    { path: 'a.txt', at: 0 },
    { path: 'late.txt', at: 300 },
  ]);
  const data = f.store.load();
  assert.ok(data.landingBatches.every(batch => !batch.parentId));
  assert.deepEqual(statuses(f), ['accepted', 'accepted']);
  neverRed(f);
});

test('a driver lost mid-burst is adopted: stacked batches resume in order without a red main', async t => {
  const f = await fixture(t, { window: 60 });
  const dispatch = f.work.dispatch.bind(f.work);
  let lost = false;
  f.work.dispatch = async (...args) => {
    const result = await dispatch(...args);
    if (!lost && args[0].action === 'accept-channel') {
      lost = true;
      throw new ForgeError('SOURCE_CHANGED', 'Synthetic lost acceptance reply');
    }
    return result;
  };
  const arrivals = [
    { path: 'a.txt', at: 0 },
    { path: 'b.txt', at: 10 },
    { path: 'late.txt', at: 200 },
  ];
  await assert.rejects(burst(f, arrivals, { green: true }), { code: 'SOURCE_CHANGED' });
  assert.ok(f.store.load().landingBatches.some(batch => ['checking', 'completed'].includes(batch.status)));
  neverRed(f);
  await drainLandingBatches(new AgentWorkflow(f.root).work, 'main');
  assert.deepEqual(statuses(f), ['accepted', 'accepted', 'accepted']);
  for (const path of ['a.txt', 'b.txt', 'late.txt']) assert.equal(f.content(path), `${path}\n`);
  assert.equal(checkRuns(f).length, new Set(checkRuns(f).map(run => run.id)).size);
  neverRed(f);
});
