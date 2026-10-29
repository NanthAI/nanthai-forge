// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AgentWorkflow } from './agent-advisory-fixture.mjs';
import { agentStart, agentCheckpoint } from '../dist/agent-workflow-mutations.js';
import { PeersSource } from '../dist/agent-peers-source.js';
import { PeersCache } from '../dist/agent-peers-cache.js';
import { agentPeers, RECEIPT_PEER_LIMIT, PEERS_MAX_BYTES } from '../dist/agent-peers.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { CoordinationJournal } from '../dist/agent-coordination-journal.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-receipt-latency-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'shared.txt'), 'original\n');
  writeFileSync(join(root, 'shared.ts'), "export type Shared = 'original';\n");
  initNative(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  const start = extra =>
    agentStart(store, {
      action: 'start',
      operationId: randomUUID(),
      outcome: 'Synthetic receipt fixture',
      constraints: '',
      assignment: '',
      target: '',
      ...extra,
    }).result;
  const save = lane =>
    agentCheckpoint(store, {
      action: 'checkpoint',
      operationId: randomUUID(),
      laneId: lane.laneId,
      expectedHead: store.select('lanes', lane.laneId).head,
      message: 'Save fixture',
    }).result;
  return { root, agent, store, start, save };
}

test('25 overlapping peers all receive notices while full live reads and display stay bounded', async t => {
  const f = fixture(t),
    peers = [];
  for (let i = 0; i < 25; i++) {
    const peer = f.start();
    writeFileSync(join(peer.path, 'shared.ts'), `export type Shared = 'peer ${i}';\n`);
    f.save(peer);
    peers.push(peer);
  }
  const mine = f.start();
  writeFileSync(join(mine.path, 'shared.ts'), "export type Shared = 'mine';\n");
  const fullReads = new Set(),
    summaries = new Set();
  const live = PeersSource.prototype.live,
    read = PeersCache.prototype.read;
  const liveMock = t.mock.method(PeersSource.prototype, 'live', function (lane, scope) {
    if (lane.id !== mine.laneId && !scope) fullReads.add(lane.id);
    return live.call(this, lane, scope);
  });
  const cacheMock = t.mock.method(PeersCache.prototype, 'read', function (key) {
    if (key.startsWith('regions-v1:')) summaries.add(key);
    return read.call(this, key);
  });
  const began = performance.now(),
    cpu = process.cpuUsage();
  const saved = await f.agent.dispatch({
    action: 'checkpoint',
    laneId: mine.laneId,
    message: 'Measured save',
  });
  const elapsed = performance.now() - began,
    used = process.cpuUsage(cpu);
  t.diagnostic(
    JSON.stringify({
      fixture: '25 overlapping peers',
      wallMs: elapsed,
      cpuMs: (used.user + used.system) / 1000,
      summaries: summaries.size,
      fullPeerReads: fullReads.size,
      bytes: Buffer.byteLength(JSON.stringify(saved.result.peers)),
    }),
  );
  assert.equal(saved.result.head, f.store.select('lanes', mine.laneId).head);
  assert.ok(summaries.size <= 27, `summaries=${summaries.size}`);
  assert.ok(fullReads.size <= RECEIPT_PEER_LIMIT, `fullReads=${fullReads.size}`);
  assert.equal(saved.result.peers.coverage, 'local-incomplete');
  assert.ok(saved.result.peers.more >= 25 - RECEIPT_PEER_LIMIT);
  assert.equal(saved.result.peers.overlaps.length, 10);
  assert.ok(Buffer.byteLength(JSON.stringify(saved.result.peers)) <= PEERS_MAX_BYTES);
  // A durable high-risk notice keeps its ordering even when rich advice is deferred.
  const inbox = new CoordinationJournal(f.store).overlaps(mine.laneId);
  assert.equal(inbox.length, 25);
  assert.ok(inbox.every(n => n.proposedOrder.length === 2 && /sync after/.test(n.text)));
  assert.ok(saved.result.peers.inbox?.length || saved.result.peers.conflicts?.length);
  liveMock.mock.restore();
  cacheMock.mock.restore();
  const all = agentPeers(f.store, { laneId: mine.laneId, detail: true });
  assert.equal(all.predictive.length, 25);
  assert.equal(all.overlaps.length, 25);
  assert.ok(all.predictive.every(item => item.risk === 'high' && item.first));
  const status = await f.agent.dispatch({ action: 'status', laneId: mine.laneId });
  assert.ok(status.result.peers.more >= 25 - RECEIPT_PEER_LIMIT);
  assert.ok(Buffer.byteLength(JSON.stringify(status.result.peers)) <= PEERS_MAX_BYTES);
});

test('stacked start does not traverse source history for unrelated acceptance receipts', async t => {
  const f = fixture(t),
    parent = f.start(),
    source = new NativeSource(f.root);
  writeFileSync(join(parent.path, 'shared.txt'), 'saved parent\n');
  const saved = f.save(parent);
  const tx = f.store.records(),
    initial = tx.data().nativeHead;
  let previous = initial;
  for (let i = 0; i < 60; i++) {
    const head = source.writeState(
      source.state(initial).files,
      [previous],
      `Unrelated ${i}`,
      new Date().toISOString(),
    );
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head,
      previous,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    previous = head;
  }
  f.store.commitRecords(tx);
  const state = NativeSource.prototype.state;
  let reads = 0;
  t.mock.method(NativeSource.prototype, 'state', function (...args) {
    reads++;
    return state.apply(this, args);
  });
  const began = performance.now(),
    cpu = process.cpuUsage();
  const child = (
    await f.agent.dispatch({ action: 'start', outcome: 'Measured stack', stackOn: parent.laneId })
  ).result;
  const used = process.cpuUsage(cpu);
  t.diagnostic(
    JSON.stringify({
      fixture: '60 unrelated acceptances, stacked start',
      wallMs: performance.now() - began,
      cpuMs: (used.user + used.system) / 1000,
      stateReads: reads,
    }),
  );
  assert.equal(child.base, saved.head);
  assert.equal(child.peers.stack.status, 'up-to-date');
  assert.ok(reads < 20, `state reads=${reads}`);
});

test('bounded receipt ancestry defers deep history while explicit advice can read it fully', t => {
  const f = fixture(t),
    source = new NativeSource(f.root);
  const initial = f.store.records().data().nativeHead;
  let head = initial;
  for (let i = 0; i < 24; i++)
    head = source.writeState(source.state(initial).files, [head], `History ${i}`, new Date().toISOString());
  const limited = new PeersSource(f.store, '', 2);
  let reads = 0;
  const state = limited.state.bind(limited);
  t.mock.method(limited, 'state', id => {
    reads++;
    return state(id);
  });
  assert.throws(
    () => limited.ancestry().ancestors(head),
    error => error.code === 'ADVICE_DEFERRED',
  );
  assert.equal(reads, 2);
  assert.equal(new PeersSource(f.store, '').ancestry().ancestors(head).size, 25);
});
