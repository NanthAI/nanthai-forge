// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { AgentWorkflow } from './agent-advisory-fixture.mjs';
import { agentStart, agentCheckpoint } from '../dist/agent-workflow-mutations.js';

import { boundPeers } from '../dist/agent-peers-bound.js';

import { rankPeerLanes } from '../dist/agent-peer-ranking.js';

import { initNative } from '../dist/native-work.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-overlap-rank-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  for (const path of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(root, path), 'one\ntwo\nthree\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  const start = actor =>
    agentStart(store, {
      action: 'start',
      operationId: randomUUID(),
      outcome: `Intent ${actor}`,
      actor,
      constraints: '',
      assignment: '',
      target: '',
    }).result;
  const save = lane =>
    agentCheckpoint(store, {
      action: 'checkpoint',
      operationId: randomUUID(),
      laneId: lane.laneId,
      expectedHead: store.select('lanes', lane.laneId).head,
      message: 'Replay save',
    }).result;
  return { root, agent, store, start, save };
}

test('path index ranks shared paths then save recency and respects directory claims without blob or live reads', () => {
  const lanes = [
    { id: 'unrelated', base: 'base', head: 'unrelated' },
    { id: 'older', base: 'base', head: 'older' },
    { id: 'recent', base: 'base', head: 'recent' },
    { id: 'most', base: 'base', head: 'most' },
    { id: 'claim', base: 'base', head: 'base', scope: { paths: ['src/'] } },
  ];
  const paths = {
    unrelated: ['other.txt'],
    older: ['src/a.ts'],
    recent: ['src/a.ts'],
    most: ['src/a.ts', 'src/b.ts'],
  };
  const source = {
    state: head => ({ at: head === 'recent' ? '2026-02' : '2026-01' }),
    object: () => assert.fail('ranking must not read blobs'),
    live: () => assert.fail('ranking must not scan live trees'),
  };
  const cache = {
    read: key =>
      key.startsWith('regions-v1:')
        ? { files: (paths[key.split(':').at(-1)] ?? []).map(path => ({ path })) }
        : undefined,
  };
  const ranked = rankPeerLanes(source, cache, ['src/a.ts', 'src/b.ts'], lanes);
  assert.deepEqual(
    ranked.ranked.map(l => l.id),
    ['most', 'claim', 'recent', 'older', 'unrelated'],
  );
  assert.equal(ranked.shared.get('most'), 2);
  assert.equal(ranked.shared.get('claim'), 2);
  assert.equal(ranked.shared.has('unrelated'), false);
  assert.equal(ranked.incomplete, false);
  const indexed = rankPeerLanes(
    { state: () => assert.fail('warm path index must not reread manifests') },
    {
      read: key =>
        key.startsWith('peer-paths-v1:')
          ? { paths: paths[key.split(':').at(-1)] ?? [], at: '2026-01' }
          : assert.fail('warm path index must not decode region summaries'),
    },
    ['src/a.ts'],
    lanes,
  );
  assert.equal(indexed.shared.get('most'), 1);
  assert.deepEqual(
    rankPeerLanes(source, cache, ['src'], lanes)
      .ranked.map(l => l.id)
      .slice(0, 4),
    ['most', 'recent', 'older', 'claim'],
  );
});

test('compact inbox follows path-ranked Lane summaries before its ten-Lane display cap', () => {
  const overlaps = Array.from({ length: 11 }, (_, i) => ({
    lane: `peer-${i}`,
    actor: `Agent ${i}`,
    intent: `Intent ${i}`,
    state: 'working',
    paths: ['shared.txt'],
    via: 'edit',
  }));
  const inbox = overlaps.map((p, i) => ({
    noticeId: String(i).padStart(64, '0'),
    kind: 'overlap-notice',
    lanes: ['mine', p.lane],
    file: 'shared.txt',
    proposedOrder: ['mine', p.lane],
    text: 'High overlap',
  }));
  const compact = boundPeers({ overlaps, inbox });
  assert.equal(compact.overlaps.length, 10);
  assert.equal(compact.inbox.length, 10);
  assert.ok(compact.inbox.every(n => !n.lanes.includes('peer-10')));
  assert.equal(compact.more, 2);
});

test('conflict receipt attributes the landed Lane and Intent after a later unrelated acceptance', async t => {
  const f = fixture(t),
    mine = f.start('mine'),
    landed = f.start('landed'),
    unrelated = f.start('unrelated');
  writeFileSync(join(mine.path, 'a.txt'), 'mine\ntwo\nthree\n');
  writeFileSync(join(landed.path, 'a.txt'), 'landed\ntwo\nthree\n');
  f.save(mine);
  const saved = f.save(landed);
  const accept = (lane, head, previous) =>
    f.store.locked(() => {
      const tx = f.store.records(),
        viewId = randomUUID();
      tx.append('views', {
        id: viewId,
        intentId: lane.intentId,
        base: lane.base,
        inputs: [{ laneId: lane.laneId, head }],
        dependencies: [],
        head,
        status: 'clean',
        details: '',
        at: new Date().toISOString(),
      });
      tx.append('channelMoves', {
        id: randomUUID(),
        channel: 'main',
        viewId,
        head,
        previous,
        at: new Date().toISOString(),
        status: 'accepted',
        provenance: 'user-declared-local',
      });
      f.store.commitRecords(tx);
    });
  accept(landed, saved.head, mine.base);
  // A later acceptance that only changes c.txt must not steal attribution.
  await f.agent.dispatch({ action: 'sync', laneId: unrelated.laneId });
  writeFileSync(join(unrelated.path, 'c.txt'), 'unrelated\n');
  const last = f.save(unrelated);
  accept(unrelated, last.head, saved.head);
  const reply = (await f.agent.dispatch({ action: 'status', laneId: mine.laneId })).result;
  const notice = reply.peers.conflicts.find(n => n.participants.some(p => p.lane === landed.laneId));
  assert.ok(notice, JSON.stringify(reply));
  assert.equal(notice.participants.find(p => p.lane === landed.laneId).intent, 'Intent landed');
  assert.ok(notice.proposedOrder.includes(landed.laneId));
  assert.ok(!notice.participants.some(p => p.lane === unrelated.laneId || p.lane === 'main'));
});
