import { watchOwnerPresence } from '../dist/presence-worker.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHook } from 'node:async_hooks';
import { fixture } from './landing-batch-fixture.mjs';
import { until, childWorker, gatedFixture } from './landing-worker-fixture.mjs';
import { watchLandingWorker } from '../dist/landing-worker.js';
import { watcherRuntime } from '../dist/local-watcher.js';
import { FakeWatchWorker } from './local-watcher-fixture.mjs';
import { landingWorkerStates, readLandingWorkerStatus } from '../dist/landing-worker-status.js';
import { readPendingStatus } from '../dist/pending-status-read.js';
import { formatPendingStatus } from '../dist/pending-status-format.js';
import { startOwnerPresence } from '../dist/presence-worker-start.js';
import { driveLand as land } from '../dist/land.js';
import { WorkStore } from '../dist/work-store.js';
import { ForgeError } from '../dist/errors.js';
import { notifyAutoExchange } from '../dist/auto-exchange-notify.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function worker(f) {
  const controller = new AbortController();
  const pending = watchLandingWorker(f.store, controller.signal);
  return async () => {
    controller.abort();
    await pending;
  };
}
const entries = f => f.store.load().landingEntries ?? [];
const runs = f => f.store.load().runs.filter(r => !r.mainCheck);

test('startup recovers durable work without an observer or land-ready', async t => {
  const f = await fixture(t, { remote: false });
  await f.candidate('restart.txt');
  const stop = worker(f);
  try {
    await until(f, () => entries(f)[0]?.status === 'accepted', 'startup lands');
    assert.equal(f.content('restart.txt'), 'restart.txt\n');
    assert.equal(runs(f).length, 1);
    assert.equal(readPendingStatus(f.store).landingWorker.pendingRecovery, 0);
  } finally {
    await stop();
  }
  assert.equal(readLandingWorkerStatus(f.store).status, 'stopped');
});

test('durable enqueue wakes an already idle owner lifecycle after its observer disconnects', async t => {
  const f = await fixture(t, { remote: false });
  const stop = startOwnerPresence(f.store),
    observer = startOwnerPresence(f.store);
  try {
    await until(f, () => readLandingWorkerStatus(f.store).status === 'idle', 'idle lifecycle');
    await observer();
    await f.candidate('detached.txt');
    await until(f, () => entries(f)[0]?.status === 'accepted', 'owner continues without observer');
    assert.equal(runs(f).length, 1);
  } finally {
    await stop();
  }
});

for (const action of ['land', 'finish'])
  test(`a new ${action} submission wakes an idle driver without filesystem events`, async t => {
    const f = await fixture(t, { remote: false });
    const input = await f.candidate(`wake-${action}.txt`, undefined, false);
    const owner = await childWorker(f, { filesystem: false });
    try {
      const operationId = randomUUID();
      const submitted = await f.agent.dispatch(
        action === 'land'
          ? { action, operationId, laneIds: [input.lane.laneId], wait: false }
          : { ...input.command, operationId, wait: false },
      );
      assert.equal(submitted.result.durable, true);
      await until(
        f,
        () => entries(f).some(entry => entry.status === 'accepted'),
        'submission wakes socket driver',
      );
      assert.equal(runs(f).length, 1);
      assert.equal(f.store.load().channelMoves.length, 1);
      assert.equal(f.content(`wake-${action}.txt`), `wake-${action}.txt\n`);
    } finally {
      await owner.stop();
    }
  });

test('two worker processes retain one check, batch, and acceptance', async t => {
  const f = await gatedFixture(t);
  // Native filesystem events are hints and may be missed; durable commit and
  // peer-release socket wakes must keep both ready controllers progressing.
  const a = await childWorker(f, { filesystem: false });
  let b;
  try {
    b = await childWorker(f, { filesystem: false });
    await f.candidate('two.txt');
    await until(f, () => f.started, 'check command ready');
    f.release();
    await until(f, () => entries(f)[0]?.status === 'accepted', 'one driver lands');
    assert.equal(runs(f).length, 1);
    assert.equal(f.store.load().landingBatches.length, 1);
    assert.equal(f.store.load().channelMoves.length, 1);
  } finally {
    f.release();
    await a.stop();
    await b?.stop();
  }
});

test('killed controller restarts the retained composed batch and original IDs', async t => {
  const f = await fixture(t, { remote: false, delay: 100 });
  await f.candidate('kill.txt');
  // A real controller is killed after selection, before a check can be dispatched.
  const script = `import { AgentWorkflow } from ${JSON.stringify(new URL('../dist/agent-workflow.js', import.meta.url).href)};
import { batchEdit,selectBatch,composeBatch } from ${JSON.stringify(new URL('../dist/landing-batch-store.js', import.meta.url).href)};
import { withQueueSlot } from ${JSON.stringify(new URL('../dist/landing-queue.js', import.meta.url).href)};
import { batchDirectory } from ${JSON.stringify(new URL('../dist/landing-batch-store.js', import.meta.url).href)};
const w=new AgentWorkflow(process.argv[1]).work;
await withQueueSlot(batchDirectory(w,'main'),async()=>{const b=await batchEdit(w,'select',d=>selectBatch(w,d,'main'));await composeBatch(w,b);process.stdout.write('ready\\n');const keep=setInterval(()=>{},1000);await new Promise(()=>{});clearInterval(keep);},{anchor:w.store.directory});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.root], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await once(child.stdout, 'data');
  const before = f.store.load().landingBatches[0];
  const killed = once(child, 'exit');
  child.kill('SIGKILL');
  await killed;
  const restarted = await childWorker(f);
  try {
    await until(f, () => entries(f)[0]?.status === 'accepted', 'restart adopts');
    const after = f.store.load().landingBatches[0];
    assert.equal(after.id, before.id);
    assert.deepEqual(
      after.prefixes.map(({ reservedAt, ...pins }) => pins),
      before.prefixes,
    );
    assert(
      after.prefixes.every(prefix => Number.isFinite(Date.parse(prefix.reservedAt))),
      'check reservation time is added by the recovered attempt',
    );
    assert.equal(runs(f)[0].id, before.prefixes[0].runId);
    assert.equal(f.store.load().channelMoves.length, 1);
  } finally {
    await restarted.stop();
  }
});

test('shutdown leaves submitted runs active and startup adopts their completion', async t => {
  const f = await gatedFixture(t);
  await f.candidate('stop.txt');
  const stop = worker(f);
  let restart;
  try {
    await until(f, () => f.started, 'run command ready');
    assert.equal(runs(f)[0].status, 'running');
    const original = runs(f)[0].id;
    await stop();
    assert.equal(runs(f)[0].status, 'running');
    assert.equal(runs(f)[0].cancellation, undefined);
    restart = worker(f);
    f.release();
    await until(f, () => entries(f)[0]?.status === 'accepted', 'original completion lands');
    assert.equal(runs(f).length, 1);
    assert.equal(runs(f)[0].id, original);
  } finally {
    f.release();
    await stop();
    await restart?.();
  }
});

test('stacked dependency finish wakes after parent lands using its original request', async t => {
  const f = await fixture(t, { remote: false });
  const parent = await f.candidate('parent.txt', undefined, false);
  const child = (
    await f.agent.dispatch({ action: 'start', outcome: 'Stacked child', stackOn: parent.lane.laneId })
  ).result;
  writeFileSync(join(child.path, 'child.txt'), 'child\n');
  const operationId = randomUUID();
  const result = (
    await f.agent.dispatch({
      action: 'finish',
      operationId,
      laneId: child.laneId,
      message: 'child',
      accept: true,
      waitMs: 0,
    })
  ).result;
  assert.equal(result.status, 'waiting-for-dependency');
  const stop = worker(f);
  try {
    await land(f.work, {
      action: 'land',
      operationId: randomUUID(),
      laneIds: [parent.lane.laneId],
      channel: 'main',
      waitMs: 0,
    });
    await until(
      f,
      () => entries(f).some(e => e.id === operationId && e.status === 'accepted'),
      'dependency finish lands',
    );
    assert.equal(f.content('parent.txt'), 'parent.txt\n');
    assert.equal(f.content('child.txt'), 'child\n');
    assert.equal(entries(f).filter(e => e.id === operationId).length, 1);
  } finally {
    await stop();
  }
});

test('idle service has no timer resources, Work writes, or hosted writes; status remains read-only', async t => {
  const f = await fixture(t, { remote: false });
  const stop = worker(f);
  try {
    await until(f, () => readLandingWorkerStatus(f.store).status === 'idle', 'idle');
    await delay(300); // Drain notifications from fixture setup before measuring idle.
    const pointer = readFileSync(join(f.store.directory, 'work.json'));
    const fetch = t.mock.method(globalThis, 'fetch', () => {
      throw new Error('Idle worker must not use hosted APIs');
    });
    let timers = 0;
    const hook = createHook({
      init(_id, type) {
        if (type === 'Timeout') timers++;
      },
    }).enable();
    await new Promise(resolve => setImmediate(resolve));
    const status = readPendingStatus(f.store);
    assert.match(formatPendingStatus(status), /landing worker idle/);
    await new Promise(resolve => setImmediate(resolve));
    hook.disable();
    assert.equal(timers, 0);
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(readFileSync(join(f.store.directory, 'work.json')), pointer);
    assert.equal(f.store.load().channelMoves.length, 0);
  } finally {
    await stop();
  }
});

test('legacy land journal dependency recovery keeps original child operations', async t => {
  const f = await fixture(t, { remote: false });
  const parent = await f.candidate('legacy-parent.txt', undefined, false);
  const child = (
    await f.agent.dispatch({ action: 'start', outcome: 'legacy child', stackOn: parent.lane.laneId })
  ).result;
  writeFileSync(join(child.path, 'legacy-child.txt'), 'child\n');
  await f.agent.dispatch({ action: 'checkpoint', laneId: child.laneId, message: 'save' });
  const operationId = randomUUID();
  await land(f.work, { action: 'land', operationId, laneIds: [child.laneId], channel: 'main', waitMs: 0 });
  const path = join(f.store.directory, 'agent-land', `${operationId}.json`);
  const journal = JSON.parse(readFileSync(path));
  const original = journal.entries[0].command.operationId;
  delete journal.command;
  writeFileSync(path, JSON.stringify(journal));
  const stop = worker(f);
  try {
    await land(f.work, {
      action: 'land',
      operationId: randomUUID(),
      laneIds: [parent.lane.laneId],
      channel: 'main',
      waitMs: 0,
    });
    await until(
      f,
      () => entries(f).some(e => e.id === original && e.status === 'accepted'),
      'legacy child lands',
    );
    assert.equal(f.content('legacy-child.txt'), 'child\n');
    assert.equal(JSON.parse(readFileSync(path)).request, journal.request);
    assert.equal(entries(f).filter(e => e.id === original).length, 1);
  } finally {
    await stop();
  }
});

test('offline service status preserves pending submissions without a failed verdict', async t => {
  const f = await fixture(t, { remote: false });
  await f.candidate('offline.txt');
  const status = readPendingStatus(f.store);
  assert.equal(status.landingWorker.status, 'unavailable');
  assert.equal(status.landingWorker.pendingRecovery, 1);
  assert.equal(status.lanes[0].submission.state, 'pending');
  assert.match(formatPendingStatus(status), /1 pending recovery/);
});

test('startup adopts a finish journal interrupted before composition without recapturing dirty files', async t => {
  const f = await fixture(t, { remote: false });
  const input = await f.candidate('pinned.txt', undefined, false);
  const operationId = input.command.operationId;
  const dispatch = f.work.dispatch.bind(f.work);
  f.work.dispatch = async (command, ...args) => {
    if (command.action === 'compose') {
      const { ForgeError } = await import('../dist/errors.js');
      throw new ForgeError('SYNTHETIC_EXIT', 'Driver exited after its real finish checkpoint and journal');
    }
    return dispatch(command, ...args);
  };
  await assert.rejects(f.agent.dispatch(input.command), { code: 'SYNTHETIC_EXIT' });
  f.work.dispatch = dispatch;
  writeFileSync(join(input.lane.path, 'dirty.txt'), 'unsaved\n');
  const stop = worker(f);
  try {
    await until(
      f,
      () => entries(f).some(e => e.id === operationId && e.status === 'accepted'),
      'unfinished finish lands',
    );
    assert.equal(f.content('pinned.txt'), 'pinned.txt\n');
    assert.equal(f.content('dirty.txt'), undefined);
    assert.equal(readFileSync(join(input.lane.path, 'dirty.txt'), 'utf8'), 'unsaved\n');
  } finally {
    await stop();
  }
});

test('managed owner drives while another lifecycle owns advisory presence', async t => {
  const f = await fixture(t, { remote: false });
  await f.candidate('presence-owner.txt');
  const presenceController = new AbortController();
  const presence = watchOwnerPresence(f.store, presenceController.signal);
  await new Promise(resolve => setImmediate(resolve));
  const stop = startOwnerPresence(f.store);
  try {
    await until(
      f,
      () => entries(f)[0]?.status === 'accepted',
      'managed landing continues despite occupied presence',
    );
    assert.equal(runs(f).length, 1);
  } finally {
    await stop();
    presenceController.abort();
    await presence;
  }
});

test('the controller retries a transient observation failure without an external wake or Work revision', async t => {
  const f = await fixture(t, { remote: false });
  await f.candidate('retry-observation.txt');
  // Flush admission before registering the worker, and suppress even the
  // watcher's startup-ready hint: no notification can rescue the failed sweep.
  await new Promise(resolve => setImmediate(resolve));
  t.mock.method(watcherRuntime, 'createWorker', () => new FakeWatchWorker({ hangStartup: true }));
  const readRecords = WorkStore.prototype.readRecords;
  let injected = false;
  let acknowledge;
  const failed = new Promise(resolve => {
    acknowledge = resolve;
  });
  t.mock.method(WorkStore.prototype, 'readRecords', function () {
    // The worker's AgentWorkflow has its own store. Fail its first drain read,
    // after the worker has already retained this Work revision as observed.
    if (this.root === f.store.root && this !== f.store && !injected) {
      injected = true;
      acknowledge();
      throw new ForgeError('SOURCE_CHANGED', 'Synthetic concurrent observation');
    }
    return readRecords.call(this);
  });
  const revision = f.store.revision();
  const stop = worker(f);
  try {
    await failed;
    assert.equal(injected, true);
    // No enqueue, explicit wake, edit, or result receipt is needed for retry.
    await until(f, () => entries(f)[0]?.status === 'accepted', 'same revision is retried');
    assert.ok(f.store.revision() > revision);
    assert.equal(runs(f).length, 1);
  } finally {
    await stop();
  }
});

test('lifecycle wait sees a write published during its initial snapshot', async t => {
  const f = await fixture(t, { remote: false });
  const path = join(f.store.directory, 'test-ready');
  let first = true;
  await until(
    f,
    () => {
      if (first) {
        first = false;
        writeFileSync(path, 'ready');
        return false;
      }
      return existsSync(path);
    },
    'write during snapshot',
  );
});

test('lifecycle wait rereads durable state before its deadline failure', async t => {
  const f = await fixture(t, { remote: false });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let ready = false;
  const pending = until(f, () => ready, 'delayed notification');
  // Model a completed publication whose filesystem callback has not run before
  // the timer. No real sleep or larger timeout is needed to exercise this order.
  ready = true;
  t.mock.timers.tick(20_000);
  assert.equal(await pending, true);
  t.mock.timers.reset();
});

test('queue admission contention retries the same snapshot after a peer release wake', async t => {
  const f = await fixture(t, { remote: false });
  await f.candidate('admission.txt');
  const { CheckQueue } = await import('../dist/check-queue.js');
  const position = CheckQueue.prototype.position;
  let blocked = false;
  let acknowledge;
  const contended = new Promise(resolve => {
    acknowledge = resolve;
  });
  t.mock.method(CheckQueue.prototype, 'position', function () {
    if (this.path.includes('/landing-batch-drain/') && !blocked) {
      blocked = true;
      acknowledge();
      // Bakery admission also waits for a peer that is still choosing a ticket;
      // neither contender need have published a holding ticket or a Work write.
      return { acquired: false, position: 1, holder: undefined };
    }
    return position.call(this);
  });
  const stop = worker(f);
  try {
    await contended;
    const state = landingWorkerStates(f.store)[0];
    notifyAutoExchange(state.endpoint);
    await until(f, () => entries(f)[0]?.status === 'accepted', 'queue release retries admission');
    assert.equal(blocked, true);
    assert.equal(runs(f).length, 1);
    assert.equal(f.store.load().landingBatches.length, 1);
    assert.equal(f.store.load().channelMoves.length, 1);
  } finally {
    await stop();
  }
});

for (const action of ['finish', 'land'])
  test(`${action} from an agent shell is driven by an installed worker with different shell defaults`, async t => {
    const f = await fixture(t, { remote: false });
    const input = await f.candidate('agent-shell.txt', 'submitted source\n', false);
    const env = {
      ...process.env,
      PATH: `/worker-shell:${process.env.PATH}`,
      TERM: 'worker-terminal',
      LANG: 'C',
    };
    const worker = await childWorker(f, { env });
    try {
      const command =
        action === 'finish'
          ? {
              action,
              laneId: input.lane.laneId,
              message: 'Submit from another shell',
              accept: true,
              wait: false,
            }
          : { action, laneIds: [input.lane.laneId], wait: false };
      const script = `import { AgentWorkflow } from ${JSON.stringify(new URL('../dist/agent-workflow.js', import.meta.url).href)};
const reply = await new AgentWorkflow(process.argv[1]).dispatch(JSON.parse(process.argv[2]));
console.log(JSON.stringify({ durable: reply.result.durable }));`;
      const reply = await promisify(execFile)(
        process.execPath,
        ['--input-type=module', '-e', script, f.root, JSON.stringify(command)],
        {
          env: {
            ...process.env,
            PATH: `/agent-shell:${process.env.PATH}`,
            TERM: 'agent-terminal',
            LANG: 'en_US.UTF-8',
          },
        },
      );
      assert.equal(JSON.parse(reply.stdout).durable, true);
      await until(f, () => entries(f)[0]?.status === 'accepted', 'worker lands shell submission');
      assert.equal(runs(f).length, 1);
      assert.equal(runs(f)[0].status, 'passed');
      assert.equal(runs(f)[0].environment.env.PATH === env.PATH, true);
      assert.equal(runs(f)[0].environment.env.TERM === env.TERM, true);
      assert.equal(f.content('agent-shell.txt'), 'submitted source\n');
      assert.equal(f.store.load().channelMoves.length, 1);
    } finally {
      await worker.stop();
    }
  });

for (const action of ['finish', 'land'])
  test(`${action} retains check settings at async admission before the worker queues it`, async t => {
    const f = await fixture(t, { remote: false });
    const input = await f.candidate('scoped-setting.txt', undefined, false);
    const command =
      action === 'finish'
        ? { action, laneId: input.lane.laneId, message: 'Pinned settings', accept: true, wait: false }
        : { action, laneIds: [input.lane.laneId], wait: false };
    await f.agent.dispatch(command);
    const old = process.env.FORGE_CHECK_SCOPED;
    const worker = await childWorker(f, {
      env: { ...process.env, FORGE_CHECK_SCOPED: old === '1' ? '0' : '1' },
    });
    try {
      await until(f, () => entries(f)[0]?.status === 'interrupted', 'settings mismatch retained');
      assert.match(entries(f)[0].reason, /FORGE_CHECK_SCOPED/);
      assert.match(entries(f)[0].reason, /owner service.*submitter/);
      assert.equal(runs(f).length, 0);
      assert.equal(f.store.load().channelMoves.length, 0);
    } finally {
      await worker.stop();
    }
  });

test('an idle owner worker observes metadata without taking the Work writer lock', async t => {
  const f = await fixture(t, { remote: false });
  let locks = 0;
  t.mock.method(f.store, 'locked', () => {
    locks++;
    throw Error('Idle worker acquired writer lock');
  });
  const stop = worker(f);
  try {
    await until(f, () => readLandingWorkerStatus(f.store).status === 'idle', 'idle without writer admission');
    assert.equal(locks, 0);
  } finally {
    await stop();
    t.mock.restoreAll();
  }
});
