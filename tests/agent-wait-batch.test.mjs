// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { watcherRuntime } from '../dist/local-watcher.js';
import { FakeWatchWorker } from './local-watcher-fixture.mjs';
import { join } from 'node:path';
import { fixture } from './landing-batch-fixture.mjs';
import { selectBatch, composeBatch, batchEdit } from '../dist/landing-batch-store.js';
import { waitObservation } from '../dist/agent-wait-observation.js';
import { WorkStore } from '../dist/work-store.js';
import { retainDiagnosisNode } from '../dist/landing-diagnosis.js';
import { agentWait } from '../dist/agent-wait.js';

// Exercise the authoritative observation directly: no worker, native watcher,
// child command, sleeps or live owner's state is needed for this regression.
async function batchFixture(t) {
  const f = await fixture(t, { remote: false });
  const a = await f.candidate('a.txt'),
    b = await f.candidate('b.txt');
  const selected = await batchEdit(f.work, 'main', data => selectBatch(f.work, data, 'main'));
  const batch = await composeBatch(f.work, selected);
  const full = batch.prefixes.at(-1);
  const edit = mutate => batchEdit(f.work, batch.id, mutate);
  const addRun = async (prefix, status = 'running') => {
    await retainDiagnosisNode(f.work, batch, prefix, prefix === full ? undefined : full, {
      beforePublish() {},
    });
    const view = f.store.select('views', prefix.viewId);
    await edit(data => {
      data.runs.push({
        id: prefix.runId,
        viewId: prefix.viewId,
        head: prefix.head,
        base: batch.base,
        inputs: view.inputs,
        dependencies: view.dependencies,
        check: data.checks[0],
        environment: batch.environment,
        status,
        startedAt: new Date().toISOString(),
        runner: { pid: process.pid, host: hostname() },
        details: 'Synthetic retained batch run',
        ...(status === 'passed' ? { exitCode: 0, endedAt: new Date().toISOString() } : {}),
      });
    });
  };
  return { ...f, a, b, batch, full, edit, addRun };
}

test('queued operations discover their shared running batch check before settlement and after reopening', async t => {
  const f = await batchFixture(t);
  await f.addRun(f.full);
  const before = f.store.pointer();
  for (const store of [f.store, new WorkStore(f.root)]) {
    for (const c of [f.a, f.b]) {
      assert.equal(store.select('landingEntries', c.command.operationId).runId, undefined);
      const observed = waitObservation(store, 'operation', c.command.operationId);
      assert.deepEqual(observed.runIds, [f.full.runId]);
      assert.ok(
        observed.events.some(e => e.type === 'check' && e.id === f.full.runId && e.status === 'running'),
      );
      assert.equal(observed.target.terminal, false);
      assert.equal(observed.target.submissions[0].runId, f.full.runId);
      assert.equal(observed.target.submissions[0].checkStatus, 'running');
    }
  }
  assert.deepEqual(f.store.pointer(), before, 'observation never drives or publishes recovery');
});

test('a batch receipt is observed before Work publication without failing inputs before diagnosis', async t => {
  const f = await batchFixture(t);
  await f.addRun(f.full);
  const path = join(f.store.directory, `check-${f.full.runId}`);
  mkdirSync(path);
  writeFileSync(
    join(path, 'result.json'),
    JSON.stringify({
      status: 'failed',
      exitCode: 1,
      endedAt: new Date().toISOString(),
      details: 'Synthetic combination failed',
    }),
  );
  const before = f.store.pointer();
  for (const c of [f.a, f.b]) {
    const observed = waitObservation(f.store, 'operation', c.command.operationId);
    assert.ok(
      observed.events.some(e => e.type === 'check' && e.id === f.full.runId && e.status === 'failed'),
    );
    assert.equal(observed.target.terminal, false);
    assert.equal(observed.target.submissions[0].outcome, 'pending');
    assert.equal(observed.target.submissions[0].checkStatus, 'failed');
    assert.equal(observed.target.submissions[0].logPath, join(path, 'stdout.log'));
  }
  assert.deepEqual(f.store.pointer(), before);
  assert.equal(f.store.select('runs', f.full.runId).status, 'running');
});

test('shorter diagnostic probes remain live and settlement alone assigns each input outcome', async t => {
  const f = await batchFixture(t);
  const short = f.batch.prefixes[0];
  await f.addRun(f.full, 'failed');
  await f.addRun(short);
  const observed = waitObservation(f.store, 'operation', f.a.command.operationId);
  assert.deepEqual(new Set(observed.runIds), new Set([short.runId, f.full.runId]));
  assert.equal(observed.target.submissions[0].runId, short.runId);
  assert.equal(observed.target.terminal, false);
  assert.equal(waitObservation(f.store, 'operation', f.b.command.operationId).target.terminal, false);
  await f.edit(data => {
    data.runs.find(run => run.id === short.runId).status = 'passed';
    data.landingBatches[0].status = 'completed';
    Object.assign(data.landingEntries[0], { status: 'accepted', runId: short.runId });
    Object.assign(data.landingEntries[1], { status: 'failed', runId: f.full.runId });
  });
  const a = waitObservation(f.store, 'operation', f.a.command.operationId);
  const b = waitObservation(f.store, 'operation', f.b.command.operationId);
  assert.equal(a.target.status, 'landed');
  assert.equal(a.target.ok, true);
  assert.deepEqual(a.runIds, [short.runId]);
  assert.equal(b.target.status, 'terminal-failed');
  assert.equal(b.target.ok, false);
  assert.deepEqual(b.runIds, [f.full.runId]);
});

test('a reserved batch probe never substitutes a run with different source pins', async t => {
  const f = await batchFixture(t);
  await f.addRun(f.full);
  await f.edit(data => {
    data.runs[0].viewId = randomUUID();
  });
  const observed = waitObservation(f.store, 'operation', f.a.command.operationId);
  assert.deepEqual(observed.runIds, []);
  assert.equal(observed.target.submissions[0].runId, null);
  assert.equal(observed.target.terminal, false);
});

test('one observer registers the retained batch receipt and follows later settlement without native watchers', async t => {
  const f = await batchFixture(t);
  await f.addRun(f.full);
  const path = join(f.store.directory, `check-${f.full.runId}`);
  mkdirSync(path);
  const watchers = new Map();
  t.mock.method(watcherRuntime, 'createWorker', () => {
    const worker = new FakeWatchWorker();
    const post = worker.postMessage.bind(worker);
    worker.postMessage = message => {
      if (message.type === 'open')
        watchers.set(message.path, () => worker.event(null, 'change', message.path));
      if (message.type === 'close') {
        const subscription = worker.subscriptions.get(message.id);
        if (subscription) watchers.delete(subscription.path);
      }
      post(message);
    };
    return worker;
  });
  const events = [],
    controller = new AbortController();
  let passed, result;
  const receiptObserved = new Promise(resolve => {
    passed = resolve;
  });
  const wait = agentWait(
    f.store,
    {
      operationIds: [f.a.command.operationId, f.b.command.operationId],
    },
    event => {
      events.push(event);
      if (event.type === 'check' && event.status === 'passed') passed();
    },
    controller.signal,
  ).then(value => {
    result = value;
    return value;
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(watchers.has(path), 'the shared check directory is registered before sleeping');
    writeFileSync(
      join(path, 'result.json'),
      JSON.stringify({
        status: 'passed',
        exitCode: 0,
        endedAt: new Date().toISOString(),
        details: 'Synthetic completion',
      }),
    );
    watchers.get(path)();
    await receiptObserved;
    assert.equal(result, undefined, 'passing a batch check alone does not settle submissions');
    assert.equal(
      f.store.select('runs', f.full.runId).status,
      'running',
      'receipt read never writes recovery',
    );
    // Model a replacement driver publishing through a fresh owner reader.
    const reopened = new WorkStore(f.root);
    reopened.locked(() => {
      const data = reopened.load();
      data.landingBatches[0].status = 'completed';
      for (const entry of data.landingEntries)
        Object.assign(entry, { status: 'accepted', runId: f.full.runId });
      reopened.save(data);
    });
    watchers.get(f.store.directory)();
    const summary = await wait;
    assert.equal(summary.successful, true);
    assert.equal(summary.targets.length, 2);
    assert.equal(events.filter(e => e.type === 'check' && e.status === 'passed').length, 1);
    assert.equal(events.filter(e => e.type === 'submission' && e.status === 'landed').length, 2);
    assert.equal(watchers.size, 0);
  } finally {
    controller.abort();
    await wait;
  }
});
