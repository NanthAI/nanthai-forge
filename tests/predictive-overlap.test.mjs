// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { digest } from '../dist/hash.js';
import { regionSummary, alignRegions } from '../dist/agent-region-summary.js';
import { regionsNear, predictiveOverlaps, overlapLines } from '../dist/agent-predictive-overlap.js';
import { agentPeers, boundPeers, PEERS_MAX_BYTES } from '../dist/agent-peers.js';
import { PeersCache } from '../dist/agent-peers-cache.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';

function memory() {
  const entries = new Map(),
    objects = new Map();
  const cache = { read: key => entries.get(key), write: (key, value) => entries.set(key, value) };
  const source = {
    object: key => {
      assert.ok(objects.has(key));
      return objects.get(key);
    },
  };
  const file = (path, text) => {
    const bytes = Buffer.from(text),
      blob = digest(bytes);
    objects.set(blob, bytes);
    return { path, blob, mode: 'file' };
  };
  const summary = (a, b) =>
    regionSummary(source, cache, digest(JSON.stringify(a)), digest(JSON.stringify(b)), () => [a, b]);
  return { cache, source, file, summary };
}
const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}\n`).join('');
const change = (at, value) => text.replace(`line ${at}\n`, `${value}\n`);
const lane = (id, state = 'active') => ({ id, head: id, state, startedAt: '2026-01-01' });

test('region overlap and adjacency include insertions and the exact three-line boundary', () => {
  assert.equal(regionsNear({ start: 10, lines: 3 }, { start: 12, lines: 2 }), true);
  assert.equal(regionsNear({ start: 10, lines: 1 }, { start: 13, lines: 1 }), true);
  assert.equal(regionsNear({ start: 10, lines: 1 }, { start: 14, lines: 1 }), false);
  assert.equal(regionsNear({ start: 10, lines: 0 }, { start: 10, lines: 0 }), true);
});

test('summaries keep separate hunks, deletions, insertions and new-file anchors', () => {
  const m = memory(),
    a = [m.file('a.txt', text)];
  const summary = m.summary(a, [
    m.file('a.txt', change(10, 'ten').replace('line 90\n', 'ninety\n')),
    m.file('new.txt', 'new\n'),
  ]);
  assert.deepEqual(summary.files[0].regions, [
    { start: 10, lines: 1 },
    { start: 90, lines: 1 },
  ]);
  assert.deepEqual(summary.files[1].regions, [{ start: 1, lines: 0 }]);
  const deleted = m.summary(a, []);
  assert.deepEqual(deleted.files[0].regions, [{ start: 1, lines: 100 }]);
  const inserted = m.summary(a, [m.file('a.txt', text.replace('line 20\n', 'insert\nline 20\n'))]);
  assert.deepEqual(inserted.files[0].regions, [{ start: 20, lines: 0 }]);
});

test('renames retain deletion at old path and addition at destination; mode changes are structural', () => {
  const m = memory(),
    a = m.file('a.txt', text),
    renamed = { ...a, path: 'renamed.txt' };
  const mine = m.summary([a], [renamed]),
    theirs = m.summary([a], [m.file('a.txt', change(50, 'peer'))]);
  assert.deepEqual(
    mine.files.map(f => f.path),
    ['a.txt', 'renamed.txt'],
  );
  assert.equal(predictiveOverlaps(m.source, m.cache, lane('a'), mine, lane('b'), theirs)[0].risk, 'high');
  assert.equal(m.summary([a], [{ ...a, mode: 'executable' }]).files[0].structural, true);
});

test('disjoint same-file edits are low; adjacent edits high; ready then smaller Lane lands first', () => {
  const m = memory(),
    a = [m.file('a.txt', text)];
  const mine = m.summary(a, [m.file('a.txt', change(10, 'mine'))]);
  const compare = (at, peer = lane('b')) =>
    predictiveOverlaps(
      m.source,
      m.cache,
      lane('a'),
      mine,
      peer,
      m.summary(a, [m.file('a.txt', change(at, 'peer'))]),
    )[0];
  assert.equal(compare(90).risk, 'low');
  assert.equal(compare(13).risk, 'high');
  assert.equal(compare(10, lane('b', 'ready')).first, 'b');
  const big = m.summary(a, [m.file('a.txt', text.replace('line 10\nline 11\n', 'large\n'))]);
  const prediction = predictiveOverlaps(m.source, m.cache, lane('a'), mine, lane('b'), big)[0];
  assert.equal(prediction.first, 'a');
  assert.equal(prediction.orderReason, 'smaller');
});

test('shared changed export is high even when its modified fields are far apart', () => {
  const m = memory(),
    schema = `export const row = z.object({\n${Array.from({ length: 80 }, (_, i) => `  f${i}: z.string(),`).join('\n')}\n});\n`;
  const a = [m.file('schema.ts', schema)];
  const mine = m.summary(a, [m.file('schema.ts', schema.replace('f1: z.string()', 'f1: z.number()'))]);
  const theirs = m.summary(a, [m.file('schema.ts', schema.replace('f70: z.string()', 'f70: z.number()'))]);
  const prediction = predictiveOverlaps(m.source, m.cache, lane('a'), mine, lane('b'), theirs)[0];
  assert.equal(prediction.risk, 'high');
  assert.equal(prediction.reason, 'export');
  assert.deepEqual(prediction.symbols, ['row']);
});

test('different bases align insertions, deletions and edits before comparing positions', () => {
  const m = memory(),
    old = m.file('a.txt', text),
    shifted = m.file('a.txt', `new header\n${text}`);
  const peer = m.summary([old], [m.file('a.txt', change(50, 'peer'))]).files[0];
  const mine = m.summary([shifted], [m.file('a.txt', `new header\n${change(50, 'mine')}`)]).files[0];
  assert.deepEqual(alignRegions(m.source, m.cache, peer, mine), [{ start: 51, lines: 1 }]);
  assert.match(
    overlapLines([
      {
        lane: 'peer',
        head: 'b'.repeat(64),
        file: 'a.txt',
        risk: 'high',
        reason: 'regions',
        mine: mine.regions,
        peer: peer.regions,
        alignedPeer: alignRegions(m.source, m.cache, peer, mine),
        first: 'mine',
        orderReason: 'smaller',
      },
    ])[0],
    /base 51-51 \/ aligned peer 51-51/,
  );
  const afterDeletion = m.file('a.txt', text.replace('line 1\n', ''));
  assert.deepEqual(alignRegions(m.source, m.cache, peer, { ...mine, before: afterDeletion.blob }), [
    { start: 49, lines: 1 },
  ]);
  const replaced = m.file('a.txt', text.replace('line 50\n', 'a\nb\n'));
  assert.deepEqual(alignRegions(m.source, m.cache, peer, { ...mine, before: replaced.blob }), [
    { start: 50, lines: 2 },
  ]);
});

test('binary and expensive alignment remain explicitly unavailable rather than disjoint', () => {
  const m = memory(),
    a = [m.file('a.bin', '\0a')];
  const mine = m.summary(a, [m.file('a.bin', '\0b')]);
  const theirs = m.summary(a, [m.file('a.bin', '\0c')]);
  assert.equal(mine.files[0].regions, null);
  assert.equal(predictiveOverlaps(m.source, m.cache, lane('a'), mine, lane('b'), theirs)[0].risk, 'unknown');
});

test('immutable head cache performs no source reads on a hit; new checkpoint invalidates', () => {
  const m = memory(),
    a = [m.file('a.txt', text)],
    b = [m.file('a.txt', change(10, 'mine'))];
  const first = regionSummary(m.source, m.cache, 'base', 'head1', () => [a, b]);
  const fail = () => {
    throw Error('cache hit read source');
  };
  assert.deepEqual(regionSummary({ object: fail }, m.cache, 'base', 'head1', fail), first);
  const next = regionSummary(m.source, m.cache, 'base', 'head2', () => [
    a,
    [m.file('a.txt', change(80, 'next'))],
  ]);
  assert.equal(next.files[0].regions[0].start, 80);
});

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-predictive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.txt'), text);
  initNative(root);
  const agent = new AgentWorkflow(root);
  // Synthetic accepted initial main; no publication or real check backend.
  agent.work.store.locked(() => {
    const tx = agent.work.store.records();
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head: tx.data().nativeHead,
      previous: null,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    agent.work.store.commitRecords(tx);
  });
  const start = async outcome => (await agent.dispatch({ action: 'start', outcome })).result;
  const save = async lane =>
    (await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Fixture checkpoint' }))
      .result;
  return { root, agent, start, save };
}

test('checkpoint, sync, status and MCP report latest peer checkpoint; dirty peers do not invalidate it', async t => {
  const { root, agent, start, save } = await fixture(t);
  const mine = await start('Change first region'),
    peer = await start('Change peer region');
  writeFileSync(join(mine.path, 'src/a.txt'), change(10, 'mine'));
  writeFileSync(join(peer.path, 'src/a.txt'), change(90, 'peer'));
  const savedPeer = await save(peer);
  const cp = await save(mine);
  assert.equal(cp.peers.predictive, undefined);
  const detailed = agentPeers(agent.work.store, { laneId: mine.laneId, detail: true });
  assert.equal(detailed.predictive[0].risk, 'low');
  assert.equal(detailed.predictive[0].head, savedPeer.head);
  writeFileSync(join(peer.path, 'src/a.txt'), change(11, 'peer'));
  assert.equal(agentPeers(agent.work.store, { laneId: mine.laneId, detail: true }).predictive[0].risk, 'low');
  const nextPeer = await save(peer);
  const next = await save(mine);
  assert.equal(next.peers.predictive[0].risk, 'high');
  assert.equal(next.peers.predictive[0].head, nextPeer.head);
  assert.equal(next.peers.predictive[0].intent, 'Change peer region');
  const before = readFileSync(join(root, '.forge/work/work.json'));
  const status = await agent.dispatch({ action: 'status', laneId: mine.laneId });
  assert.equal(status.result.peers.predictive[0].risk, 'high');
  assert.deepEqual(readFileSync(join(root, '.forge/work/work.json')), before);
  const synced = await agent.dispatch({ action: 'sync', laneId: mine.laneId });
  assert.equal(synced.result.peers.predictive[0].risk, 'high');
  const tools = new Map();
  registerAgentWorkflow({ registerTool: (name, _spec, handler) => tools.set(name, handler) }, root);
  const result = JSON.parse((await tools.get('forge_peers')({ laneId: mine.laneId })).content[0].text);
  assert.equal(result.predictive[0].risk, 'high');
  const cache = new PeersCache(agent.work.store.root),
    retained = agent.work.store.select('lanes', peer.laneId);
  assert.ok(cache.read(`regions-v1:${retained.base}:${retained.head}`));
  const cli = spawnSync(
    process.execPath,
    [resolve('dist/cli.js'), 'agent', root, 'status', JSON.stringify({ laneId: mine.laneId })],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).result.peers.predictive[0].risk, 'high');
  assert.equal(
    cli.stderr
      .trim()
      .split('\n')
      .filter(line => line.startsWith('Overlap ')).length,
    1,
  );
});

test('finish advises without blocking on adjacent checkpoint regions in a synthetic owner', async t => {
  const { root, agent, start, save } = await fixture(t);
  const mine = await start('Mine'),
    peer = await start('Peer');
  writeFileSync(join(mine.path, 'src/a.txt'), change(10, 'mine'));
  writeFileSync(join(peer.path, 'src/a.txt'), change(11, 'peer'));
  await save(peer);
  const check = (
    await agent.dispatch({
      action: 'define-check',
      name: 'verify',
      executable: process.execPath,
      args: ['-e', '0'],
    })
  ).result;
  const result = (
    await agent.dispatch({
      action: 'finish',
      laneId: mine.laneId,
      message: 'Synthetic finish',
      checkId: check.checkId,
    })
  ).result;
  assert.equal(result.peers.predictive[0].risk, 'high');
  assert.equal(result.status, 'passed');
  // Exercise the CLI parser/output without starting its detached presence daemon.
  const replay = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {agentCli} from ${JSON.stringify(new URL('../dist/agent-cli.js', import.meta.url).href)};
       console.log(JSON.stringify(await agentCli(process.argv.slice(1))));`,
      root,
      'finish',
      JSON.stringify({ operationId: result.operationId }),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(replay.status, 0, replay.stderr);
  const retained = JSON.parse(replay.stdout).result;
  assert.equal(retained.status, 'passed');
  assert.equal(retained.view.viewId, result.view.viewId);
  assert.equal(retained.peers.predictive[0].risk, 'high');
  assert.match(replay.stderr, /^Overlap /m);
});

test('50 peer predictions stay within compact receipt and human output budgets; detail retains all', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({
    lane: randomUUID(),
    head: 'a'.repeat(64),
    intent: `Peer ${i}`,
    file: 'src/a.txt',
    risk: 'high',
    reason: 'regions',
    mine: [{ start: 10, lines: 1 }],
    peer: [{ start: 11, lines: 1 }],
    first: randomUUID(),
    orderReason: 'smaller',
  }));
  const all = { predictive: items };
  assert.equal(boundPeers(structuredClone(all), true).predictive.length, 50);
  const compact = boundPeers(structuredClone(all));
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= PEERS_MAX_BYTES);
  assert.equal(compact.more + compact.predictive.length, 50);
  assert.ok(overlapLines(compact.predictive).length <= 3);
  assert.equal(overlapLines([{ ...items[0], risk: 'low' }]).length, 0);
  assert.equal(boundPeers({ predictive: [{ ...items[0], risk: 'low' }] }).predictive, undefined);
});

test('compact receipts omit detail-only contract deltas and detailed reads retain them', () => {
  const changes = Array.from({ length: 500 }, (_, i) => ({
    file: 'src/example.ts',
    export: `example${i}`,
    kind: 'changed',
  }));
  const full = { v: 1, coverage: 'local', changes };
  assert.ok(Buffer.byteLength(JSON.stringify(full)) > PEERS_MAX_BYTES);
  const compact = boundPeers(structuredClone(full));
  assert.equal(compact.changes, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= PEERS_MAX_BYTES);
  assert.deepEqual(boundPeers(structuredClone(full), true).changes, changes);
});
