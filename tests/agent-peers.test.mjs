// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { performance } from 'node:perf_hooks';
import { PeersSource } from '../dist/agent-peers-source.js';
import { agentPeers, boundPeers, PEERS_MAX_BYTES } from '../dist/agent-peers.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';

function fixture(t, native = true) {
  const root = mkdtempSync(join(tmpdir(), 'forge-peers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(root, 'src/b.txt'), 'other\n');
  if (native) initNative(root);
  else {
    const git = args =>
      execFileSync('git', ['-C', root, ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
          GIT_COMMITTER_NAME: 'Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        },
      });
    git(['init', '-q']);
    git(['add', '.']);
    git(['commit', '-qm', 'Initial']);
  }
  return { root, agent: new AgentWorkflow(root) };
}
async function start(agent, extra = {}) {
  return (await agent.dispatch({ action: 'start', outcome: 'Synthetic peer', ...extra })).result;
}
async function checkpoint(agent, lane) {
  return (
    await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Save synthetic source' })
  ).result;
}
function sourceFiles(root) {
  return readdirSync(join(root, '.forge/work/objects')).sort();
}
// Synthetic acceptance metadata isolates digest reads from the check/acceptance pipeline.
function land(agent, lane, head) {
  const store = agent.work.store;
  store.locked(() => {
    const tx = store.records();
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head,
      previous: lane.base,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
      acceptedBy: { kind: 'agent', name: 'fixture-lander' },
    });
    store.commitRecords(tx);
  });
}
for (const native of [true, false]) {
  test(`${native ? 'native' : 'Git'} empty, declared and dirty source overlaps; deterministic read-only digest`, async t => {
    const { root, agent } = fixture(t, native);
    const mine = await start(agent),
      peer = await start(agent, { actor: 'fixture-peer' });
    assert.deepEqual(mine.peers, { clear: true });
    assert.deepEqual(agentPeers(agent.work.store, { laneId: mine.laneId }), { clear: true });
    writeFileSync(join(peer.path, 'src/a.txt'), 'peer\ntwo\nthree\n');
    const input = { laneId: mine.laneId, scope: { paths: ['src/a.txt'] } };
    const before = readFileSync(join(agent.work.store.directory, 'work.json'));
    const objects = native ? sourceFiles(root) : null;
    const digest = agentPeers(agent.work.store, input);
    assert.equal(digest.coverage, 'local');
    assert.equal(digest.overlaps[0].lane, peer.laneId);
    assert.equal(digest.overlaps[0].actor, 'fixture-peer');
    assert.equal(digest.overlaps[0].via, 'scope');
    assert.deepEqual(digest.overlaps[0].paths, ['src/a.txt']);
    assert.deepEqual(agentPeers(agent.work.store, input), digest);
    writeFileSync(join(mine.path, 'src/a.txt'), 'one\ntwo\nmine\n');
    assert.equal(agentPeers(agent.work.store, { laneId: mine.laneId }).overlaps[0].via, 'edit');
    assert.deepEqual(readFileSync(join(agent.work.store.directory, 'work.json')), before);
    if (native) assert.deepEqual(sourceFiles(root), objects);
    const unrelated = await start(agent, { scope: { paths: ['src/b.txt'] } });
    assert.deepEqual(unrelated.peers, { clear: true });
  });
  test(`${native ? 'native' : 'Git'} clean checkpoint succeeds, replays unchanged head, rejects changed requests`, async t => {
    const { agent } = fixture(t, native),
      lane = await start(agent);
    const request = {
      action: 'checkpoint',
      operationId: randomUUID(),
      laneId: lane.laneId,
      expectedHead: lane.head,
      message: 'No change',
    };
    const saved = await agent.dispatch(request);
    assert.equal(saved.result.head, lane.head);
    assert.deepEqual(saved.result.peers, { clear: true });
    assert.deepEqual(await agent.dispatch(request), saved);
    await assert.rejects(
      agent.dispatch({ ...request, message: 'Changed identity' }),
      error => error.code === 'WORK_OPERATION_CHANGED',
    );
    if (!native) {
      writeFileSync(join(lane.path, 'src/a.txt'), 'unstaged\n');
      await assert.rejects(
        agent.dispatch({ ...request, operationId: randomUUID() }),
        error => error.code === 'NO_CHANGES',
      );
    }
  });
}
for (const conflict of [false, true])
  test(`landed since base, ${conflict ? 'conflicting' : 'clean'} dirty dry sync without mutations`, async t => {
    const { root, agent } = fixture(t),
      mine = await start(agent),
      peer = await start(agent);
    writeFileSync(join(peer.path, 'src/a.txt'), 'peer\ntwo\nthree\n');
    const saved = await checkpoint(agent, peer);
    land(agent, peer, saved.head);
    writeFileSync(join(mine.path, 'src/a.txt'), conflict ? 'mine\ntwo\nthree\n' : 'one\ntwo\nmine\n');
    const objects = sourceFiles(root),
      metadata = readFileSync(join(agent.work.store.directory, 'work.json'));
    const digest = agentPeers(agent.work.store, { laneId: mine.laneId });
    assert.equal(digest.coverage, 'local');
    assert.equal(digest.landed[0].head, saved.head);
    assert.equal(digest.landed[0].by, 'fixture-lander');
    assert.equal(digest.landed[0].sync, conflict ? 'conflict' : 'clean');
    assert.deepEqual(digest.landed[0].paths, ['src/a.txt']);
    assert.deepEqual(sourceFiles(root), objects);
    assert.deepEqual(readFileSync(join(agent.work.store.directory, 'work.json')), metadata);
    if (!conflict) {
      await checkpoint(agent, mine);
      const sync = (await agent.dispatch({ action: 'sync', laneId: mine.laneId })).result;
      assert.equal(sync.status, 'merged');
      assert.equal(sync.peers.landed, undefined);
    }
  });
test('20-Lane digest enforces byte/item/path caps with counts and full detail read', async t => {
  const { agent } = fixture(t),
    mine = await start(agent);
  for (let i = 0; i < 20; i++) {
    const peer = await start(agent, { actor: `Synthetic actor ${i} ${'界'.repeat(60)}` });
    for (let n = 0; n < 5; n++) writeFileSync(join(peer.path, `src/overlap-${n}.txt`), `${i}\n`);
  }
  const input = { laneId: mine.laneId, scope: { paths: ['src'] } };
  const all = agentPeers(agent.work.store, { ...input, detail: true });
  const digest = agentPeers(agent.work.store, input);
  assert.equal(all.coverage, 'local');
  assert.equal(all.overlaps.length, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(digest)) <= PEERS_MAX_BYTES);
  assert.equal(digest.more + (digest.overlaps?.length ?? 0), 20);
  assert.ok((digest.overlaps?.length ?? 0) === 10);
  assert.ok(digest.overlaps?.every(item => item.paths.length <= 3 && item.more === 2));
  for (let run = 1; run <= 3; run++) {
    const beforeStart = performance.now();
    agent.work.store.select('lanes', mine.laneId, 'id', true);
    const before = performance.now() - beforeStart;
    const afterStart = performance.now();
    agent.work.store.select('lanes', mine.laneId, 'id', true);
    const measured = agentPeers(agent.work.store, input);
    const after = performance.now() - afterStart;
    assert.equal(measured.coverage, 'local');
    t.diagnostic(
      JSON.stringify({
        fixture: '20-Lane',
        run,
        beforeMs: +before.toFixed(2),
        afterMs: +after.toFixed(2),
        addedMs: +(after - before).toFixed(2),
        bytes: Buffer.byteLength(JSON.stringify(measured)),
      }),
    );
  }
});
test('slow peer reads finish with complete coverage; unavailable source stays incomplete', async t => {
  const { agent } = fixture(t),
    mine = await start(agent),
    peer = await start(agent);
  writeFileSync(join(peer.path, 'src/a.txt'), 'peer\n');
  const input = { laneId: mine.laneId, scope: { paths: ['src/a.txt'] }, detail: true };
  const live = PeersSource.prototype.live;
  let paused = false;
  const slowRead = t.mock.method(PeersSource.prototype, 'live', function (...args) {
    if (!paused) {
      paused = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2100);
    }
    return live.apply(this, args);
  });
  try {
    const result = agentPeers(agent.work.store, input);
    assert.equal(paused, true);
    assert.equal(result.coverage, 'local');
    assert.deepEqual(
      result.overlaps.map(item => item.lane),
      [peer.laneId],
    );
  } finally {
    slowRead.mock.restore();
  }
  // Neither a warm cache nor successful prior reads establish current availability.
  rmSync(join(peer.path, '.forge/native.json'));
  const missing = agentPeers(agent.work.store, input);
  assert.equal(missing.coverage, 'local-incomplete');
  assert.equal(missing.clear, undefined);
});
test('unavailable source never blocks a lifecycle receipt or claims clear; no Work format change', async t => {
  const { agent } = fixture(t),
    lane = await start(agent);
  const schema = agent.work.store.load().schema;
  const object = join(agent.work.store.directory, 'objects', lane.head);
  const original = readFileSync(object);
  writeFileSync(object, 'Synthetic unavailable source');
  try {
    const digest = agentPeers(agent.work.store, { laneId: lane.laneId });
    assert.equal(digest.coverage, 'local-incomplete');
    assert.equal(digest.clear, undefined);
  } finally {
    writeFileSync(object, original);
  }
  assert.equal(agent.work.store.load().schema, schema);
});
test('MCP forge_task receipts and forge_peers match CLI reads', async t => {
  const { root, agent } = fixture(t),
    mine = await start(agent),
    peer = await start(agent);
  writeFileSync(join(peer.path, 'src/a.txt'), 'peer\n');
  const tools = new Map();
  registerAgentWorkflow(
    {
      registerTool(name, config, handler) {
        tools.set(name, handler);
      },
    },
    root,
  );
  const input = { laneId: mine.laneId, scope: { paths: ['src/a.txt'] } };
  const expected = agentPeers(new WorkStore(root), input);
  const mcp = JSON.parse((await tools.get('forge_peers')(input)).content[0].text);
  assert.deepEqual(mcp, expected);
  const cli = JSON.parse(
    execFileSync(process.execPath, [resolve('dist/cli.js'), 'agent', root, 'peers', JSON.stringify(input)], {
      encoding: 'utf8',
    }),
  );
  assert.deepEqual(cli.result, expected);
  const cp = JSON.parse(
    (
      await tools.get('forge_task')({
        command: { action: 'checkpoint', ...input, message: 'Clean MCP checkpoint' },
      })
    ).content[0].text,
  );
  assert.deepEqual(cp.result.peers, expected);
  const started = JSON.parse(
    (
      await tools.get('forge_task')({
        command: { action: 'start', outcome: 'MCP declared scope', scope: input.scope },
      })
    ).content[0].text,
  );
  assert.equal(started.result.peers.overlaps[0].lane, peer.laneId);
  const check = (
    await agent.dispatch({
      action: 'define-check',
      name: 'verify',
      executable: process.execPath,
      args: ['-e', '0'],
    })
  ).result;
  const finished = JSON.parse(
    (
      await tools.get('forge_task')({
        command: {
          action: 'finish',
          laneId: mine.laneId,
          message: 'MCP finish',
          checkId: check.checkId,
          scope: input.scope,
        },
      })
    ).content[0].text,
  );
  assert.ok(finished.result.peers.overlaps.some(item => item.lane === peer.laneId));
  assert.equal(
    finished.result.peers.overlaps.find(item => item.lane === started.result.laneId).claim,
    'planned',
  );
});

test('caps landed entries and long escaped paths within the byte budget', () => {
  const full = {
    v: 1,
    coverage: 'local',
    landed: Array.from({ length: 9 }, (_, n) => ({
      head: String(n).repeat(64),
      paths: ['path', 'a', 'b', 'c'],
      sync: 'clean',
    })),
  };
  const bounded = boundPeers(full);
  assert.equal(bounded.landed.length, 5);
  assert.equal(bounded.more, 4);
  assert.ok(bounded.landed.every(item => item.more === 1));
  const huge = boundPeers({
    v: 1,
    coverage: 'local',
    landed: [{ head: 'a'.repeat(64), paths: ['界'.repeat(6000)], sync: 'conflict' }],
  });
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= PEERS_MAX_BYTES);
  assert.equal(huge.more, 1);
});
test('digest takes no locks and unavailable digest does not fail a successful checkpoint', async t => {
  const { agent } = fixture(t),
    lane = await start(agent);
  const store = agent.work.store,
    locked = store.locked,
    laneLocked = store.laneLocked;
  store.locked = store.laneLocked = () => {
    throw Error('Unexpected digest lock');
  };
  try {
    assert.deepEqual(agentPeers(store, { laneId: lane.laneId }), { clear: true });
  } finally {
    store.locked = locked;
    store.laneLocked = laneLocked;
  }
  const live = PeersSource.prototype.live;
  PeersSource.prototype.live = () => {
    throw Error('Synthetic digest failure');
  };
  try {
    const saved = await checkpoint(agent, lane);
    assert.equal(saved.head, lane.head);
    assert.equal(saved.peers.coverage, 'local-incomplete');
  } finally {
    PeersSource.prototype.live = live;
  }
});
test('accepted peer source is not reported as in-flight overlap; deletions are relevant', async t => {
  const { agent } = fixture(t),
    mine = await start(agent),
    peer = await start(agent);
  writeFileSync(join(peer.path, 'src/a.txt'), 'accepted\n');
  const saved = await checkpoint(agent, peer);
  land(agent, peer, saved.head);
  const input = { laneId: mine.laneId, scope: { paths: ['src/a.txt'] } };
  assert.equal(agentPeers(agent.work.store, input).overlaps, undefined);
  rmSync(join(peer.path, 'src/a.txt'));
  const digest = agentPeers(agent.work.store, input);
  assert.deepEqual(digest.overlaps[0].paths, ['src/a.txt']);
});

test('50-Lane complete coverage survives stale and deleted derived indexes', async t => {
  const { agent } = fixture(t),
    mine = await start(agent);
  const peers = [];
  for (let i = 0; i < 50; i++) peers.push(await start(agent));
  const input = { laneId: mine.laneId, scope: { paths: ['src'] }, detail: true };
  const observe = () => agentPeers(agent.work.store, input);
  assert.deepEqual(observe(), { clear: true });
  // Warm indexes must not hide dirty changes, new files, deletions or ignore changes.
  writeFileSync(join(peers[0].path, 'src/a.txt'), 'changed\n');
  writeFileSync(join(peers[1].path, 'src/new.txt'), 'new\n');
  rmSync(join(peers[2].path, 'src/b.txt'));
  let result = observe();
  assert.equal(result.coverage, 'local');
  assert.equal(result.overlaps.length, 3);
  // A changed Work page must refresh the changed Lane rather than trusting its old head.
  await checkpoint(agent, peers[0]);
  assert.equal(observe().overlaps.length, 3);
  const { digest } = await import('../dist/hash.js');
  const cache = join(tmpdir(), `forge-peers-${process.getuid?.() ?? 'user'}`, digest(agent.work.store.root));
  rmSync(cache, { recursive: true, force: true });
  result = observe();
  assert.equal(result.coverage, 'local');
  assert.equal(result.overlaps.length, 3);
  for (const name of readdirSync(cache)) writeFileSync(join(cache, name), '{}');
  // Corrupt disposable indexes rebuild in this observation, even on a slow machine.
  result = observe();
  assert.equal(result.coverage, 'local');
  assert.equal(result.overlaps.length, 3);
  // Unavailable open source is partial, then recovers on the next observation.
  const retained = readFileSync(join(peers[3].path, '.forge/native.json'));
  rmSync(join(peers[3].path, '.forge/native.json'));
  assert.equal(agentPeers(agent.work.store, input).coverage, 'local-incomplete');
  writeFileSync(join(peers[3].path, '.forge/native.json'), retained);
  assert.equal(observe().coverage, 'local');
  const times = [];
  for (let i = 0; i < 20; i++) {
    const began = performance.now();
    const measured = agentPeers(agent.work.store, input);
    assert.equal(measured.coverage, 'local');
    assert.equal(measured.overlaps.length, 3);
    times.push(performance.now() - began);
  }
  times.sort((a, b) => a - b);
  t.diagnostic(
    JSON.stringify({
      fixture: '50-Lane',
      medianMs: times[10],
      p95Ms: times[18],
      complete: times.length,
    }),
  );
  rmSync(cache, { recursive: true, force: true });
});

test('warm indexes observe ignore edits and reject redirected parents', async t => {
  const { agent } = fixture(t),
    mine = await start(agent),
    peer = await start(agent);
  const input = { laneId: mine.laneId, scope: { paths: ['src'] }, detail: true };
  writeFileSync(join(peer.path, '.gitignore'), 'src/new.txt\n');
  writeFileSync(join(peer.path, 'src/new.txt'), 'new\n');
  assert.deepEqual(agentPeers(agent.work.store, input), { clear: true });
  writeFileSync(join(peer.path, '.gitignore'), '');
  assert.deepEqual(agentPeers(agent.work.store, input).overlaps[0].paths, ['src/new.txt']);
  renameSync(join(peer.path, 'src'), join(peer.path, 'relocated'));
  symlinkSync(join(peer.path, 'relocated'), join(peer.path, 'src'));
  assert.equal(
    agentPeers(agent.work.store, { laneId: mine.laneId, scope: { paths: ['src/a.txt'] } }).coverage,
    'local-incomplete',
  );
});
