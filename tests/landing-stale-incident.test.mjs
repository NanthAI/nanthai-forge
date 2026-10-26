// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
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
import { WorkStore } from '../dist/work-store.js';
import { ForgeError } from '../dist/errors.js';
import { landingWorkerStates } from '../dist/landing-worker-status.js';
import { formatPendingStatus } from '../dist/pending-status-format.js';
import { notifyAutoExchange } from '../dist/auto-exchange-notify.js';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { processAlive } from '../dist/local-process.js';
import { runCheckController } from '../dist/check-controller.js';
import { finishChild } from '../dist/finish-child.js';

const read = path => JSON.parse(readFileSync(path));
const journalPath = (f, kind, operationId) => join(f.store.directory, `agent-${kind}`, `${operationId}.json`);
const moduleUrl = name => new URL(`../dist/${name}.js`, import.meta.url).href;
const fixture = (t, options) => createFixture(t, { ...options, stopChecks: true });
async function orphanRun(f, backend, passedTwin = false) {
  const input = await f.candidate('incident.txt', 'retained input\n');
  if (passedTwin) await f.checkCandidates([input]);
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
    expectedEnvironment: batch.environment.fingerprint,
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
  test(`a newer save supersedes the outstanding desired head in the resolvable ${selected === 'composed' ? 'composed but unchecked' : selected ? 'selected' : 'queued'} Candidate`, async t => {
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
        () =>
          f.store.select('landingEntries', a.command.operationId)?.error?.code === 'LANDING_SUPERSEDED' &&
          f.store.select('landingEntries', peer.command.operationId)?.status === 'accepted',
        'old goal supersedes and peer lands',
      );
      const entry = f.store.select('landingEntries', a.command.operationId);
      assert.equal(entry.head, a.view.head);
      assert.deepEqual(f.store.select('views', entry.viewId).inputs, a.view.inputs);
      assert.notEqual(f.content('incident.txt'), 'head A\n');
      assert.match(entry.reason, new RegExp(b.head));
      assert.equal(f.store.select('lanes', a.lane.laneId).head, b.head);
      assert.equal(f.store.select('landingEntries', peer.command.operationId).status, 'accepted');
      assert.equal(f.content('peer.txt'), 'peer.txt\n');
      const checked = f.store.load().runs.filter(run => !run.mainCheck);
      assert.equal(checked.length, 1, 'the superseded goal never consumes a check');
      assert.deepEqual(f.store.select('views', checked[0].viewId).inputs, peer.view.inputs);
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
      // Retiring A, landing its valid peer, checking B and publishing B are
      // separate controller transitions. Keep the existing bound on each;
      // a single end-to-end deadline also counts unrelated source preparation.
      await until(
        f,
        () => f.store.select('landingEntries', a.command.operationId)?.status === 'interrupted',
        'A retires',
      );
      if (peer)
        await until(
          f,
          () => f.store.select('landingEntries', peer.command.operationId)?.status === 'accepted',
          'peer lands',
        );
      await until(
        f,
        () => {
          const entry = f.store.select('landingEntries', childId);
          const batch = entry?.batchId && f.store.select('landingBatches', entry.batchId);
          const runId = entry?.runId ?? batch?.prefixes.at(-1)?.runId;
          return (
            entry?.status === 'accepted' || (runId && f.store.select('runs', runId)?.status === 'passed')
          );
        },
        'B exact check passes',
      );
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
      assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, peer ? 3 : 1);
      assert.notEqual(readPendingStatus(f.store).landingWorker.status, 'error');
    });
  });

for (const { remote, passedTwin } of [
  { remote: false, passedTwin: false },
  { remote: true, passedTwin: false },
  { remote: false, passedTwin: true },
])
  test(`startup reconciles a running ${remote ? 'remote' : 'local'} check with a dead controller${passedTwin ? ' and a passed twin' : ''}`, async t => {
    const f = await fixture(t, { remote });
    const obsolete = await f.candidate('obsolete.txt', 'obsolete input\n', false);
    await f.agent.dispatch({ ...obsolete.command, wait: false });
    await changeHead(f, obsolete);
    const run = await orphanRun(f, undefined, passedTwin);
    const entryIds = f.store
      .load()
      .landingEntries.map(entry => entry.id)
      .sort();
    const entry = f.store.load().landingEntries.find(entry => entry.id !== obsolete.command.operationId);
    const passed = f.store.load().runs.find(run => run.status === 'passed');
    if (passedTwin) assert.ok(passed?.reuseKey, 'seed eligible passed evidence');
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
      assert.equal(recovered.id, run.id);
      for (const pin of ['viewId', 'head', 'base', 'inputs', 'dependencies', 'check', 'environment'])
        assert.deepEqual(recovered[pin], run[pin], `original ${pin} retained`);
      await until(
        f,
        () => f.store.select('landingEntries', entry.id)?.status === 'accepted',
        'original entry lands without resubmission',
      );
      const settled = f.store.select('landingEntries', entry.id);
      assert.deepEqual(
        f.store
          .load()
          .landingEntries.map(entry => entry.id)
          .sort(),
        entryIds,
        'no replacement submission',
      );
      for (const pin of [
        'id',
        'request',
        'viewId',
        'head',
        'channel',
        'checkId',
        'definition',
        'environment',
      ])
        assert.deepEqual(settled[pin], entry[pin], `original entry ${pin} retained`);
      assert.deepEqual(f.store.select('runs', run.id), recovered, 'terminal original run stays immutable');
      const runs = f.store.load().runs.filter(run => !run.mainCheck);
      const replacementId = finishChild(run.id, passedTwin ? 'passed-twin' : 'controller-recovery');
      const expectedIds = remote ? [run.id] : [run.id, replacementId, ...(passed ? [passed.id] : [])];
      assert.deepEqual(runs.map(run => run.id).sort(), expectedIds.sort(), 'exactly the intended runs');
      if (!remote) {
        const replacement = f.store.select('runs', replacementId);
        assert.equal(replacement.status, 'passed');
        assert.equal(replacement.viewId, run.viewId);
        assert.equal(replacement.head, run.head);
        assert.equal(settled.runId, replacement.id);
        if (passedTwin) {
          assert.equal(replacement.reusedFrom.runId, passed.id);
          assert.deepEqual(f.store.select('runs', passed.id), passed, 'passed twin stays immutable');
          assert.equal(f.store.select('runs', finishChild(run.id, 'controller-recovery')), undefined);
          assert.equal(settled.infrastructureRetries?.length ?? 0, 0, 'reuse precedes controller recovery');
        } else {
          assert.equal(replacement.reusedFrom, undefined, 'one replacement execution');
          assert.deepEqual(
            settled.infrastructureRetries.map(retry => retry.runId),
            [run.id],
          );
        }
      }
      assert.equal(f.content('incident.txt'), 'retained input\n');
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

test('a worker error names its Lane and operation and retries the same revision without a wake', async t => {
  const f = await fixture(t, { remote: false });
  const input = await f.candidate('incident.txt', 'input\n', false);
  await f.agent.dispatch({ ...input.command, wait: false });
  let snapshot;
  const log = console.log;
  t.mock.method(console, 'log', (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('landing-worker-error')) {
      const line = JSON.parse(args[0]);
      if (line.code === 'SYNTHETIC_WORKER_ERROR') snapshot = readPendingStatus(f.store);
    } else log(...args);
  });
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
    await until(f, () => snapshot, 'worker error recorded');
    const status = snapshot;
    assert.equal(status.landingWorker.code, 'SYNTHETIC_WORKER_ERROR');
    assert.equal(status.landingWorker.affected.operationId, input.command.operationId);
    assert.deepEqual(status.landingWorker.affected.laneIds, [input.lane.laneId]);
    const text = formatPendingStatus(status);
    assert.ok(text.includes(input.command.operationId));
    assert.ok(text.includes(input.lane.laneId));
    const revision = f.store.revision();
    await until(
      f,
      () => f.store.select('landingEntries', input.command.operationId)?.status === 'accepted',
      'same revision retries',
    );
    assert.ok(f.store.revision() > revision);
  });
});

test('incident replay: settlement WORK_STALE retries itself and a later land reaches terminal without a restart', async t => {
  const f = await fixture(t, { remote: false });
  const first = await f.candidate('settlement-first.txt');
  const second = await f.candidate('settlement-second.txt', undefined, false);
  const lines = [];
  const log = console.log;
  t.mock.method(console, 'log', (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('landing-worker-error')) {
      const line = JSON.parse(args[0]);
      lines.push(line);
    } else log(...args);
  });
  const select = WorkStore.prototype.select;
  const owner = realpathSync(f.root);
  let injected = false;
  t.mock.method(WorkStore.prototype, 'select', function (collection, ...args) {
    const record = select.call(this, collection, ...args);
    // The next state-machine step observes evaluated settlement outside the
    // acceptance publication's own revision-retry loop.
    if (
      collection === 'landingBatches' &&
      record?.status === 'checking' &&
      record.settlement?.passingViewId &&
      !injected &&
      this !== f.store &&
      realpathSync(this.root) === owner
    ) {
      injected = true;
      throw new ForgeError('WORK_STALE', 'Synthetic settlement revision race');
    }
    return record;
  });
  await drive(f, async () => {
    const line = await until(
      f,
      () => lines.find(line => line.code === 'WORK_STALE'),
      'settlement error logged',
    );
    const batch = f.store.load().landingBatches[0];
    const state = landingWorkerStates(f.store)[0];
    const originalRun = f.store.select('runs', batch.prefixes[0].runId);
    assert.equal(originalRun.status, 'passed');
    assert.equal(line.operationId, batch.id);
    assert.equal(line.runId, originalRun.id);
    assert.deepEqual(line.laneIds, [first.lane.laneId]);
    const operationId = randomUUID();
    const submitted = await f.agent.dispatch({
      action: 'land',
      operationId,
      laneIds: [second.lane.laneId],
      wait: false,
    });
    assert.equal(submitted.result.durable, true);
    const secondId = read(journalPath(f, 'land', operationId)).entries[0].command.operationId;
    await until(
      f,
      () => f.store.select('landingEntries', first.command.operationId)?.status === 'accepted',
      'retained checked goal lands',
    );
    await until(
      f,
      () => f.store.select('landingEntries', secondId)?.status === 'accepted',
      'new desired goal lands',
    );
    const after = landingWorkerStates(f.store)[0];
    assert.equal(after.id, state.id, 'same worker recovers without a restart');
    assert.equal(lines.filter(line => line.code === 'WORK_STALE').length, 1, 'one owner-log line per error');
    assert.equal(f.store.select('landingEntries', first.command.operationId).runId, originalRun.id);
    assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 2);
    assert.equal(f.store.load().channelMoves.filter(move => move.status === 'accepted').length, 2);
    assert.equal(f.content('settlement-first.txt'), 'settlement-first.txt\n');
    assert.equal(f.content('settlement-second.txt'), 'settlement-second.txt\n');
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
      assert.equal(result.code, kind === 'land' ? 'LANDING_SUPERSEDED' : 'LANE_STALE');
      assert.match(
        result.message,
        kind === 'land' ? /Desired head superseded by Lane/ : /resubmit at current head/i,
      );
      if (kind === 'land') assert.ok(result.message.includes(f.store.select('lanes', a.lane.laneId).head));
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
