// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentWorkflow } from './agent-advisory-fixture.mjs';
import { initNative } from '../dist/native-work.js';
import { agentPeers, boundPeers, PEERS_MAX_BYTES } from '../dist/agent-peers.js';
import { updateHostState } from '../dist/host-binding.js';
import { FinishJournal } from '../dist/agent-finish-journal.js';
import { duplicateStartWarnings } from '../dist/agent-ownership.js';
import { PRESENCE } from '../dist/presence.js';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-ownership-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.txt'), 'one\ntwo\n');
  writeFileSync(join(root, 'src/b.txt'), 'other\n');
  initNative(root);
  const agent = new AgentWorkflow(root);
  const start = async (actor, outcome = actor, paths = []) =>
    (await agent.dispatch({ action: 'start', actor, outcome, scope: { paths } })).result;
  return { agent, start };
}
function quiet(store, lane, status = 'working') {
  updateHostState(store, state => {
    for (const session of Object.values(state.presence ?? {}))
      if (session.context.laneId === lane.laneId) {
        session.lastActivity = Date.now() - PRESENCE.workingMs - 1000;
        session.status = status;
      }
  });
}
test('duplicate starts warn on Intent or implicit planned paths without stopping work', async t => {
  const { agent, start } = fixture(t);
  const first = await start('first', 'Fix rounding', ['src/a.txt']);
  const same = await start('second', '  FIX rounding  ');
  assert.match(same.warnings.join('\n'), new RegExp(first.laneId));
  const overlap = await start('third', 'Different outcome', ['src/a.txt']);
  assert.equal(overlap.peers.overlaps[0].lane, first.laneId);
  assert.match(overlap.warnings.join('\n'), /take it or coordinate/);
  assert.equal(agentPeers(agent.work.store, { laneId: first.laneId }).overlaps[0].lane, overlap.laneId);
  const disjoint = await start('fourth', 'Other', ['src/b.txt']);
  assert.deepEqual(disjoint.peers, { clear: true });
  assert.equal(disjoint.warnings, undefined);
});
test('stalled needs quiet owner, unlanded source, no active check, and no waiting state', async t => {
  const { agent, start } = fixture(t);
  const peer = await start('peer', 'Peer', ['src/a.txt']);
  const mine = await start('mine', 'Mine', ['src/a.txt']);
  quiet(agent.work.store, peer);
  assert.equal(agentPeers(agent.work.store, { laneId: mine.laneId }).stalled, undefined);
  writeFileSync(join(peer.path, 'src/a.txt'), 'changed\n');
  assert.equal(agentPeers(agent.work.store, { laneId: mine.laneId }).stalled[0].lane, peer.laneId);
  await agent.dispatch({ action: 'checkpoint', actor: 'peer', laneId: peer.laneId, message: 'Save' });
  quiet(agent.work.store, peer);
  assert.equal(agentPeers(agent.work.store, { laneId: mine.laneId }).stalled[0].lane, peer.laneId);
  quiet(agent.work.store, peer, 'waiting');
  assert.equal(agentPeers(agent.work.store, { laneId: mine.laneId }).stalled, undefined);
});
test('take requires explicit foreign takeover, returns context, and crash recovery preserves ownership', async t => {
  const { agent, start } = fixture(t);
  const lane = await start('original', 'Recover interrupted work', ['src/a.txt']);
  writeFileSync(join(lane.path, 'src/a.txt'), 'retained dirty source\n');
  const denied = (await agent.dispatch({ action: 'take', laneId: lane.laneId, actor: 'replacement' })).result;
  assert.equal(denied.status, 'ownership');
  assert.equal(denied.ownership.actor, 'original');
  const pendingFinish = randomUUID();
  new FinishJournal(
    agent.work.store,
    {
      action: 'finish',
      operationId: pendingFinish,
      laneId: lane.laneId,
      expectedHead: lane.head,
      message: 'Resume interrupted check',
    },
    lane.head,
  );
  const command = {
    action: 'take',
    operationId: randomUUID(),
    laneId: lane.laneId,
    actor: 'replacement',
    takeover: true,
  };
  const taken = (await agent.dispatch(command)).result;
  assert.equal(taken.status, 'taken');
  assert.equal(readFileSync(join(lane.path, 'src/a.txt'), 'utf8'), 'retained dirty source\n');
  assert.equal(taken.brief.context.intent.outcome, 'Recover interrupted work');
  assert.equal(taken.brief.context.lane.path, lane.path);
  assert.equal(taken.lastCheck, null);
  assert.equal(taken.pending.finishes[0].operationId, pendingFinish);
  assert.equal(taken.pending.finishes[0].command.message, 'Resume interrupted check');
  const recovered = new AgentWorkflow(agent.work.store.root);
  assert.equal((await recovered.dispatch(command)).result.status, 'taken');
  assert.equal(agentPeers(recovered.work.store, { laneId: lane.laneId }).ownership.actor, 'replacement');
  const resume = (await recovered.dispatch({ action: 'take', laneId: lane.laneId, actor: 'replacement' }))
    .result;
  assert.equal(resume.status, 'taken');
  const original = (await recovered.dispatch({ action: 'take', laneId: lane.laneId, actor: 'original' }))
    .result;
  assert.equal(original.status, 'ownership');
  const saved = (
    await recovered.dispatch({
      action: 'checkpoint',
      laneId: lane.laneId,
      actor: 'original',
      message: 'Ownership remains advisory',
    })
  ).result;
  assert.equal(saved.peers.ownership.actor, 'replacement');
  await assert.rejects(
    recovered.dispatch({ ...command, actor: 'changed' }),
    error => error.code === 'WORK_OPERATION_CHANGED',
  );
});
function syntheticRun(store, lane, { status = 'queued', old = true, head = lane.base } = {}) {
  const viewId = randomUUID(),
    runId = randomUUID();
  const at = new Date(Date.now() - (old ? PRESENCE.workingMs + 1000 : 0)).toISOString();
  store.locked(() => {
    const tx = store.records();
    tx.append('views', {
      id: viewId,
      intentId: lane.intentId,
      base: lane.base,
      head,
      inputs: [{ laneId: lane.laneId, head }],
      status: 'clean',
      details: '',
      at,
    });
    tx.append('runs', {
      id: runId,
      viewId,
      head,
      base: lane.base,
      inputs: [{ laneId: lane.laneId, head }],
      dependencies: [],
      check: {
        id: randomUUID(),
        name: 'Synthetic',
        executable: '/synthetic/node',
        args: [],
        environmentLabel: 'Synthetic',
        definition: 'a'.repeat(64),
        at,
      },
      environment: {
        platform: 'synthetic',
        arch: 'synthetic',
        os: 'synthetic',
        node: 'synthetic',
        env: {},
        fingerprint: 'a'.repeat(64),
      },
      status,
      startedAt: at,
      queuedAt: at,
      runner: { pid: 1, host: 'synthetic' },
      details: '',
    });
    store.commitRecords(tx);
  });
  return runId;
}
test('take supersedes only stale queued checks pinned to an obsolete Lane head', async t => {
  const { agent, start } = fixture(t);
  const lane = await start('original', 'Queued checks', ['src/a.txt']);
  writeFileSync(join(lane.path, 'src/a.txt'), 'saved\n');
  const saved = (
    await agent.dispatch({ action: 'checkpoint', actor: 'original', laneId: lane.laneId, message: 'Save' })
  ).result;
  const stale = syntheticRun(agent.work.store, lane);
  const fresh = syntheticRun(agent.work.store, lane, { old: false });
  const running = syntheticRun(agent.work.store, lane, { status: 'running' });
  const current = syntheticRun(agent.work.store, lane, { head: saved.head });
  const command = {
    action: 'take',
    operationId: randomUUID(),
    laneId: lane.laneId,
    actor: 'replacement',
    takeover: true,
  };
  const result = (await agent.dispatch(command)).result;
  assert.deepEqual(result.superseded, [stale]);
  assert.equal(agent.work.store.select('runs', stale).cancelRequested, true);
  for (const id of [fresh, running, current])
    assert.equal(agent.work.store.select('runs', id).cancelRequested, undefined);
  assert.deepEqual((await agent.dispatch(command)).result.superseded, [stale]);
});
test('active check excludes a quiet Lane from stalled observations', async t => {
  const { agent, start } = fixture(t);
  const peer = await start('peer', 'Peer', ['src/a.txt']);
  const mine = await start('mine', 'Mine', ['src/a.txt']);
  writeFileSync(join(peer.path, 'src/a.txt'), 'saved\n');
  await agent.dispatch({ action: 'checkpoint', actor: 'peer', laneId: peer.laneId, message: 'Save' });
  const run = syntheticRun(agent.work.store, peer);
  quiet(agent.work.store, peer);
  assert.equal(agentPeers(agent.work.store, { laneId: mine.laneId }).stalled, undefined);
  agent.work.store.locked(() => {
    const tx = agent.work.store.records();
    tx.patchFields('runs', run, { status: 'failed' });
    agent.work.store.commitRecords(tx);
  });
  assert.equal(agentPeers(agent.work.store, { laneId: mine.laneId }).stalled[0].lane, peer.laneId);
});

test('ownership and stalled observations stay within the lifecycle digest budget', () => {
  const bounded = boundPeers({
    v: 1,
    coverage: 'local',
    ownership: { actor: 'x'.repeat(200), state: 'working' },
    stalled: Array.from({ length: 20 }, () => ({
      lane: randomUUID(),
      actor: 'x'.repeat(200),
      quietMs: 9999999,
      offer: 'take',
    })),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= PEERS_MAX_BYTES);
  assert.ok(bounded.stalled.length <= 3);
  assert.ok(bounded.more >= 17);
  const escaped = boundPeers({
    v: 1,
    coverage: 'local',
    ownership: { actor: '\n'.repeat(200), sessionId: '\n'.repeat(200), state: 'working' },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(escaped)) <= PEERS_MAX_BYTES);
});

test('handover includes notices and negotiation messages in its take-handoff briefing', async t => {
  const { agent, start } = fixture(t);
  const lane = await start('original', 'Original intent', ['src/a.txt']);
  const peer = await start('peer', 'Peer intent', ['src/a.txt']);
  writeFileSync(join(lane.path, 'src/a.txt'), 'mine\ntwo\n');
  writeFileSync(join(peer.path, 'src/a.txt'), 'peer\ntwo\n');
  await agent.dispatch({ action: 'checkpoint', actor: 'peer', laneId: peer.laneId, message: 'Peer context' });
  await agent.dispatch({
    action: 'checkpoint',
    actor: 'original',
    laneId: lane.laneId,
    message: 'Original context',
  });
  const notice = agentPeers(agent.work.store, { laneId: lane.laneId, detail: true }).conflicts[0];
  await agent.dispatch({
    action: 'peer-ack',
    laneId: peer.laneId,
    noticeId: notice.noticeId,
    choice: 'split',
    text: 'Preserve the shared test setup',
  });
  const command = {
    action: 'take',
    laneId: lane.laneId,
    operationId: randomUUID(),
    actor: 'replacement',
    takeover: true,
  };
  const taken = (await agent.dispatch(command)).result;
  assert.equal(taken.brief.situation, 'take-handoff');
  assert.equal(taken.brief.context.handoverTaken, true);
  assert.doesNotMatch(taken.brief.full, /Acknowledge through coordination/);
  assert.ok(taken.notices.some(item => item.noticeId === notice.noticeId));
  assert.ok(taken.messages.some(message => message.text === 'Preserve the shared test setup'));
  assert.ok(taken.brief.context.messages.some(message => message.text === 'Preserve the shared test setup'));
  assert.equal(taken.handovers.length, 1);
  assert.equal((await agent.dispatch(command)).result.handovers.length, 1);
  const other = await start('other');
  await assert.rejects(
    agent.dispatch({ ...command, laneId: other.laneId }),
    error => error.code === 'WORK_OPERATION_CHANGED',
  );
});

test('retry repairs a journal write interrupted after atomic ownership publication', async t => {
  const { agent, start } = fixture(t);
  const { CoordinationJournal } = await import('../dist/agent-coordination-journal.js');
  const lane = await start('original');
  const command = {
    action: 'take',
    operationId: randomUUID(),
    laneId: lane.laneId,
    actor: 'replacement',
    takeover: true,
  };
  const original = CoordinationJournal.prototype.handover;
  CoordinationJournal.prototype.handover = () => {
    throw new Error('Synthetic crash after Work commit');
  };
  try {
    await assert.rejects(agent.dispatch(command), /Synthetic crash/);
  } finally {
    CoordinationJournal.prototype.handover = original;
  }
  assert.equal(agent.work.store.select('lanes', lane.laneId).owner.actor, 'replacement');
  const recovered = new AgentWorkflow(agent.work.store.root);
  const result = (await recovered.dispatch(command)).result;
  assert.equal(result.status, 'taken');
  assert.equal(result.handovers.length, 1);
  assert.equal(recovered.work.store.select('lanes', lane.laneId).handovers.length, 1);
  await recovered.dispatch({ action: 'take', laneId: lane.laneId, actor: 'successor', takeover: true });
  const replayed = (await recovered.dispatch(command)).result;
  assert.equal(replayed.ownership.actor, 'successor');
  assert.equal(recovered.work.store.select('lanes', lane.laneId).owner.actor, 'successor');
});

test('persisted planned scopes retain the same safe relative-path contract as start', async t => {
  const { agent, start } = fixture(t);
  const lane = await start('owner', 'Safe scope', ['src/a.txt']);
  for (const path of ['../outside', '/absolute']) {
    assert.throws(() =>
      agent.work.store.locked(() => {
        const tx = agent.work.store.records();
        tx.patchFields('lanes', lane.laneId, { scope: { paths: [path] } });
      }),
    );
  }
  assert.deepEqual(agent.work.store.select('lanes', lane.laneId).scope.paths, ['src/a.txt']);
});

test('duplicate Intent index follows changed outcomes and rebuilds when deleted', async t => {
  const { agent, start } = fixture(t);
  const first = await start('first', 'Original outcome');
  const second = await start('second', 'Different outcome');
  assert.ok(
    duplicateStartWarnings(agent.work.store, second.laneId, 'Original outcome')[0].includes(first.laneId),
  );
  agent.work.store.locked(() => {
    const tx = agent.work.store.records();
    tx.patchFields('intents', first.intentId, { outcome: 'Renamed outcome' });
    agent.work.store.commitRecords(tx);
  });
  assert.deepEqual(duplicateStartWarnings(agent.work.store, second.laneId, 'Original outcome'), []);
  assert.ok(
    duplicateStartWarnings(agent.work.store, second.laneId, 'Renamed outcome')[0].includes(first.laneId),
  );
  const { digest } = await import('../dist/hash.js');
  rmSync(join(tmpdir(), `forge-peers-${process.getuid?.() ?? 'user'}`, digest(agent.work.store.root)), {
    recursive: true,
    force: true,
  });
  assert.ok(
    duplicateStartWarnings(agent.work.store, second.laneId, 'Renamed outcome')[0].includes(first.laneId),
  );
});

test('SM-C M11: a completed session is completed, not working, however recent its last activity', async () => {
  const { laneOwnership } = await import('../dist/agent-ownership.js');
  const now = Date.now(),
    lane = { id: 'lane-1', owner: { actor: 'builder', at: new Date(now).toISOString() } };
  const presence = status => ({
    s1: { sessionId: 's1', name: 'builder', context: { laneId: lane.id }, lastSeen: now - 1000, status },
  });
  for (const [status, state] of [
    ['working', 'working'],
    ['waiting', 'waiting'],
    ['completed', 'completed'],
  ])
    assert.equal(laneOwnership({}, lane, now, presence(status)).state, state, status);
  const old = presence('completed');
  old.s1.lastSeen = now - PRESENCE.workingMs - 1;
  assert.equal(laneOwnership({}, lane, now, old).state, 'completed');
});
