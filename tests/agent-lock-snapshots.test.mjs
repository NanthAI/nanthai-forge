import { trainAccounting } from '../dist/train-accounting.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { WorkRecordTransaction } from '../dist/work-record-transaction.js';
import { agentCostSummary } from '../dist/agent-cost-summary.js';
import { modalMonthCost } from '../dist/check-backend.js';
import { runnerMonthCosts, localCost } from '../dist/check-cost.js';
import { checkEnvironment } from '../dist/work-run.js';
import { trustAgents } from './autonomy-fixture.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-agent-snapshot-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.txt'), 'a\n');
  writeFileSync(join(root, 'b.txt'), 'b\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Synthetic contention' })).result;
  publishMain(store, lane.head);
  return { root, agent, store, lane, peer: new WorkStore(root) };
}
function publishMain(store, head) {
  store.locked(() => {
    const tx = store.records();
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head,
      previous: tx.all('channelMoves', 'main', 'channel').at(-1)?.head ?? null,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    store.commitRecords(tx);
  });
}
function advance(peer, laneId) {
  peer.locked(() => {
    const tx = peer.records();
    tx.patchFields('lanes', laneId, { concurrentExtension: 'retained' });
    peer.commitRecords(tx);
  });
}
async function until(predicate) {
  const end = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < end, 'synthetic child did not reach its barrier');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('all agent observations return while another process holds the owner writer lock', async t => {
  const { root, agent, store, lane } = await fixture(t);
  const ready = join(root, 'holder-ready'),
    release = join(root, 'holder-release');
  const script = `import {WorkStore} from ${JSON.stringify(new URL('../dist/work-store.js', import.meta.url).href)};
    import {writeFileSync,existsSync} from 'node:fs';
    new WorkStore(${JSON.stringify(root)}).locked(()=>{
      writeFileSync(${JSON.stringify(ready)},'ready');
      const end=Date.now()+15000;
      while(!existsSync(${JSON.stringify(release)})&&Date.now()<end)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
    },{operation:'synthetic landing check',actor:'test holder'});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(() => child.kill());
  await until(() => existsSync(ready));
  const revision = store.revision(),
    begin = performance.now();
  try {
    const commands = [
      { action: 'status' },
      { action: 'status', laneId: lane.laneId, detail: true },
      { action: 'tests', laneId: lane.laneId },
      { action: 'peers', laneId: lane.laneId },
      { action: 'review', kind: 'lane', id: lane.laneId, expectedHead: lane.head },
      { action: 'diff', laneId: lane.laneId },
      { action: 'show', laneId: lane.laneId, path: 'a.txt' },
      { action: 'brief', situation: 'continue-lane', laneId: lane.laneId },
    ];
    for (const command of commands) {
      const result = await agent.dispatch(command);
      assert.equal(result.revision, revision, command.action);
      assert.ok(existsSync(join(store.directory, 'lock')), command.action);
    }
    assert.ok(performance.now() - begin < 10000, 'observations finish before holder fallback release');
    assert.equal(store.revision(), revision, 'observations do not reconcile or mutate Work');
  } finally {
    writeFileSync(release, 'release');
    assert.equal(await exited, 0);
  }
});

test('one observation pins records, pages, policy and receipt revision across an async concurrent commit', async t => {
  const { store, peer, lane } = await fixture(t);
  const revision = store.revision();
  await store.observing(async () => {
    const tx = store.readRecords();
    advance(peer, lane.laneId);
    await Promise.resolve();
    assert.equal(store.revision(), revision);
    assert.equal(store.load().revision, revision);
    assert.equal(store.page('lanes').revision, revision);
    assert.equal(store.select('lanes', lane.laneId).concurrentExtension, undefined);
    assert.equal(tx.find('lanes', lane.laneId).record.concurrentExtension, undefined);
    assert.equal(store.readRecords().revision, revision);
  });
  assert.equal(store.revision(), revision + 1);
  assert.equal(store.select('lanes', lane.laneId).concurrentExtension, 'retained');
});

function racePublication(t, store, peer, laneId, operation) {
  const locked = store.locked.bind(store);
  let raced = false;
  t.mock.method(store, 'locked', (run, options) => {
    if (!raced && options?.operation === operation) {
      raced = true;
      advance(peer, laneId);
    }
    return locked(run, options);
  });
  return () => assert.ok(raced, 'publication CAS was raced');
}

test('start CAS retries metadata and materializes once outside the owner lock', async t => {
  const { agent, store, peer, lane } = await fixture(t);
  const checkRace = racePublication(t, store, peer, lane.laneId, 'start reservation');
  const materialize = NativeSource.prototype.materialize;
  let copies = 0;
  t.mock.method(NativeSource.prototype, 'materialize', function (...args) {
    assert.equal(existsSync(join(store.directory, 'lock')), false);
    copies++;
    return materialize.apply(this, args);
  });
  const result = await agent.dispatch({ action: 'start', outcome: 'Prepared start', lockWaitMs: 3000 });
  checkRace();
  assert.equal(copies, 1);
  assert.equal(store.select('lanes', result.result.laneId).state, 'active');
  assert.equal(store.select('lanes', lane.laneId).concurrentExtension, 'retained');
});

test('checkpoint CAS retries metadata without repeating capture or dropping a concurrent update', async t => {
  const { agent, store, peer, lane } = await fixture(t);
  writeFileSync(join(lane.path, 'b.txt'), 'changed b\n');
  const checkRace = racePublication(t, store, peer, lane.laneId, 'checkpoint publication');
  const capture = NativeSource.prototype.captureReport;
  let captures = 0;
  t.mock.method(NativeSource.prototype, 'captureReport', function (...args) {
    assert.equal(existsSync(join(store.directory, 'lock')), false);
    captures++;
    return capture.apply(this, args);
  });
  const result = await agent.dispatch({
    action: 'checkpoint',
    laneId: lane.laneId,
    message: 'Prepared',
    lockWaitMs: 3000,
  });
  checkRace();
  assert.equal(captures, 1);
  assert.equal(store.select('lanes', lane.laneId).head, result.result.head);
  assert.equal(store.select('lanes', lane.laneId).concurrentExtension, 'retained');
});

test('sync CAS retries metadata without repeating merge, byte reads or workspace application under the lock', async t => {
  const { root, agent, store, peer, lane } = await fixture(t);
  const source = new NativeSource(root),
    files = source.state(lane.head).files;
  const target = source.writeState(
    files.map(file =>
      file.path === 'a.txt' ? { ...file, blob: source.put(Buffer.from('main a\n')) } : file,
    ),
    [lane.head],
    'Synthetic main',
    new Date().toISOString(),
  );
  publishMain(store, target);
  const checkRace = racePublication(t, store, peer, lane.laneId, 'sync publication');
  const compose = NativeSource.prototype.compose,
    object = NativeSource.prototype.object;
  let merges = 0,
    lockedReads = 0;
  t.mock.method(NativeSource.prototype, 'compose', function (...args) {
    merges++;
    assert.equal(existsSync(join(store.directory, 'lock')), false);
    return compose.apply(this, args);
  });
  t.mock.method(NativeSource.prototype, 'object', function (...args) {
    if (existsSync(join(store.directory, 'lock'))) lockedReads++;
    return object.apply(this, args);
  });
  const result = await agent.dispatch({ action: 'sync', laneId: lane.laneId, lockWaitMs: 3000 });
  checkRace();
  assert.equal(merges, 1);
  assert.equal(lockedReads, 0, 'including lifecycle activity preparation');
  assert.equal(result.result.status, 'merged');
  assert.equal(readFileSync(join(lane.path, 'a.txt'), 'utf8'), 'main a\n');
  assert.equal(store.select('lanes', lane.laneId).head, result.result.head);
  assert.equal(store.select('lanes', lane.laneId).concurrentExtension, 'retained');
});

test('exact cost summaries reuse unchanged immutable run pages across Work revisions', async t => {
  const { root, store, peer, lane } = await fixture(t);
  const now = new Date(),
    runs = Array.from({ length: 257 }, () => {
      const id = randomUUID();
      return {
        id,
        viewId: randomUUID(),
        head: lane.head,
        base: lane.head,
        inputs: [],
        dependencies: [],
        check: {
          id: randomUUID(),
          name: 'Fixture',
          executable: process.execPath,
          args: [],
          environmentLabel: 'Fixture',
          definition: 'a'.repeat(64),
          at: now.toISOString(),
        },
        environment: checkEnvironment(),
        status: 'passed',
        startedAt: now.toISOString(),
        runner: { pid: process.pid, host: hostname() },
        details: 'Synthetic run',
        backend: { requested: 'local', actual: 'local', cost: localCost(id) },
      };
    });
  store.locked(() => {
    const tx = store.records();
    for (const run of runs) tx.append('runs', run);
    store.commitRecords(tx);
  });
  const at = WorkRecordTransaction.prototype.at;
  let reads = 0;
  t.mock.method(WorkRecordTransaction.prototype, 'at', function (collection, ...args) {
    if (collection === 'runs') reads++;
    return at.call(this, collection, ...args);
  });
  const { submissions, ...train } = trainAccounting(runs);
  void submissions;
  const expected = { modalCost: modalMonthCost(runs, now), checkCosts: { ...runnerMonthCosts(runs), train } };
  assert.deepEqual(agentCostSummary(root, store.readRecords(), now), expected);
  assert.equal(reads, 257);
  reads = 0;
  advance(peer, lane.laneId);
  assert.deepEqual(agentCostSummary(root, store.readRecords(), now), expected);
  assert.equal(reads, 0);
  store.locked(() => {
    const tx = store.records();
    tx.append('runs', { ...runs[0], id: randomUUID() });
    store.commitRecords(tx);
  });
  agentCostSummary(root, store.readRecords(), now);
  assert.equal(reads, 2, 'only the changed tail page is hydrated');
});

test('start, checkpoint and sync commit while a long check remains running', async t => {
  const { root, agent, store, lane } = await fixture(t);
  trustAgents(root);
  const ready = join(root, 'check-ready'),
    release = join(root, 'check-release');
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: [
      '-e',
      `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer)}},20);setTimeout(()=>process.exit(1),15000).unref()`,
    ],
  });
  writeFileSync(join(lane.path, 'a.txt'), 'finishing a\n');
  const finishing = agent.dispatch({
    action: 'finish',
    laneId: lane.laneId,
    message: 'Long synthetic check',
  });
  try {
    await until(() => existsSync(ready));
    assert.equal(existsSync(join(store.directory, 'lock')), false);
    const begin = performance.now();
    const timings = {};
    let step = begin;
    const other = (await agent.dispatch({ action: 'start', outcome: 'Independent writer', lockWaitMs: 2000 }))
      .result;
    timings.startMs = Math.round(performance.now() - step);
    writeFileSync(join(other.path, 'b.txt'), 'other b\n');
    step = performance.now();
    await agent.dispatch({
      action: 'checkpoint',
      laneId: other.laneId,
      message: 'Other writer',
      lockWaitMs: 2000,
    });
    timings.checkpointMs = Math.round(performance.now() - step);
    const source = new NativeSource(root);
    const target = source.writeState(
      source
        .state(lane.head)
        .files.map(file =>
          file.path === 'a.txt' ? { ...file, blob: source.put(Buffer.from('independent main a\n')) } : file,
        ),
      [lane.head],
      'Main advanced during check',
      new Date().toISOString(),
    );
    publishMain(store, target);
    step = performance.now();
    const synced = await agent.dispatch({ action: 'sync', laneId: other.laneId, lockWaitMs: 2000 });
    assert.equal(synced.result.status, 'merged');
    timings.syncMs = Math.round(performance.now() - step);
    t.diagnostic(`writers during long check: ${JSON.stringify(timings)}`);
    assert.ok(performance.now() - begin < 10000);
    assert.ok(store.load().runs.some(run => run.status === 'running'));
  } finally {
    writeFileSync(release, 'release');
    const result = await finishing;
    assert.equal(result.result.run.status, 'passed');
  }
});
