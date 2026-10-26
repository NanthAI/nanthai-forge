// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AgentWorkflow } from './agent-advisory-fixture.mjs';
import { initNative } from '../dist/native-work.js';
import { agentPeers, PEERS_MAX_BYTES } from '../dist/agent-peers.js';
import { updateHostState } from '../dist/host-binding.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-notice-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.txt'), 'one\ntwo\nthree\n');
  initNative(root);
  const agent = new AgentWorkflow(root);
  const start = async actor =>
    (await agent.dispatch({ action: 'start', outcome: `Intent ${actor}`, actor })).result;
  const a = await start('Alpha'),
    b = await start('Beta');
  const save = async (lane, message = 'Exact checkpoint message') =>
    (await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message })).result;
  const peers = lane => agentPeers(agent.work.store, { laneId: lane.laneId, detail: true });
  return { root, agent, a, b, save, peers };
}
test('both receipts carry the same exact notice; advisory answers replay and preserve Work/source', async t => {
  const { root, agent, a, b, save, peers } = await fixture(t);
  updateHostState(agent.work.store, state => {
    state.selfReports = {
      beta: {
        operations: [],
        laneId: b.laneId,
        intentId: b.intentId,
        name: 'Beta',
        sessionId: 'beta-session',
        reportedAt: new Date().toISOString(),
      },
    };
  });
  writeFileSync(join(a.path, 'src/a.txt'), 'alpha\ntwo\nthree\n');
  writeFileSync(join(b.path, 'src/a.txt'), 'beta\ntwo\nthree\n');
  await save(a);
  const receipt = await save(b);
  assert.ok(receipt.peers.conflicts.length);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt.peers)) <= PEERS_MAX_BYTES);
  const first = peers(a).conflicts[0],
    second = peers(b).conflicts[0];
  assert.equal(first.noticeId, second.noticeId);
  assert.deepEqual(first.proposedOrder, second.proposedOrder);
  assert.equal(first.granularity, 'file');
  assert.match(first.conflicts[0].hunk, /alpha/);
  assert.match(first.conflicts[0].hunk, /beta/);
  assert.equal(first.participants.find(p => p.lane === b.laneId).message, 'Exact checkpoint message');
  assert.ok(first.participants.find(p => p.lane === b.laneId).sessions.includes('beta-session'));
  assert.equal(first.participants.find(p => p.lane === b.laneId).intent, 'Intent Beta');
  const objects = readdirSync(join(root, '.forge/work/objects')).sort();
  const work = readFileSync(join(agent.work.store.directory, 'work.json'));
  const trailing = first.proposedOrder[1];
  const request = {
    action: 'peer-ack',
    operationId: randomUUID(),
    laneId: trailing,
    noticeId: first.noticeId,
    choice: 'swap',
  };
  const answer = await agent.dispatch(request);
  assert.equal(answer.result.status, 'recorded');
  assert.equal(peers(a).conflicts[0].proposedOrder[0], trailing);
  assert.equal(peers(b).conflicts[0].proposedOrder[0], trailing);
  await agent.dispatch({ ...request, operationId: randomUUID(), choice: 'accept-order' });
  await agent.dispatch({
    ...request,
    operationId: randomUUID(),
    choice: 'split',
    text: 'Move helper to another file',
  });
  assert.equal(peers(a).conflicts[0].decisions.length, 3);
  await assert.rejects(
    agent.dispatch({ ...request, choice: 'accept-order' }),
    e => e.code === 'WORK_OPERATION_CHANGED',
  );
  assert.deepEqual(readFileSync(join(agent.work.store.directory, 'work.json')), work);
  assert.deepEqual(readdirSync(join(root, '.forge/work/objects')).sort(), objects);
  // Unrelated dirty content must not give each side a different conflict id.
  writeFileSync(join(a.path, 'src/unrelated.txt'), 'unrelated\n');
  assert.equal(peers(a).conflicts[0].noticeId, peers(b).conflicts[0].noticeId);
  // Same bytes resolve the conflict immediately; old answer replay is still safe.
  writeFileSync(join(b.path, 'src/a.txt'), 'alpha\ntwo\nthree\n');
  assert.equal(peers(a).conflicts, undefined);
  await agent.dispatch(request);
  await assert.rejects(
    agent.dispatch({ ...request, operationId: randomUUID() }),
    e => e.code === 'NOTICE_STALE',
  );
});
test('clean overlaps have no notice; source resolution and landing clear stale pair notices', async t => {
  const { agent, a, b, save, peers } = await fixture(t);
  writeFileSync(join(a.path, 'src/a.txt'), 'alpha\ntwo\nthree\n');
  writeFileSync(join(b.path, 'src/a.txt'), 'one\ntwo\nbeta\n');
  await save(a);
  await save(b);
  assert.equal(peers(a).conflicts, undefined);
  assert.equal(peers(b).conflicts, undefined);
  writeFileSync(join(b.path, 'src/a.txt'), 'beta\ntwo\nthree\n');
  const saved = await save(b);
  assert.ok(peers(a).conflicts.length);
  const store = agent.work.store;
  store.locked(() => {
    const tx = store.records();
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head: saved.head,
      previous: b.base,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    store.commitRecords(tx);
  });
  const landed = peers(a);
  assert.equal(landed.overlaps.length, 0);
  assert.equal(landed.conflicts[0].participants[1].lane, 'main');
  // Resolve before sync to avoid intentionally leaving conflict markers.
  writeFileSync(join(a.path, 'src/a.txt'), 'beta\ntwo\nthree\n');
  await save(a);
  await agent.dispatch({ action: 'sync', laneId: a.laneId });
  assert.equal(peers(a).conflicts, undefined);
});
test('large exact hunks stay available beyond compact receipt caps', async t => {
  const { a, b, save, peers } = await fixture(t);
  writeFileSync(join(a.path, 'src/a.txt'), 'alpha\n'.repeat(100));
  writeFileSync(join(b.path, 'src/a.txt'), 'beta\n'.repeat(100));
  await save(a);
  const saved = await save(b);
  assert.ok(Buffer.byteLength(JSON.stringify(saved.peers)) <= PEERS_MAX_BYTES);
  assert.ok(saved.peers.conflicts[0].detail);
  assert.equal(saved.peers.conflicts[0].conflicts[0].hunk, undefined);
  assert.match(peers(a).conflicts[0].conflicts[0].hunk, /alpha\nalpha/);
});

test('binary and add/delete notices retain exact object pins; nonparticipants cannot answer', async t => {
  const { agent, a, b, save, peers } = await fixture(t);
  writeFileSync(join(a.path, 'src/a.txt'), Buffer.from([0, 1, 2]));
  writeFileSync(join(b.path, 'src/a.txt'), Buffer.from([0, 3, 4]));
  await save(a);
  await save(b);
  let notice = peers(a).conflicts[0];
  assert.equal(notice.conflicts[0].kind, 'binary');
  assert.ok(notice.conflicts[0].left.blob);
  assert.ok(notice.conflicts[0].right.blob);
  const outsider = (await agent.dispatch({ action: 'start', outcome: 'Unrelated Lane' })).result;
  await assert.rejects(
    agent.dispatch({
      action: 'peer-ack',
      laneId: outsider.laneId,
      noticeId: notice.noticeId,
      choice: 'swap',
    }),
    e => e.code === 'NOTICE_STALE',
  );
  rmSync(join(b.path, 'src/a.txt'));
  notice = peers(a).conflicts[0];
  assert.equal(notice.conflicts[0].right === undefined || notice.conflicts[0].left === undefined, true);
});

test('write path primes scoped inventories and only republishes changed Lane pages', async t => {
  const { agent, a } = await fixture(t);
  const { PeersCache } = await import('../dist/agent-peers-cache.js');
  const { PeersSource } = await import('../dist/agent-peers-source.js');
  const cache = new PeersCache(agent.work.store.root);
  assert.ok(cache.read(`paths-v2:${a.laneId}:${a.head}:undefined`));
  const lane = agent.work.store.select('lanes', a.laneId, 'id', true);
  const source = new PeersSource(agent.work.store, lane.base);
  source.live(lane, ['src']);
  assert.equal(cache.read(`paths-v2:${a.laneId}:${a.head}:["src"]`), undefined);
  const writes = [],
    original = PeersCache.prototype.write;
  PeersCache.prototype.write = function (key, value) {
    writes.push(key);
    return original.call(this, key, value);
  };
  try {
    agent.work.store.locked(() => {
      const tx = agent.work.store.records();
      tx.patchFields('intents', a.intentId, { outcome: 'Changed intent only' });
      agent.work.store.commitRecords(tx);
    });
    assert.deepEqual(writes, []);
    agent.work.store.locked(() => {
      const tx = agent.work.store.records();
      tx.patchFields('lanes', a.laneId, { state: 'ready' });
      agent.work.store.commitRecords(tx);
    });
    assert.equal(writes.filter(key => key.startsWith('lane-fields-v1:')).length, 1);
  } finally {
    PeersCache.prototype.write = original;
  }
});

test('Lanes started on different main heads receive the same conflict notice', async t => {
  const { agent, a, b, save, peers } = await fixture(t);
  writeFileSync(join(a.path, 'src/accepted.txt'), 'unrelated accepted source\n');
  const saved = await save(a),
    store = agent.work.store;
  store.locked(() => {
    const tx = store.records();
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head: saved.head,
      previous: a.base,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    store.commitRecords(tx);
  });
  const newer = (await agent.dispatch({ action: 'start', outcome: 'New main base' })).result;
  writeFileSync(join(b.path, 'src/a.txt'), 'older peer\ntwo\nthree\n');
  writeFileSync(join(newer.path, 'src/a.txt'), 'newer peer\ntwo\nthree\n');
  await save(b);
  await save(newer);
  const oldNotice = peers(b).conflicts.find(n => n.participants.some(p => p.lane === newer.laneId));
  const newNotice = peers(newer).conflicts.find(n => n.participants.some(p => p.lane === b.laneId));
  assert.ok(oldNotice);
  assert.equal(newNotice.noticeId, oldNotice.noticeId);
});
