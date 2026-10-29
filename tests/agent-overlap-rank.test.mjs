// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { AgentWorkflow } from './agent-advisory-fixture.mjs';
import { agentStart, agentCheckpoint } from '../dist/agent-workflow-mutations.js';
import { agentPeers } from '../dist/agent-peers.js';
import { boundPeers } from '../dist/agent-peers-bound.js';
import { recordOverlapAlerts } from '../dist/agent-overlap-alerts.js';
import { rankPeerLanes } from '../dist/agent-peer-ranking.js';
import { indexPeerSource } from '../dist/agent-peers-index.js';
import { CoordinationJournal } from '../dist/agent-coordination-journal.js';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';
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

test('eight-Lane replay alerts every overlapping pair despite four unrelated IDs sorting first; next CLI/MCP replies deliver reciprocally', async t => {
  const f = fixture(t),
    lanes = Array.from({ length: 8 }, (_, i) => f.start(`Agent ${i}`)).sort((a, b) =>
      a.laneId.localeCompare(b.laneId),
    );
  const unrelated = lanes.slice(0, 4),
    workers = lanes.slice(4),
    measurements = [];
  for (const [i, lane] of unrelated.entries()) {
    writeFileSync(join(lane.path, `unrelated-${i}.txt`), 'unrelated\n');
    f.save(lane);
    indexPeerSource(f.store, lane.laneId);
  }
  for (const [i, lane] of workers.entries()) {
    for (const path of ['a.txt', 'b.txt', 'c.txt'])
      writeFileSync(join(lane.path, path), `worker ${i}\ntwo\nthree\n`);
    const began = performance.now();
    f.save(lane);
    indexPeerSource(f.store, lane.laneId);
    const checkpointMs = performance.now() - began,
      alertsAt = performance.now();
    assert.equal(recordOverlapAlerts(f.store, lane.laneId, 3), 'local');
    measurements.push({ checkpointMs, overlapWriterMs: performance.now() - alertsAt });
  }
  const journal = new CoordinationJournal(f.store);
  assert.equal(journal.overlaps().length, 18); // 6 pairs x 3 files.
  for (const lane of workers) {
    const notices = journal.overlaps(lane.laneId);
    assert.equal(notices.length, 9);
    assert.equal(new Set(notices.flatMap(n => n.lanes.filter(id => id !== lane.laneId))).size, 3);
    assert.ok(notices.every(n => n.lanes.every(id => workers.some(w => w.laneId === id))));
  }
  const mine = workers[0],
    other = workers.at(-1);
  const before = readdirSync(join(f.store.directory, 'coordination')).sort();
  const objects = readdirSync(join(f.store.directory, 'objects')).sort();
  const metadata = readFileSync(join(f.store.directory, 'work.json'));
  const cli = spawnSync(
    process.execPath,
    [resolve('dist/cli.js'), 'agent', f.root, 'status', JSON.stringify({ laneId: mine.laneId })],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const reply = JSON.parse(cli.stdout).result.peers;
  for (const worker of workers.slice(1)) {
    assert.ok(reply.inbox.some(n => n.lanes.includes(worker.laneId)));
    const overlap = reply.overlaps.find(n => n.lane === worker.laneId);
    assert.ok(overlap, JSON.stringify(reply));
    assert.deepEqual(overlap.paths, ['a.txt', 'b.txt', 'c.txt']);
    assert.match(overlap.actor, /^Agent /);
    assert.match(overlap.intent, /^Intent Agent /);
  }
  const handlers = new Map();
  registerAgentWorkflow({ registerTool: (name, config, handler) => handlers.set(name, handler) }, f.root);
  const mcp = JSON.parse(
    (await handlers.get('forge_work_overview')({ command: { action: 'status', laneId: mine.laneId } }))
      .content[0].text,
  );
  assert.ok(mcp.result.peers.inbox.some(n => n.lanes.includes(other.laneId)));
  const peers = agentPeers(f.store, { laneId: mine.laneId });
  assert.equal(peers.overlaps.length, 3);
  assert.deepEqual(readFileSync(join(f.store.directory, 'work.json')), metadata);
  assert.deepEqual(readdirSync(join(f.store.directory, 'objects')).sort(), objects);
  assert.deepEqual(readdirSync(join(f.store.directory, 'coordination')).sort(), before);
  const saved = (
    await f.agent.dispatch({ action: 'checkpoint', laneId: mine.laneId, message: 'Unchanged reply' })
  ).result;
  assert.equal(saved.peers.overlaps.length, 3);
  assert.equal(saved.peers.inbox.length, 3);
  assert.equal(saved.peers.more, undefined, 'unrelated Lanes and extra regions are not hidden overlap Lanes');
  assert.equal(new Set(saved.peers.inbox.flatMap(n => n.lanes.filter(id => id !== mine.laneId))).size, 3);
  // Existing queued notices survive failure of fresh source analysis.
  const state = join(f.store.directory, 'objects', mine.base),
    bytes = readFileSync(state);
  writeFileSync(state, 'unavailable');
  try {
    const unavailable = agentPeers(f.store, { laneId: mine.laneId });
    assert.equal(unavailable.coverage, 'local-incomplete');
    assert.ok(unavailable.inbox.some(n => n.lanes.includes(other.laneId)));
  } finally {
    writeFileSync(state, bytes);
  }
  t.diagnostic(
    JSON.stringify({ fixture: '8 Lanes, 4 unrelated first', saves: measurements.length, measurements }),
  );
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
