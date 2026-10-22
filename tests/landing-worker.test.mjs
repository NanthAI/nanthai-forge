import { watchOwnerPresence } from '../dist/presence-worker.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHook } from 'node:async_hooks';
import { fixture } from './landing-batch-fixture.mjs';
import { watchLandingWorker } from '../dist/landing-worker.js';
import { landingWorkerStates, readLandingWorkerStatus } from '../dist/landing-worker-status.js';
import { readPendingStatus } from '../dist/pending-status-read.js';
import { formatPendingStatus } from '../dist/pending-status-format.js';
import { startOwnerPresence } from '../dist/presence-worker-start.js';
import { land } from '../dist/land.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, message) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const result = read();
    if (result) return result;
    await delay(30);
  }
  assert.fail(message);
}
function worker(f) {
  const controller = new AbortController();
  const pending = watchLandingWorker(f.store, controller.signal);
  return async () => {
    controller.abort();
    await pending;
  };
}
async function childWorker(f) {
  const script = `import { WorkStore } from ${JSON.stringify(new URL('../dist/work-store.js', import.meta.url).href)};
import { watchLandingWorker } from ${JSON.stringify(new URL('../dist/landing-worker.js', import.meta.url).href)};
const c=new AbortController();process.on('SIGTERM',()=>c.abort());
await watchLandingWorker(new WorkStore(process.argv[1]),c.signal);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.root], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: process.env,
  });
  let errors = '';
  child.stderr.on('data', bytes => {
    errors += bytes;
  });
  child.on('error', error => {
    errors += error.code;
  });
  await until(
    () => landingWorkerStates(f.store).find(s => s.worker.pid === child.pid),
    `child started: ${errors}`,
  );
  return {
    child,
    stop: async (signal = 'SIGTERM') => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exit = once(child, 'exit');
      child.kill(signal);
      await exit;
      assert.doesNotMatch(errors, /(?:Error:|Unhandled|Warning:)/, 'worker had no errors');
    },
  };
}
const entries = f => f.store.load().landingEntries ?? [];
const runs = f => f.store.load().runs.filter(r => !r.mainCheck);

test('startup recovers durable work without an observer or land-ready', async t => {
  const f = await fixture(t, { remote: false });
  await f.candidate('restart.txt');
  const stop = worker(f);
  try {
    await until(() => entries(f)[0]?.status === 'accepted', 'startup lands');
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
    await until(() => readLandingWorkerStatus(f.store).status === 'idle', 'idle lifecycle');
    await observer();
    await f.candidate('detached.txt');
    await until(() => entries(f)[0]?.status === 'accepted', 'owner continues without observer');
    assert.equal(runs(f).length, 1);
  } finally {
    await stop();
  }
});

test('two worker processes retain one check, batch, and acceptance', async t => {
  const f = await fixture(t, { remote: false, delay: 150 });
  await f.candidate('two.txt');
  const a = await childWorker(f),
    b = await childWorker(f);
  try {
    await until(() => entries(f)[0]?.status === 'accepted', 'one driver lands');
    assert.equal(runs(f).length, 1);
    assert.equal(f.store.load().landingBatches.length, 1);
    assert.equal(f.store.load().channelMoves.length, 1);
  } finally {
    await a.stop();
    await b.stop();
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
    await until(() => entries(f)[0]?.status === 'accepted', 'restart adopts');
    const after = f.store.load().landingBatches[0];
    assert.equal(after.id, before.id);
    assert.deepEqual(after.prefixes, before.prefixes);
    assert.equal(runs(f)[0].id, before.prefixes[0].runId);
    assert.equal(f.store.load().channelMoves.length, 1);
  } finally {
    await restarted.stop();
  }
});

test('shutdown leaves submitted runs active and startup adopts their completion', async t => {
  const f = await fixture(t, { remote: false, delay: 1200 });
  await f.candidate('stop.txt');
  const stop = worker(f);
  await until(() => runs(f)[0]?.status === 'running', 'run starts');
  const original = runs(f)[0].id;
  await stop();
  assert.ok(['running', 'passed'].includes(runs(f)[0].status));
  assert.equal(runs(f)[0].cancellation, undefined);
  const restart = worker(f);
  try {
    await until(() => entries(f)[0]?.status === 'accepted', 'original completion lands');
    assert.equal(runs(f).length, 1);
    assert.equal(runs(f)[0].id, original);
  } finally {
    await restart();
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
    await until(() => readLandingWorkerStatus(f.store).status === 'idle', 'idle');
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
