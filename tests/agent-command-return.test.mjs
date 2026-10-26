// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkStore } from '../dist/work-store.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { agentAdvisoryTestHooks } from '../dist/agent-advisory-worker.js';
import { readSelfMetricReceipts } from '../dist/self-metrics-journal.js';

function fixture(t, files = { 'file.txt': 'initial\n' }) {
  const root = mkdtempSync(join(tmpdir(), 'forge-command-return-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  initNative(root);
  return { root, agent: new AgentWorkflow(root) };
}

test('start and checkpoint return after durable publication before advisory work, even if it never completes', async t => {
  const { agent } = fixture(t);
  const store = agent.work.store;
  const published = [];
  let advisoryStarted = false;
  const deferred = [];
  let spawned = 0;
  const commit = store.commitRecords.bind(store);
  store.commitRecords = (tx, revision, options) => {
    assert.equal(options?.advisory, false, 'preview and indexing must not run inside the commit');
    const result = commit(tx, revision, options);
    published.push(tx.revision);
    return result;
  };
  const originalLaunch = agentAdvisoryTestHooks.launch;
  t.after(() => {
    agentAdvisoryTestHooks.launch = originalLaunch;
  });
  agentAdvisoryTestHooks.launch = (_executable, args, options) => {
    spawned++;
    assert.ok(published.length, 'a worker may only be scheduled after a durable publication');
    assert.equal(options.detached, true);
    assert.equal(options.stdio, 'ignore');
    assert.ok(!options.env.NODE_OPTIONS);
    assert.ok(args[0].endsWith('/agent-advisory-worker.js'));
    const child = new EventEmitter();
    child.unref = () => {};
    // Represents a worker which never responds. No callback is invoked here.
    deferred.push(() => {
      advisoryStarted = true;
      return new Promise(() => {});
    });
    return child;
  };
  const start = await agent.dispatch({
    action: 'start',
    operationId: randomUUID(),
    outcome: 'Durable start',
  });
  assert.equal(start.result.state, 'active');
  assert.ok(existsSync(join(start.result.path, 'file.txt')));
  assert.equal(
    start.result.peers.coverage,
    'local-incomplete',
    'indexed advice never claims live completeness',
  );
  assert.equal(spawned, 1);
  // Any attempt to re-enter the owner lock after saving must fail this test.
  const locked = WorkStore.prototype.locked;
  t.after(() => {
    WorkStore.prototype.locked = locked;
  });
  let checkpointCommitted = false;
  WorkStore.prototype.locked = function (run, options) {
    assert.equal(
      checkpointCommitted,
      false,
      'no owner lock waits after the save commits, including transport',
    );
    return locked.call(this, run, options);
  };
  const prepare = store.prepareCommitRecords.bind(store);
  let checkpointPrepared = false;
  store.prepareCommitRecords = (...args) => {
    assert.equal(existsSync(join(store.directory, 'lock')), false, 'prepare before writer admission');
    checkpointPrepared = true;
    return prepare(...args);
  };
  store.commitRecords = (...args) => {
    assert.ok(checkpointPrepared, 'the checkpoint must stage its immutable records before publication');
    assert.deepEqual(args[2], { prepared: true, advisory: false });
    const revision = commit(...args);
    checkpointCommitted = true;
    return revision;
  };
  writeFileSync(join(start.result.path, 'file.txt'), 'saved\n');
  const saved = await agent.dispatch({
    action: 'checkpoint',
    laneId: start.result.laneId,
    message: 'Durable save',
  });
  assert.ok(checkpointCommitted);
  assert.equal(saved.result.parent, start.result.head);
  assert.notEqual(saved.result.head, start.result.head);
  assert.equal(spawned, 2);
  assert.equal(advisoryStarted, false);
  deferred[0]();
  assert.equal(advisoryStarted, true, 'advisory execution begins only after the receipts were returned');
  assert.equal(new NativeSource(store.root).state(saved.result.head).parents[0], start.result.head);
  const receipts = readSelfMetricReceipts(store.directory).filter(row => row.kind === 'lifecycle');
  assert.deepEqual(
    receipts.map(row => [row.action, row.errorCode]),
    [
      ['start', undefined],
      ['checkpoint', undefined],
    ],
  );
});

test('native checkpoint retries transient publication admission without recapturing or duplicating its save', async t => {
  const { agent } = fixture(t);
  const { ForgeError } = await import('../dist/errors.js');
  const started = (await agent.dispatch({ action: 'start', outcome: 'Transient checkpoint admission' }))
    .result;
  const store = agent.work.store;
  const locked = store.locked.bind(store);
  const capture = NativeSource.prototype.captureReport;
  let blocked = false;
  let captures = 0;
  t.mock.method(NativeSource.prototype, 'captureReport', function (...args) {
    captures++;
    return capture.apply(this, args);
  });
  t.mock.method(store, 'locked', (run, options) => {
    if (!blocked && options?.operation === 'checkpoint publication') {
      blocked = true;
      throw new ForgeError('WORK_BUSY', 'Synthetic transient admission ticket');
    }
    return locked(run, options);
  });
  writeFileSync(join(started.path, 'file.txt'), 'checkpoint after contention\n');
  const command = {
    action: 'checkpoint',
    operationId: randomUUID(),
    laneId: started.laneId,
    message: 'Retain prepared source through admission',
  };
  const saved = await agent.dispatch(command);
  assert.ok(blocked);
  assert.equal(captures, 1);
  assert.equal(store.select('lanes', started.laneId).checkpoints.length, 1);
  assert.deepEqual(await agent.dispatch(command), saved);
  assert.equal(captures, 1, 'same-operation replay never captures again');
});

test('original start and checkpoint receipts replay after later saves without recapturing or restoring files', async t => {
  const { agent } = fixture(t);
  const startCommand = { action: 'start', operationId: randomUUID(), outcome: 'Replay original' };
  const started = await agent.dispatch(startCommand);
  const retained = agent.work.store.select('lanes', started.result.laneId, 'id', true).startReceipt;
  assert.ok(retained);
  assert.equal(
    JSON.stringify(retained).includes(agent.work.store.root),
    false,
    'portable receipt metadata contains no local paths',
  );
  const saveCommand = {
    action: 'checkpoint',
    operationId: randomUUID(),
    laneId: started.result.laneId,
    message: 'First save',
  };
  writeFileSync(join(started.result.path, 'file.txt'), 'first\n');
  const saved = await agent.dispatch(saveCommand);
  writeFileSync(join(started.result.path, 'file.txt'), 'later\n');
  await agent.dispatch({ ...saveCommand, operationId: randomUUID(), message: 'Later save' });
  rmSync(started.result.path, { recursive: true });
  const originalCapture = NativeSource.prototype.captureReport;
  NativeSource.prototype.captureReport = () => {
    throw new Error('Replay must not capture live source');
  };
  t.after(() => {
    NativeSource.prototype.captureReport = originalCapture;
  });
  agent.work.store.locked = () => {
    throw new Error('Durable operation replay must not join the owner writer queue');
  };
  assert.deepEqual(await agent.dispatch(startCommand), started);
  assert.deepEqual(await agent.dispatch(saveCommand), saved);
  assert.equal(existsSync(started.result.path), false, 'replay preserves a cleaned workspace');
  await assert.rejects(
    agent.dispatch({ ...saveCommand, message: 'Changed request' }),
    error => error.code === 'WORK_OPERATION_CHANGED',
  );
});

test('failure to launch an advisory worker cannot change a committed start or save', async t => {
  const { agent } = fixture(t);
  const originalLaunch = agentAdvisoryTestHooks.launch;
  agentAdvisoryTestHooks.launch = () => {
    throw new Error('Worker launch unavailable');
  };
  t.after(() => {
    agentAdvisoryTestHooks.launch = originalLaunch;
  });
  const started = await agent.dispatch({ action: 'start', outcome: 'No worker' });
  writeFileSync(join(started.result.path, 'file.txt'), 'saved without a worker\n');
  const saved = await agent.dispatch({
    action: 'checkpoint',
    laneId: started.result.laneId,
    message: 'Still saved',
  });
  assert.equal(agent.work.store.select('lanes', started.result.laneId, 'id', true).head, saved.result.head);
});

test('detached refresh preserves undelivered notices and completed task replay avoids publication', async t => {
  const { agent } = fixture(t);
  const { refreshAgentAdvisory } = await import('../dist/agent-advisory-worker.js');
  const { CoordinationJournal } = await import('../dist/agent-coordination-journal.js');
  const { parseAgentAction } = await import('../dist/agent-action-parse.js');
  const command = parseAgentAction({
    action: 'start',
    operationId: randomUUID(),
    outcome: 'Background observation',
  });
  const started = await agent.dispatch(command);
  const store = agent.work.store;
  const journal = new CoordinationJournal(store);
  const peer = randomUUID();
  const notice = {
    noticeId: 'a'.repeat(64),
    kind: 'overlap-notice',
    at: new Date().toISOString(),
    lanes: [started.result.laneId, peer],
    heads: [started.result.head, started.result.head],
    file: 'file.txt',
    regions: [[], []],
    proposedOrder: [peer, started.result.laneId],
    text: 'Synthetic overlap',
  };
  journal.recordOverlaps([notice]);
  await refreshAgentAdvisory(store, command, started);
  assert.equal(
    journal.pendingOverlaps(started.result.laneId).length,
    1,
    'a background observation is not delivery',
  );
  store.locked = () => {
    throw new Error('Already completed refresh must not publish again');
  };
  await refreshAgentAdvisory(store, command, started);
  assert.equal(journal.pendingOverlaps(started.result.laneId).length, 1);
});

test('corrupt retained start receipt fails explicitly without substituting different source', async t => {
  const { agent } = fixture(t);
  const command = { action: 'start', operationId: randomUUID(), outcome: 'Retained identity' };
  const started = await agent.dispatch(command);
  const store = agent.work.store;
  store.locked(() => {
    const tx = store.records();
    tx.patchFields('lanes', started.result.laneId, {
      startReceipt: {
        revision: started.revision,
        result: { laneId: started.result.laneId, operationId: randomUUID() },
      },
    });
    store.commitRecords(tx);
  });
  const revision = store.revision();
  await assert.rejects(agent.dispatch(command), error => error.code === 'INVALID_WORK_STORE');
  assert.equal(store.revision(), revision);
  assert.equal(store.select('lanes', started.result.laneId, 'id', true).head, started.result.head);
});

test('CLI exits while its detached advisory child remains indefinitely busy', async t => {
  const { root } = fixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'forge-command-child-'));
  const pidPath = join(directory, 'pid');
  const preload = join(directory, 'preload.mjs');
  writeFileSync(
    preload,
    `
    import {spawn} from 'node:child_process';
    import {writeFileSync} from 'node:fs';
    import {agentAdvisoryTestHooks} from ${JSON.stringify(new URL('../dist/agent-advisory-worker.js', import.meta.url).href)};
    agentAdvisoryTestHooks.launch = () => {
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{}});
      writeFileSync(${JSON.stringify(pidPath)},String(child.pid));
      return child;
    };
  `,
  );
  t.after(() => {
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, 'utf8'));
      try {
        process.kill(pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--import',
        preload,
        new URL('../dist/cli.js', import.meta.url).pathname,
        'agent',
        root,
        'start',
        JSON.stringify({ outcome: 'Detached child liveness' }),
      ],
      { encoding: 'utf8', timeout: 30000 },
    ),
  );
  assert.equal(result.result.state, 'active');
  const pid = Number(readFileSync(pidPath, 'utf8'));
  process.kill(pid, 0); // Child is still alive after the CLI has returned its receipt and exited.
});

test('indexed receipt delivers cached overlaps before the next write and replays its original observation', async t => {
  const { agent } = fixture(t);
  const { refreshAgentAdvisory } = await import('../dist/agent-advisory-worker.js');
  const { CoordinationJournal } = await import('../dist/agent-coordination-journal.js');
  const { PeersSource } = await import('../dist/agent-peers-source.js');
  const store = agent.work.store;
  const a = (await agent.dispatch({ action: 'start', outcome: 'Alpha', scope: { paths: ['file.txt'] } }))
    .result;
  const b = (await agent.dispatch({ action: 'start', outcome: 'Beta', scope: { paths: ['file.txt'] } }))
    .result;
  assert.equal(b.peers.overlaps.find(peer => peer.lane === a.laneId).claim, 'planned');
  for (const lane of [a, b]) {
    writeFileSync(join(lane.path, 'file.txt'), `${lane.laneId} replacement\n`);
    const response = await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Overlap' });
    await refreshAgentAdvisory(
      store,
      {
        action: 'checkpoint',
        laneId: lane.laneId,
        message: 'Overlap',
        ...response.result.resolved,
      },
      response,
    );
  }
  const journal = new CoordinationJournal(store);
  const pending = journal.pendingOverlaps(a.laneId);
  assert.ok(pending.length);
  const live = PeersSource.prototype.live;
  const merge = PeersSource.prototype.mergeFiles;
  PeersSource.prototype.live = () => {
    throw new Error('Return must not scan source');
  };
  PeersSource.prototype.mergeFiles = () => {
    throw new Error('Return must not recompose source');
  };
  t.after(() => {
    PeersSource.prototype.live = live;
    PeersSource.prototype.mergeFiles = merge;
  });
  const command = {
    action: 'checkpoint',
    operationId: randomUUID(),
    laneId: a.laneId,
    message: 'Receive before edit',
  };
  const received = await agent.dispatch(command);
  assert.equal(received.result.peers.coverage, 'local-incomplete');
  assert.deepEqual(
    received.result.peers.inbox.map(item => item.noticeId),
    pending.map(item => item.noticeId),
  );
  assert.equal(journal.pendingOverlaps(a.laneId).length, 0);
  assert.deepEqual(await agent.dispatch(command), received);
});

test('saved predictive receipt is ready without detached refresh or a full peers read', async t => {
  const { agent } = fixture(t);
  const start = outcome => agent.dispatch({ action: 'start', outcome });
  const a = (await start('First saved region')).result;
  const b = (await start('Second saved region')).result;
  for (const [lane, text] of [
    [a, 'first\n'],
    [b, 'second\n'],
  ]) {
    writeFileSync(join(lane.path, 'file.txt'), text);
    const saved = await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Save region' });
    if (lane === b) {
      assert.equal(saved.result.peers.predictive[0].head, agent.work.store.select('lanes', a.laneId).head);
      assert.equal(saved.result.peers.predictive[0].risk, 'high');
      assert.equal(saved.result.peers.coverage, 'local-incomplete');
    }
  }
});

test('owner drain joins a real advisory worker and its pending ticket is removed', async t => {
  const { root } = fixture(t);
  const { drainAgentAdvisories } = await import('../dist/agent-advisory-worker.js');
  const agent = new AgentWorkflow(root, true);
  const started = await agent.dispatch({ action: 'start', outcome: 'Finite owner refresh' });
  const pending = join(agent.work.store.directory, 'agent-advisory', 'pending', started.result.operationId);
  assert.ok(existsSync(join(pending, 'ticket.json')), 'startup is visible before returning the receipt');
  await drainAgentAdvisories(started.result.path);
  assert.equal(existsSync(pending), false);
  assert.ok(
    existsSync(join(agent.work.store.directory, 'agent-advisory', `${started.result.operationId}.json`)),
  );
});

test('a committed contract landing appears in the next receipt without a prior peers read', async t => {
  const { agent } = fixture(t, {
    'lib.ts': "export type Shared = 'before';\n",
    'use.ts': "import type { Shared } from './lib.js';\nexport const value: Shared = 'before';\n",
  });
  const provider = (await agent.dispatch({ action: 'start', outcome: 'Change Shared' })).result;
  const dependent = (
    await agent.dispatch({ action: 'start', outcome: 'Use Shared', scope: { paths: ['use.ts'] } })
  ).result;
  writeFileSync(join(provider.path, 'lib.ts'), "export type Shared = 'after';\n");
  const saved = (
    await agent.dispatch({ action: 'checkpoint', laneId: provider.laneId, message: 'Change type' })
  ).result;
  const store = agent.work.store;
  store.locked(() => {
    const tx = store.records();
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head: saved.head,
      previous: provider.base,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    store.commitRecords(tx);
  });
  const receipt = await agent.dispatch({
    action: 'checkpoint',
    laneId: dependent.laneId,
    message: 'Read landed contract',
  });
  assert.equal(receipt.result.peers.contracts[0].head, saved.head);
  assert.deepEqual(receipt.result.peers.contracts[0].changes, [
    { file: 'lib.ts', export: 'Shared', kind: 'changed' },
  ]);
});

test('coordination contention cannot invalidate an already successful sync receipt', async t => {
  const { agent } = fixture(t);
  const { agentResponseAdvisory } = await import('../dist/agent-response-advisory.js');
  const { CoordinationJournal } = await import('../dist/agent-coordination-journal.js');
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Optional coordination' })).result;
  t.mock.method(CoordinationJournal.prototype, 'record', () => {
    throw Object.assign(new Error('Synthetic coordination contention'), { code: 'WORK_BUSY' });
  });
  const response = await agentResponseAdvisory(
    agent.work.store,
    { action: 'sync', operationId: randomUUID(), laneId: lane.laneId, channel: 'main' },
    { revision: agent.work.store.revision(), result: { laneId: lane.laneId, status: 'up-to-date' } },
  );
  assert.equal(response.result.status, 'up-to-date');
  assert.equal(response.result.peers.coverage, 'local-incomplete');
});

test('durable checkpoint metrics use the latest save delta and exclude accepted open peers', async t => {
  const { agent } = fixture(t, { 'file.txt': 'initial\n', 'other.txt': 'initial\n' });
  const start = async outcome => (await agent.dispatch({ action: 'start', outcome })).result;
  const save = async (lane, file, text) => {
    writeFileSync(join(lane.path, file), text);
    return (await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Metric save' }))
      .result;
  };
  const a = await start('First metric peer');
  const b = await start('Second metric peer');
  const c = await start('Third metric peer');
  const first = await save(a, 'file.txt', 'first\n');
  const overlapping = await save(b, 'file.txt', 'second\n');
  const latest = await save(b, 'other.txt', 'different path\n');
  const store = agent.work.store;
  const observation = head =>
    readSelfMetricReceipts(store.directory).find(
      row => row.observation?.type === 'save' && row.observation.head === head,
    )?.observation;
  assert.deepEqual(
    observation(overlapping.head).overlaps.map(peer => peer.laneId),
    [a.laneId],
  );
  assert.deepEqual(
    observation(latest.head).overlaps,
    [],
    'earlier Lane edits are not a new overlapping save',
  );
  store.locked(() => {
    const tx = store.records();
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head: first.head,
      previous: a.base,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    store.commitRecords(tx);
  });
  const afterAcceptance = await save(c, 'file.txt', 'third\n');
  assert.deepEqual(
    observation(afterAcceptance.head).overlaps.map(peer => peer.laneId),
    [b.laneId],
  );
  assert.equal(observation(afterAcceptance.head).complete, true);
});
