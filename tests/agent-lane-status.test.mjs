// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AgentWorkflow } from './agent-advisory-fixture.mjs';
import { initNative } from '../dist/native-work.js';
import { laneSchema } from '../dist/work-types.js';
import { laneSummary } from '../dist/work-hosted-summary.js';
import { syncSummary } from '../dist/agent-operation-summary.js';

const git = (root, args) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  }).trim();
function fixture(t, native) {
  const root = mkdtempSync(join(tmpdir(), 'forge-lane-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file.txt'), 'original\n');
  if (native) initNative(root);
  else {
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'Initial']);
  }
  return new AgentWorkflow(root);
}
const start = async (agent, extra = {}) =>
  (await agent.dispatch({ action: 'start', outcome: 'Synthetic Lane', ...extra })).result;
for (const native of [true, false]) {
  test(`${native ? 'native' : 'Git'} status selects one Lane and measures compact JSON bytes`, async t => {
    const agent = fixture(t, native),
      lane = await start(agent);
    const sibling = await start(agent, { intentId: lane.intentId });
    await start(agent);
    const empty = (await agent.dispatch({ action: 'status', laneId: lane.laneId })).result.lane;
    // Keep this assertion after the measurement so the original implementation produces a baseline.

    writeFileSync(join(lane.path, 'file.txt'), 'changed\n');
    if (!native) git(lane.path, ['add', '.']);
    const checkpoint = await agent.dispatch({
      action: 'checkpoint',
      laneId: lane.laneId,
      message: 'Save fixture',
    });
    const view = (
      await agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId: lane.intentId,
        inputs: [{ laneId: lane.laneId, head: checkpoint.result.head }],
      })
    ).result;
    await agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: [{ laneId: sibling.laneId, head: sibling.head }],
    });
    await agent.dispatch({
      action: 'define-check',
      name: 'verify',
      executable: process.execPath,
      args: ['-e', '0'],
    });
    const run = (await agent.dispatch({ action: 'run', viewId: view.viewId })).result;
    const selected = await agent.dispatch({ action: 'status', laneId: lane.laneId });
    t.diagnostic(`selected status bytes: ${Buffer.byteLength(JSON.stringify(selected))}`);
    assert.equal(selected.result.lane.laneId, lane.laneId);
    assert.equal(empty.candidates.total, 0);
    assert.equal(empty.lastCheck, null);
    assert.equal(selected.result.lane.head, checkpoint.result.head);
    assert.equal(selected.result.lane.base, lane.base);
    assert.equal(selected.result.lane.saves, 1);
    assert.equal(selected.result.lane.changedPathCount, 1);
    assert.equal(selected.result.lane.changedPathsSource, 'saved-head');
    assert.equal(selected.result.lane.candidates.total, 1);
    assert.equal(selected.result.lane.candidates.items[0].viewId, view.viewId);
    assert.equal(selected.result.lane.lastCheck.operationId, run.operationId);
    assert.equal(selected.result.lane.lastCheck.status, 'passed');
    assert.ok(!('intents' in selected.result) && !('checkCosts' in selected.result));
    const detail = await agent.dispatch({ action: 'status', laneId: lane.laneId, detail: true });
    assert.equal(detail.result.lane.laneId, lane.laneId);
    assert.equal(detail.result.lanes.total, 3);
    assert.equal((await agent.dispatch({ action: 'status', intentId: lane.intentId })).result.lanes.total, 2);
    await assert.rejects(agent.dispatch({ action: 'status', laneId: randomUUID() }), { code: 'NOT_FOUND' });
    await assert.rejects(
      agent.dispatch({ action: 'status', laneId: lane.laneId, intentId: sibling.laneId }),
      { code: 'NOT_FOUND' },
    );
    const records = agent.work.store.readRecords.bind(agent.work.store);
    agent.work.store.readRecords = () => undefined;
    try {
      const legacy = await agent.dispatch({ action: 'status', laneId: lane.laneId });
      assert.deepEqual(legacy.result, selected.result);
    } finally {
      agent.work.store.readRecords = records;
    }
  });
  test(`${native ? 'native' : 'Git'} new and sibling Lanes retain exact start times on replay`, async t => {
    const agent = fixture(t, native),
      before = new Date().toISOString();
    const command = { action: 'start', operationId: randomUUID(), outcome: 'Synthetic start' };
    const lane = (await agent.dispatch(command)).result;
    assert.ok(lane.startedAt >= before && lane.startedAt <= new Date().toISOString());
    assert.equal((await agent.dispatch(command)).result.startedAt, lane.startedAt);
    const sibling = await start(agent, { intentId: lane.intentId });
    assert.ok(sibling.startedAt);
    const stored = agent.work.store.select('lanes', sibling.laneId);
    assert.equal(stored.startedAt, sibling.startedAt);
    assert.equal(laneSummary(stored).startedAt, sibling.startedAt);
    const historical = { ...stored };
    delete historical.startedAt;
    assert.equal(laneSchema.parse(historical).startedAt, undefined);
    assert.ok(!('startedAt' in laneSummary(historical)));
    assert.equal(
      (await agent.dispatch({ action: 'making-of', intentId: lane.intentId })).result.lanes[1].startedAt,
      sibling.startedAt,
    );
  });
}
test('sync and checkpoint lead with additive one-line summaries and opt-in peer detail', async t => {
  const agent = fixture(t, true),
    lane = await start(agent),
    peer = await start(agent);
  writeFileSync(join(lane.path, 'file.txt'), 'one\n');
  writeFileSync(join(lane.path, 'code.js'), 'export const added = 1;\n');
  writeFileSync(join(peer.path, 'file.txt'), 'peer\n');
  const checkpoint = await agent.dispatch({
    action: 'checkpoint',
    laneId: lane.laneId,
    message: 'Save fixture',
  });
  assert.equal(Object.keys(checkpoint)[0], 'summary');
  assert.equal(checkpoint.summary, 'saved Lane checkpoint');
  assert.ok(!checkpoint.result.peers.changes);
  const expanded = await agent.dispatch({
    action: 'checkpoint',
    laneId: lane.laneId,
    message: 'Already saved',
    detail: true,
  });
  assert.ok(expanded.result.peers.changes.length);
  const store = agent.work.store;
  store.locked(() => {
    const tx = store.records();
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head: lane.base,
      previous: null,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    store.commitRecords(tx);
  });
  const synced = await agent.dispatch({ action: 'sync', laneId: lane.laneId });
  assert.equal(Object.keys(synced)[0], 'summary');
  assert.equal(synced.summary, 'up-to-date with main');
  assert.equal(synced.result.status, 'up-to-date');
  assert.equal(
    syncSummary({ status: 'merged', changedPaths: ['a', 'b', 'c'] }, 'main'),
    'merged 3 files from main',
  );
  assert.equal(
    syncSummary({ status: 'conflict', conflicts: [{ path: 'a' }] }, 'release'),
    'conflicts in 1 file from release',
  );
});

for (const native of [true, false])
  for (const conflict of [false, true]) {
    test(`${native ? 'native' : 'Git'} sync summary describes ${conflict ? 'conflicts' : 'merged files'} and replay`, async t => {
      const agent = fixture(t, native),
        lane = await start(agent),
        peer = await start(agent);
      writeFileSync(join(lane.path, 'file.txt'), 'mine\n');
      writeFileSync(join(peer.path, conflict ? 'file.txt' : 'other.txt'), 'peer\n');
      for (const current of [lane, peer]) {
        if (!native) git(current.path, ['add', '.']);
        await agent.dispatch({ action: 'checkpoint', laneId: current.laneId, message: 'Save fixture' });
      }
      const store = agent.work.store,
        target = store.select('lanes', peer.laneId).head;
      store.locked(() => {
        const tx = store.records();
        tx.append('channelMoves', {
          id: randomUUID(),
          channel: 'main',
          viewId: randomUUID(),
          head: target,
          previous: lane.base,
          at: new Date().toISOString(),
          status: 'accepted',
          provenance: 'user-declared-local',
        });
        if (!native) git(store.root, ['update-ref', 'refs/forge/channels/main', target]);
        store.commitRecords(tx);
      });
      const command = {
        action: 'sync',
        operationId: randomUUID(),
        laneId: lane.laneId,
        expectedHead: store.select('lanes', lane.laneId).head,
      };
      const result = await agent.dispatch(command);
      assert.equal(result.summary, conflict ? 'conflicts in 1 file from main' : 'merged 1 file from main');
      assert.equal(result.result.status, conflict ? 'conflict' : 'merged');
      const replay = await agent.dispatch(command);
      assert.equal(replay.summary, result.summary);
      assert.equal(replay.result.head, result.result.head);
    });
  }

test('Lane status pages only participating Candidates and keeps missing source explicitly unknown', async t => {
  const agent = fixture(t, true),
    lane = await start(agent);
  writeFileSync(join(lane.path, 'file.txt'), 'saved\n');
  const cp = (await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Save' })).result;
  const first = (
    await agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: [{ laneId: lane.laneId, head: cp.head }],
    })
  ).result;
  const second = (
    await agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: [{ laneId: lane.laneId, head: cp.head }],
    })
  ).result;
  const status = async extra =>
    (await agent.dispatch({ action: 'status', laneId: lane.laneId, limit: 1, ...extra })).result.lane;
  const page = await status({});
  assert.equal(page.candidates.total, 2);
  assert.equal(page.candidates.items[0].viewId, second.viewId);
  assert.equal(page.candidates.nextOffset, 1);
  const next = await status({ offset: page.candidates.nextOffset });
  assert.equal(next.candidates.items[0].viewId, first.viewId);
  assert.equal(next.candidates.more, false);
  writeFileSync(join(lane.path, 'unsaved.txt'), 'unsaved\n');
  assert.equal((await status({})).changedPathCount, 1);
  rmSync(join(agent.work.store.root, '.forge', 'work', 'objects', cp.head));
  const missing = await status({});
  assert.equal(missing.changedPathCount, null);
  assert.equal(missing.changedPathsError.code, 'INVALID_NATIVE_SOURCE');
});

for (const native of [true, false]) {
  test(`${native ? 'native' : 'Git'} Work Lane writers record their creation time`, async t => {
    const agent = fixture(t, native),
      work = agent.work;
    const intent = (
      await work.dispatch({ action: 'intent', outcome: 'Synthetic Work Lane' }, work.store.revision())
    ).result;
    const before = new Date().toISOString();
    const lane = (
      await work.dispatch({ action: 'lane', intentId: intent.id, name: 'Work Lane' }, work.store.revision())
    ).result;
    assert.ok(lane.startedAt >= before && lane.startedAt <= new Date().toISOString());
    assert.equal(work.store.select('lanes', lane.id).startedAt, lane.startedAt);
  });
}

test('Lane status retains auto-snapshot notices alongside landing progress without history ETA', async t => {
  const { LandJournal } = await import('../dist/land-journal.js');
  const { landSchema } = await import('../dist/land-schema.js');
  const { snapshotLane } = await import('../dist/lane-auto-snapshot.js');
  const agent = fixture(t, true),
    lane = await start(agent);
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', '0'],
  });
  const journal = new LandJournal(
    agent.work.store,
    landSchema.parse({ action: 'land', operationId: randomUUID(), laneIds: [lane.laneId] }),
  );
  writeFileSync(join(lane.path, 'file.txt'), 'unsaved edit\n');
  const snapshot = snapshotLane(agent.work.store, lane.laneId);
  assert.equal(snapshot.status, 'snapshot');
  const status = (await agent.dispatch({ action: 'status', laneId: lane.laneId })).result.lane;
  assert.equal(status.autoSnapshot.state, snapshot.state);
  assert.equal(status.autoSnapshot.parent, lane.head);
  assert.deepEqual(status.autoSnapshot.paths, ['file.txt']);
  assert.match(status.autoSnapshot.notice, /Unsaved edits recovered from auto-snapshot at /);
  assert.equal(status.head, lane.head);
  assert.equal(status.landing.operationId, journal.state.entries[0].command.operationId);
  assert.equal(status.landing.phases.current, 'queued');
  assert.equal(status.landing.phases.eta, undefined);
  assert.equal(status.landing.phases.timeline[0].startedAt, 'unknown');
  assert.deepEqual(status.submissions[0].phases, status.landing.phases);
});

test('Lane status exposes an estimate from completed owner landing history', async t => {
  const { LandJournal } = await import('../dist/land-journal.js');
  const { landSchema } = await import('../dist/land-schema.js');
  const { trustAgents } = await import('./autonomy-fixture.mjs');
  const { drainPostAccept } = await import('../dist/post-accept-main.js');
  const agent = fixture(t, true);
  trustAgents(agent.work.store.root);
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', '0'],
  });
  await agent.dispatch({ action: 'set-policy', operationId: randomUUID(), checks: { runner: 'local' } });
  const old = await start(agent);
  writeFileSync(join(old.path, 'file.txt'), 'history change\n');
  await agent.dispatch({ action: 'checkpoint', laneId: old.laneId, message: 'History fixture' });
  const landed = (
    await agent.dispatch({ action: 'land', operationId: randomUUID(), laneIds: [old.laneId], wait: true })
  ).result;
  assert.equal(landed.complete, true);
  // Join the prior landing's audit writer before the fixture's zero-wait mutations.
  await drainPostAccept(agent.work.store);
  const next = await start(agent);
  new LandJournal(
    agent.work.store,
    landSchema.parse({ action: 'land', operationId: randomUUID(), laneIds: [next.laneId] }),
  );
  const status = (await agent.dispatch({ action: 'status', laneId: next.laneId })).result.lane;
  assert.equal(status.landing.phases.current, 'queued');
  assert.equal(status.landing.phases.eta.label, 'estimate');
  assert.equal(status.landing.phases.eta.samples, 1);
  assert.equal(status.landing.phases.eta.historyLimit, 20);
});
