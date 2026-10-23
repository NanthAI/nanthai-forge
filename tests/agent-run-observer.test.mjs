// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { checkEnvironment } from '../dist/work-run.js';
import { SelectedRunObserver } from '../dist/work-run-observation.js';
import { waitForAgentRun } from '../dist/agent-run-observer.js';
import { ForgeError } from '../dist/errors.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';

test('a transient selected-run read race keeps observing the original run', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = { id: randomUUID(), status: 'passed' };
  let reads = 0;
  t.mock.method(SelectedRunObserver.prototype, 'read', function () {
    if (++reads === 1) throw new ForgeError('SOURCE_CHANGED', 'Concurrent Work publication');
    return run;
  });
  const waiting = waitForAgentRun({}, run.id, 1000);
  t.mock.timers.tick(250);
  await waiting;
  assert.equal(reads, 2);
});

test('selected-run read failures other than publication races remain visible', async t => {
  t.mock.method(SelectedRunObserver.prototype, 'read', () => {
    throw new ForgeError('INVALID_WORK_STORE', 'Invalid selected run');
  });
  await assert.rejects(waitForAgentRun({}, randomUUID()), error => error.code === 'INVALID_WORK_STORE');
});

test('a publication race respects an expired observation window', async t => {
  let reads = 0;
  t.mock.method(SelectedRunObserver.prototype, 'read', () => {
    reads++;
    throw new ForgeError('SOURCE_CHANGED', 'Concurrent Work publication');
  });
  await waitForAgentRun({}, randomUUID(), 0);
  assert.equal(reads, 1);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-selected-run-'));
  writeFileSync(join(root, 'a.txt'), 'source');
  initNative(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new WorkStore(root),
    peer = new WorkStore(root),
    data = store.load();
  const run = {
    id: randomUUID(),
    viewId: randomUUID(),
    head: data.nativeHead,
    base: data.nativeHead,
    inputs: [],
    dependencies: [],
    check: {
      id: randomUUID(),
      name: 'Synthetic observation',
      executable: process.execPath,
      args: [],
      environmentLabel: 'Fixture',
      definition: 'a'.repeat(64),
      at: 'now',
    },
    environment: checkEnvironment(),
    status: 'running',
    startedAt: 'now',
    runner: { pid: process.pid, host: hostname() },
    details: 'Synthetic running record',
  };
  const unrelated = {
    ...structuredClone(run),
    id: randomUUID(),
    runner: { pid: 2147483647, host: hostname() },
  };
  data.runs = [run, unrelated];
  store.save(data);
  return { root, store, peer, run, unrelated };
}

test('waiting on a live selected run takes no owner locks or full Work loads while another writer advances metadata', async t => {
  const { store, peer, run, unrelated } = fixture(t);
  let loads = 0,
    locks = 0,
    writes = 0;
  store.load = () => {
    loads++;
    throw Error('Waiting must not reconstruct Work');
  };
  store.locked = () => {
    locks++;
    throw Error('Live waiting must not lock Work');
  };
  const waiting = waitForAgentRun(store, run.id, 800);
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    peer.locked(() => {
      const data = peer.load();
      data.revision++;
      data.observerProbe = `Concurrent write ${i}`;
      peer.save(data);
      writes++;
    });
  }
  await waiting;
  assert.equal(writes, 3);
  assert.equal(loads, 0);
  assert.equal(locks, 0);
  assert.equal(peer.load().runs.find(item => item.id === unrelated.id).status, 'running');
});

test('cached selected run follows revision and position changes without reading unrelated record bytes', t => {
  const { store, peer, run, unrelated } = fixture(t),
    reader = new SelectedRunObserver(store, run.id);
  assert.equal(reader.read().id, run.id);
  const data = peer.load();
  data.runs.reverse();
  data.runs.find(item => item.id === run.id).details = 'Moved';
  data.revision++;
  peer.save(data);
  assert.equal(reader.read().details, 'Moved');
  data.revision++;
  data.runs.find(item => item.id === run.id).details = 'Changed';
  peer.save(data);
  const manifest = JSON.parse(readFileSync(join(store.directory, 'work.json'))),
    hashes = JSON.parse(readFileSync(join(store.directory, 'records', manifest.collections.runs.pages[0])));
  const unrelatedPath = join(store.directory, 'records', hashes[0]),
    bytes = readFileSync(unrelatedPath);
  assert.equal(JSON.parse(bytes).fields.id, unrelated.id);
  writeFileSync(unrelatedPath, 'unavailable unrelated history');
  try {
    assert.equal(reader.read().details, 'Changed');
  } finally {
    writeFileSync(unrelatedPath, bytes);
  }
  data.runs = data.runs.filter(item => item.id !== run.id);
  data.revision++;
  peer.save(data);
  assert.throws(
    () => reader.read(),
    error => error.code === 'NOT_FOUND',
  );
});

test('durable cancellation reconciles only the selected run once, preserving another dead runner for its own observation', async t => {
  const { store, peer, run, unrelated } = fixture(t);
  let locks = 0,
    loads = 0;
  const locked = store.locked.bind(store),
    load = store.load.bind(store);
  store.locked = fn => {
    locks++;
    return locked(fn);
  };
  store.load = () => {
    loads++;
    return load();
  };
  const path = join(store.directory, `check-${run.id}`);
  mkdirSync(path);
  const waiting = waitForAgentRun(store, run.id, 2000);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(locks, 0);
  assert.equal(loads, 0);
  writeFileSync(
    join(path, 'result.json'),
    JSON.stringify({
      status: 'cancelled',
      endedAt: 'now',
      exitCode: null,
      signal: 'SIGTERM',
      details: 'Original cancelled outcome',
    }),
  );
  await waiting;
  assert.equal(locks, 1);
  assert.equal(loads, 0);
  const data = peer.load();
  assert.equal(data.runs.find(item => item.id === run.id).status, 'cancelled');
  assert.equal(data.runs.find(item => item.id === unrelated.id).status, 'running');
  await waitForAgentRun(store, run.id, 0);
  assert.equal(locks, 1);
  assert.equal(loads, 0);
});

test('established selected runner death is reconciled without manufacturing outcomes for other hosts', async t => {
  const { store, peer, run, unrelated } = fixture(t),
    data = peer.load();
  data.runs[0].runner.pid = 2147483647;
  data.runs[1].runner.host = 'another-host';
  data.revision++;
  peer.save(data);
  await waitForAgentRun(store, run.id, 0);
  const after = peer.load();
  assert.equal(after.runs[0].status, 'interrupted');
  assert.equal(after.runs[1].id, unrelated.id);
  assert.equal(after.runs[1].status, 'running');
});

for (const failure of ['SOURCE_CHANGED', 'INVALID_WORK_STORE', 'unexpected'])
  test(`actual runner handles ${failure} cancellation polling without full Work reads`, async t => {
    const { root, peer } = fixture(t),
      empty = peer.load();
    empty.runs = [];
    peer.save(empty);
    const agent = new AgentWorkflow(root),
      lane = (
        await agent.dispatch({ action: 'start', operationId: randomUUID(), outcome: 'Actual cancellation' })
      ).result;
    const view = (
      await agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId: lane.intentId,
        inputs: [{ laneId: lane.laneId, head: lane.head }],
      })
    ).result;
    const check = (
      await agent.dispatch({
        action: 'define-check',
        name: 'Live command',
        executable: process.execPath,
        args: ['-e', 'setTimeout(()=>process.exit(0),10000)'],
      })
    ).result;
    const run = (
      await agent.dispatch({
        action: 'run',
        operationId: randomUUID(),
        viewId: view.viewId,
        expectedHead: view.head,
        checkId: check.checkId,
        wait: false,
      })
    ).result;
    const store = agent.work.store,
      load = store.load.bind(store);
    let prematureLoads = 0;
    const receipt = join(store.directory, `check-${run.runId}`, 'result.json');
    store.load = () => {
      if (!existsSync(receipt)) {
        prematureLoads++;
        throw Error('Live cancellation polling reconstructed Work');
      }
      return load();
    };
    const readReceipt = () => JSON.parse(readFileSync(receipt, 'utf8'));
    const read = SelectedRunObserver.prototype.read;
    let raced = false;
    t.mock.method(SelectedRunObserver.prototype, 'read', function () {
      if (!raced) {
        raced = true;
        if (failure === 'unexpected') throw new Error('Synthetic unexpected poll error');
        throw new ForgeError(failure, 'Synthetic run record read error');
      }
      return read.call(this);
    });
    try {
      await new Promise(resolve => setTimeout(resolve, 400));
      assert.equal(raced, true);
      assert.equal(prematureLoads, 0);
      if (failure === 'SOURCE_CHANGED')
        peer.locked(() => {
          const data = peer.load();
          data.runs.find(item => item.id === run.runId).cancelRequested = true;
          data.revision++;
          peer.save(data);
        });
      const end = Date.now() + 5000;
      while (!existsSync(receipt) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(prematureLoads, 0);
      assert.equal(existsSync(receipt), true);
      store.load = load;
      const observed = (await agent.dispatch({ action: 'observe', operationId: run.runId, waitMs: 1000 }))
        .result;
      assert.equal(observed.status, failure === 'SOURCE_CHANGED' ? 'cancelled' : 'failed');
      if (failure === 'INVALID_WORK_STORE') assert.equal(readReceipt().error.code, failure);
      if (failure === 'unexpected') assert.match(readReceipt().details, /cancellation observation failed/);
      assert.equal(observed.runId, run.runId);
    } finally {
      store.load = load;
      const child = peer.load().runs.find(item => item.id === run.runId)?.childPid;
      if (child)
        try {
          process.kill(process.platform === 'win32' ? child : -child, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
    }
  });
