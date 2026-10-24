// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture as createFixture } from './landing-batch-fixture.mjs';
import { stopOwnerCheckControllers } from './owner-cleanup.mjs';
import { readOnlyMcpLifetime, replayActionsLifetime } from './landing-lifetime-fixture.mjs';
import { until } from './landing-worker-fixture.mjs';
import { watchLandingWorker } from '../dist/landing-worker.js';
import { readPendingStatus } from '../dist/pending-status-read.js';
import { batchEdit, selectBatch, composeBatch } from '../dist/landing-batch-store.js';
import { queuedOutcome, submissionOutcome } from '../dist/landing-submission.js';
import { prepareRunRegistration } from '../dist/work-run-preparation.js';
import { checkEnvironment, adoptModalRun } from '../dist/work-run.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { WorkService } from '../dist/work.js';
import { ForgeError } from '../dist/errors.js';
import { landingWorkerStates } from '../dist/landing-worker-status.js';
import { formatPendingStatus } from '../dist/pending-status-format.js';
import { notifyAutoExchange } from '../dist/auto-exchange-notify.js';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { processAlive } from '../dist/local-process.js';
import { runCheckController } from '../dist/check-controller.js';

const read = path => JSON.parse(readFileSync(path));
const journalPath = (f, kind, operationId) => join(f.store.directory, `agent-${kind}`, `${operationId}.json`);
const moduleUrl = name => new URL(`../dist/${name}.js`, import.meta.url).href;
const fixture = (t, options) => createFixture(t, { ...options, stopChecks: true });
async function orphanRun(f, backend) {
  await f.candidate('incident.txt', 'retained input\n');
  const batch = await batchEdit(f.work, 'select', data => selectBatch(f.work, data, 'main'));
  await composeBatch(f.work, batch);
  const prefix = f.store.select('landingBatches', batch.id).prefixes[0];
  const preparation = prepareRunRegistration(f.store, {
    action: 'run-check',
    operationId: prefix.runId,
    viewId: prefix.viewId,
    expectedHead: prefix.head,
    checkId: f.check.checkId,
    expectedDefinition: f.check.definition,
    expectedEnvironment: checkEnvironment().fingerprint,
  });
  assert.ok(preparation?.run);
  const run = preparation.run;
  run.status = 'running';
  run.runner.pid = 2147483647;
  if (backend) run.backend = { requested: backend, actual: backend };
  const selected = preparation.tx.find('runs', run.id);
  preparation.tx.replace('runs', selected.position, run);
  f.store.locked(() => f.store.commitRecords(preparation.tx));
  return run;
}
async function drive(f, body) {
  const controller = new AbortController();
  const pending = watchLandingWorker(f.store, controller.signal);
  try {
    await body();
  } catch (error) {
    await stopOwnerCheckControllers(f.root);
    throw error;
  } finally {
    controller.abort();
    await pending;
  }
}
async function changeHead(f, input) {
  writeFileSync(join(input.lane.path, 'incident.txt'), 'head B\n');
  return (await f.agent.dispatch({ action: 'checkpoint', laneId: input.lane.laneId, message: 'B' })).result;
}

for (const selected of [false, true, 'composed'])
  test(`a newer save preserves the resolvable ${selected === 'composed' ? 'composed but unchecked' : selected ? 'selected' : 'queued'} Candidate`, async t => {
    const f = await fixture(t, { remote: false });
    const a = await f.candidate('incident.txt', 'head A\n');
    const peer = await f.candidate('peer.txt');
    if (selected) {
      const batch = await batchEdit(f.work, 'select', data => selectBatch(f.work, data, 'main'));
      if (selected === 'composed') await composeBatch(f.work, batch);
    }
    const b = await changeHead(f, a);
    await drive(f, async () => {
      await until(
        f,
        () => f.store.select('landingEntries', a.command.operationId)?.status === 'accepted',
        'original Candidate lands',
      );
      const entry = f.store.select('landingEntries', a.command.operationId);
      assert.equal(entry.head, a.view.head);
      assert.deepEqual(f.store.select('views', entry.viewId).inputs, a.view.inputs);
      assert.equal(f.content('incident.txt'), 'head A\n');
      assert.equal(f.store.select('lanes', a.lane.laneId).head, b.head);
      assert.equal(f.store.select('landingEntries', peer.command.operationId).status, 'accepted');
      assert.equal(f.content('peer.txt'), 'peer.txt\n');
      assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 1);
      assert.notEqual(readPendingStatus(f.store).landingWorker.status, 'error');
    });
  });

for (const selected of [false, true, 'composed'])
  test(`incident replay: unresolvable ${selected === 'composed' ? 'composed but unchecked' : selected ? 'selected' : 'queued'} A fails alone after checkpoint B and new land`, async t => {
    const f = await fixture(t, { remote: false });
    const a = await f.candidate('incident.txt', 'head A\n');
    const peer = selected ? await f.candidate('peer.txt') : undefined;
    if (selected) {
      const batch = await batchEdit(f.work, 'select', data => selectBatch(f.work, data, 'main'));
      if (selected === 'composed') await composeBatch(f.work, batch);
    }
    const b = await changeHead(f, a);
    // Head movement alone must preserve a saved Candidate. Model a retained
    // input that cannot be resolved, without removing B's source ancestry.
    await batchEdit(f.work, 'unresolvable-input', data => {
      data.views.find(view => view.id === a.view.id).inputs[0].head = 'f'.repeat(64);
    });
    const operationId = randomUUID();
    await f.agent.dispatch({ action: 'land', operationId, laneIds: [a.lane.laneId], wait: false });
    const childId = read(journalPath(f, 'land', operationId)).entries[0].command.operationId;
    await drive(f, async () => {
      await until(f, () => f.store.select('landingEntries', childId)?.status === 'accepted', 'B lands');
      const stale = f.store.select('landingEntries', a.command.operationId);
      assert.equal(stale.status, 'interrupted');
      assert.equal(stale.error.code, 'LANE_STALE');
      assert.match(stale.reason, /resubmit at current head/i);
      assert.equal(submissionOutcome(queuedOutcome(f.store, stale)).cause, 'stale-head');
      assert.equal(f.content('incident.txt'), 'head B\n');
      assert.equal(f.store.select('lanes', a.lane.laneId).head, b.head);
      if (peer) {
        assert.equal(f.store.select('landingEntries', peer.command.operationId).status, 'accepted');
        assert.equal(f.content('peer.txt'), 'peer.txt\n');
      }
      assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, peer ? 2 : 1);
      assert.notEqual(readPendingStatus(f.store).landingWorker.status, 'error');
    });
  });

for (const remote of [false, true])
  test(`startup reconciles a running ${remote ? 'remote' : 'local'} check with a dead controller`, async t => {
    const f = await fixture(t, { remote });
    const obsolete = await f.candidate('obsolete.txt', 'obsolete input\n', false);
    await f.agent.dispatch({ ...obsolete.command, wait: false });
    await changeHead(f, obsolete);
    const run = await orphanRun(f);
    await drive(f, async () => {
      await until(
        f,
        () =>
          ['passed', 'interrupted'].includes(f.store.select('runs', run.id)?.status) &&
          read(journalPath(f, 'finish', obsolete.command.operationId)).result?.status === 'interrupted',
        'orphan reconciles',
      );
      const recovered = f.store.select('runs', run.id);
      assert.equal(recovered.status, remote ? 'passed' : 'interrupted');
      assert.ok(recovered.endedAt);
      assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 1);
      assert.equal(recovered.id, run.id);
    });
  });

for (const backend of ['modal', 'github-actions'])
  test(`failed ${backend} adoption ends the original run instead of retaining a live orphan owner`, async t => {
    const f = await fixture(t, { remote: true });
    const run = await orphanRun(f, backend);
    let starts = 0;
    await adoptModalRun(f.store, run.id, async () => {
      starts++;
      throw new Error('synthetic private transport details');
    });
    const recovered = f.store.select('runs', run.id);
    assert.equal(starts, 1);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.error.code, 'CHECK_RECOVERY_FAILED');
    assert.ok(recovered.endedAt);
    const receipt = read(join(f.store.directory, `check-${run.id}`, 'result.json'));
    assert.equal(receipt.status, 'interrupted');
    assert.doesNotMatch(JSON.stringify(receipt), /synthetic private transport/);
    await adoptModalRun(f.store, run.id, async () => assert.fail('terminal run must not restart'));
    assert.equal(f.store.load().runs.length, 1);
  });

for (const failure of ['spawn', 'bootstrap'])
  test(`a detached ${failure} failure ends its claimed run with a durable receipt`, async t => {
    const f = await fixture(t, { remote: true });
    const run = await orphanRun(f, 'modal');
    const spawn = childProcess.spawn;
    const mocked = t.mock.method(childProcess, 'spawn', function (executable, args, options) {
      if (!args[0]?.endsWith('/check-controller-worker.js')) return spawn(executable, args, options);
      const child = Object.assign(new EventEmitter(), { unref() {} });
      queueMicrotask(() => {
        if (failure === 'spawn') child.emit('error', new Error('synthetic spawn failure'));
        else {
          child.emit('spawn');
          setImmediate(() => child.emit('exit', 1));
        }
      });
      return child;
    });
    syncBuiltinESMExports();
    try {
      await adoptModalRun(f.store, run.id);
      await until(
        f,
        () => f.store.select('runs', run.id)?.status === 'interrupted',
        'startup failure settles',
      );
      const ended = f.store.select('runs', run.id);
      assert.equal(ended.status, 'interrupted');
      assert.equal(ended.error.code, 'CHECK_RECOVERY_FAILED');
      assert.equal(read(join(f.store.directory, `check-${run.id}`, 'result.json')).status, 'interrupted');
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  });

test('a worker error names its Lane and operation and an explicit wake retries the same revision', async t => {
  const f = await fixture(t, { remote: false });
  const input = await f.candidate('incident.txt', 'input\n', false);
  await f.agent.dispatch({ ...input.command, wait: false });
  const dispatch = AgentWorkflow.prototype.dispatch;
  let failed = false;
  t.mock.method(AgentWorkflow.prototype, 'dispatch', function (command, ...args) {
    if (command.operationId === input.command.operationId && !failed) {
      failed = true;
      throw new ForgeError('SYNTHETIC_WORKER_ERROR', 'Synthetic worker observation failure');
    }
    return dispatch.call(this, command, ...args);
  });
  await drive(f, async () => {
    await until(
      f,
      () => readPendingStatus(f.store).landingWorker.status === 'error',
      'worker error recorded',
    );
    const status = readPendingStatus(f.store);
    assert.equal(status.landingWorker.code, 'SYNTHETIC_WORKER_ERROR');
    assert.equal(status.landingWorker.affected.operationId, input.command.operationId);
    assert.deepEqual(status.landingWorker.affected.laneIds, [input.lane.laneId]);
    const text = formatPendingStatus(status);
    assert.ok(text.includes(input.command.operationId));
    assert.ok(text.includes(input.lane.laneId));
    const revision = f.store.revision();
    notifyAutoExchange(landingWorkerStates(f.store)[0].endpoint);
    await until(
      f,
      () => f.store.select('landingEntries', input.command.operationId)?.status === 'accepted',
      'same revision retries',
    );
    assert.ok(f.store.revision() > revision);
  });
});

test('failed-replay teardown ends a wedged synthetic controller without recovery respawning it', async t => {
  const f = await fixture(t, { remote: true });
  const run = await orphanRun(f, 'modal');
  const script = join(f.store.directory, 'wedged-controller.mjs');
  writeFileSync(
    script,
    `import {WorkStore} from ${JSON.stringify(moduleUrl('work-store'))};
import {runCheckController} from ${JSON.stringify(moduleUrl('check-controller'))};
setInterval(()=>{},60000);
await runCheckController(new WorkStore(process.argv[2]),process.argv[3],()=>new Promise(()=>{}));`,
  );
  const spawn = childProcess.spawn;
  const mocked = t.mock.method(childProcess, 'spawn', (executable, args, options) =>
    spawn(
      executable,
      args[0]?.endsWith('/check-controller-worker.js') ? [script, ...args.slice(1)] : args,
      options,
    ),
  );
  syncBuiltinESMExports();
  try {
    await adoptModalRun(f.store, run.id);
    await until(
      f,
      () => {
        const current = f.store.select('runs', run.id);
        return current.runner.pid !== process.pid && processAlive(current.runner);
      },
      'wedged controller claimed the run',
    );
    const identity = f.store.select('runs', run.id).runner;
    await stopOwnerCheckControllers(f.root);
    await until(f, () => !processAlive(identity), 'wedged synthetic controller stopped');
    assert.equal(f.store.select('runs', run.id).status, 'interrupted');
    assert.equal(f.store.select('runs', run.id).error.code, 'SYNTHETIC_TEST_TEARDOWN');
    assert.equal(read(join(f.store.directory, `check-${run.id}`, 'result.json')).status, 'interrupted');
    assert.equal(f.store.load().runs.length, 1);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('a batch error identifies the actual batch, input Lanes and reserved run', async t => {
  const f = await fixture(t, { remote: false });
  const input = await f.candidate('incident.txt');
  const dispatch = WorkService.prototype.dispatch;
  t.mock.method(WorkService.prototype, 'dispatch', function (command, ...args) {
    if (this.store.root === f.store.root && command.action === 'run-check')
      throw new ForgeError('SYNTHETIC_BATCH_ERROR', 'Synthetic batch failure');
    return dispatch.call(this, command, ...args);
  });
  await drive(f, async () => {
    await until(
      f,
      () => readPendingStatus(f.store).landingWorker.code === 'SYNTHETIC_BATCH_ERROR',
      'batch error recorded',
    );
    const status = readPendingStatus(f.store),
      batch = f.store.load().landingBatches[0];
    assert.equal(status.landingWorker.affected.operationId, batch.id);
    assert.deepEqual(status.landingWorker.affected.laneIds, [input.lane.laneId]);
    assert.equal(status.landingWorker.affected.runId, batch.prefixes[0].runId);
  });
});

for (const kind of ['finish', 'land', 'legacy-land'])
  test(`incident recovery settles stale ${kind} journal and continues to the new request`, async t => {
    const f = await fixture(t, { remote: false });
    const a = await f.candidate('incident.txt', 'head A\n', false);
    const operationId = randomUUID();
    await f.agent.dispatch(
      kind === 'finish'
        ? { ...a.command, operationId, wait: false }
        : { action: 'land', operationId, laneIds: [a.lane.laneId], wait: false },
    );
    const path = journalPath(f, kind === 'finish' ? 'finish' : 'land', operationId);
    if (kind === 'legacy-land') {
      const old = read(path);
      delete old.command;
      writeFileSync(path, JSON.stringify(old));
    }
    await changeHead(f, a);
    const fresh = randomUUID();
    await f.agent.dispatch({ action: 'land', operationId: fresh, laneIds: [a.lane.laneId], wait: false });
    const childId = read(journalPath(f, 'land', fresh)).entries[0].command.operationId;
    await drive(f, async () => {
      await until(
        f,
        () => f.store.select('landingEntries', childId)?.status === 'accepted',
        'new request lands',
      );
      await until(
        f,
        () => {
          const state = read(path);
          return kind === 'finish' ? state.result : state.entries[0].result;
        },
        'stale journal settles',
      );
      const state = read(path),
        result = kind === 'finish' ? state.result : state.entries[0].result;
      assert.equal(result.code, 'LANE_STALE');
      assert.match(result.message, /resubmit at current head/i);
      assert.equal(f.content('incident.txt'), 'head B\n');
      assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 1);
      assert.notEqual(readPendingStatus(f.store).landingWorker.status, 'error');
    });
  });

test(
  'a read-only short-lived MCP connection never registers or drives a landing worker',
  readOnlyMcpLifetime,
);

test('incident replay: CLI exits at Actions Pinned/not-sent while the leased controller keeps running', t =>
  replayActionsLifetime(t, drive));

test('an in-process controller lease permits independent Lane start and checkpoint publication', async t => {
  const f = await fixture(t, { remote: false });
  const run = await orphanRun(f);
  f.store.locked(() => {
    const tx = f.store.records(),
      selected = tx.find('runs', run.id);
    selected.record.status = 'queued';
    tx.replace('runs', selected.position, selected.record);
    f.store.commitRecords(tx);
  });
  mkdirSync(join(f.store.directory, `check-${run.id}`), { recursive: true });
  writeFileSync(
    join(f.store.directory, `check-${run.id}`, 'controller-request.json'),
    JSON.stringify({
      schema: 1,
      id: run.id,
      head: run.head,
      viewId: run.viewId,
      definition: run.check.definition,
      environment: run.environment.fingerprint,
      runner: run.runner,
    }),
  );
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let executions = 0;
  const controller = runCheckController(f.store, run.id, async () => {
    executions++;
    entered.resolve();
    await release.promise;
    f.store.locked(() => {
      const tx = f.store.records(),
        selected = tx.find('runs', run.id);
      selected.record.status = 'interrupted';
      selected.record.endedAt = new Date().toISOString();
      tx.replace('runs', selected.position, selected.record);
      f.store.commitRecords(tx);
    });
  });
  // Propagate startup failures rather than hanging on an unclaimed lease.
  await Promise.race([
    entered.promise,
    controller.then(() => {
      throw Error('Controller never claimed');
    }),
  ]);
  try {
    const sibling = (await f.agent.dispatch({ action: 'start', outcome: 'Concurrent Lane', lockWaitMs: 0 }))
      .result;
    writeFileSync(join(sibling.path, 'independent.txt'), 'independent\n');
    const saved = (
      await f.agent.dispatch({
        action: 'checkpoint',
        laneId: sibling.laneId,
        message: 'Concurrent save',
        lockWaitMs: 0,
      })
    ).result;
    assert.notEqual(saved.head, sibling.head);
    const duplicate = await runCheckController(f.store, run.id, async () => {
      executions++;
    });
    assert.ok(duplicate.waiting);
    assert.equal(executions, 1);
  } finally {
    release.resolve();
    await controller;
  }
});
