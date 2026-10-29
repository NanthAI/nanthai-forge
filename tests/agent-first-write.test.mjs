import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentWorkflow } from './agent-advisory-fixture.mjs';
import { initNative } from '../dist/native-work.js';
import { readNativeSourceReviewBytes } from '../dist/native-source-review.js';
import { NativeSource } from '../dist/native-source.js';
import { preEdit } from '../dist/agent-pre-edit.js';
import { readEditPeers } from '../dist/agent-edit-peers.js';
import { unacknowledgedOverlaps } from '../dist/agent-edit-notices.js';
import { readSelfMetricJournal } from '../dist/self-metrics-journal.js';
import { calculateOverlapMetrics } from '../dist/self-metrics-joins.js';
import { snapshotLane, readAutoSnapshot } from '../dist/lane-auto-snapshot.js';
import { recordEditContext, readEditContext, recordAgentTurn } from '../dist/agent-edit-context.js';

const context = (sessionId = 'agent-one', turnId = 'turn-one') => ({
  agent: 'codex',
  sessionId,
  turnId,
  link: 'codex://sessions/synthetic/turns/one',
});
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-first-write-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  mkdirSync(join(root, 'docs'));
  for (const file of ['status.md', 'architecture.md', 'roadmap.md'])
    writeFileSync(join(root, 'docs', file), 'Original synthetic document\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  const start = async (extra = {}) =>
    (
      await agent.dispatch({
        action: 'start',
        outcome: 'Synthetic overlapping documentation change',
        ...extra,
      })
    ).result;
  return { root, agent, store, start };
}

test('four-Lane docs replay alerts both agents before either overlapping write and records all answers', async t => {
  const f = await fixture(t);
  const paths = ['docs/status.md', 'docs/architecture.md', 'docs/roadmap.md'];
  const lanes = [];
  for (let i = 0; i < 4; i++) lanes.push(await f.start({ actor: `agent-${i}`, scope: { paths } }));
  const from = new Date().toISOString();
  const before = f.store.revision();
  // peers --path is strictly a read, including on a pristine claimed path.
  const peers = readEditPeers(f.root, lanes[0].laneId, paths[0]);
  assert.equal(peers.overlaps.length, 3);
  assert.equal(f.store.revision(), before);
  for (const [i, lane] of lanes.entries()) {
    for (const path of paths) {
      const result = preEdit(f.root, lane.laneId, [path], context(`session-${i}`));
      assert.equal(result.status, 'overlap');
      assert.equal(result.count, 3);
      assert.equal(readFileSync(join(lane.path, path), 'utf8'), 'Original synthetic document\n');
      for (const overlap of result.overlaps) {
        const command = {
          action: 'peer-ack',
          operationId: randomUUID(),
          laneId: lane.laneId,
          noticeId: overlap.noticeId,
          choice: 'accept-order',
        };
        const first = await f.agent.dispatch(command);
        const replay = await f.agent.dispatch(command);
        assert.deepEqual(first.result.acknowledgement, replay.result.acknowledgement);
        await assert.rejects(f.agent.dispatch({ ...command, choice: 'split' }), {
          code: 'WORK_OPERATION_CHANGED',
        });
      }
      assert.equal(preEdit(f.root, lane.laneId, [path], context(`session-${i}`)).status, 'allowed');
      assert.equal(preEdit(f.root, lane.laneId, [path], context(`session-${i}`, 'next-turn')).checked, 0);
      writeFileSync(join(lane.path, path), `Synthetic agent ${i}\n`);
    }
  }
  const notes = lanes
    .flatMap(lane => f.store.select('intents', lane.intentId).notes)
    .filter(note => note.overlapAnswer);
  assert.equal(notes.length, 36);
  assert.ok(notes.every(note => note.conversation?.sessionId.startsWith('session-')));
  const events = readSelfMetricJournal(f.store.directory).receipts;
  const metric = calculateOverlapMetrics(
    { receipts: events, coverage: { overlapAnswers: from } },
    { from, to: new Date(Date.now() + 1).toISOString() },
  );
  assert.equal(metric.firstWriteAlerts, 36);
  assert.equal(metric.firstWriteAcknowledgedOrRouted, 36);
  assert.equal(metric.firstWriteAcknowledgementRate, 1);
  assert.equal(metric.firstWrites, 12);
  assert.equal(metric.overlappingSaves, 12);
  assert.equal(metric.acknowledgementRate, 1);
  assert.equal(
    events.filter(
      event => ['start', 'checkpoint', 'sync', 'finish', 'land'].includes(event.action) && event.errorCode,
    ).length,
    0,
  );
  t.diagnostic(
    'Synthetic incident: 36/36 pair × file × participant first-write alerts, 36/36 portable answers; no writes before acknowledgement.',
  );
});

test('unacknowledged response payload survives delivery, caps at five, and clears only the answering Lane', async t => {
  const f = await fixture(t),
    mine = await f.start();
  for (let i = 0; i < 8; i++) await f.start({ scope: { paths: ['docs/status.md'] } });
  const blocked = preEdit(f.root, mine.laneId, ['docs/status.md'], context());
  assert.equal(blocked.count, 8);
  assert.equal(
    readEditContext(f.store.directory, mine.laneId),
    undefined,
    'a blocked edit must not become source provenance',
  );
  let response = await f.agent.dispatch({ action: 'policy', laneId: mine.laneId });
  assert.equal(response.unacknowledgedOverlaps.count, 8);
  assert.equal(response.unacknowledgedOverlaps.items.length, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(response.unacknowledgedOverlaps)) < 4096);
  const tools = new Map();
  const close = registerAgentWorkflow(
    {
      registerTool(name, _config, handler) {
        tools.set(name, handler);
      },
    },
    f.root,
  );
  const revision = f.store.revision();
  const brief = await tools.get('forge_brief')({
    situation: 'continue-lane',
    laneId: mine.laneId,
    agent: 'generic',
  });
  assert.equal(JSON.parse(brief.content[0].text).unacknowledgedOverlaps.count, 8);
  const queue = await tools.get('forge_queue')({ action: 'list' });
  assert.ok(Array.isArray(JSON.parse(queue.content[0].text)));
  assert.equal(JSON.parse(queue.content[1].text).unacknowledgedOverlaps.count, 8);
  const failure = await tools.get('forge_queue')({ action: 'cancel' });
  assert.equal(failure.isError, true);
  assert.equal(JSON.parse(failure.content[0].text).unacknowledgedOverlaps.count, 8);
  assert.equal(f.store.revision(), revision);
  const cli = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
      'agent',
      f.root,
      'show',
      JSON.stringify({ laneId: mine.laneId, path: 'missing.txt' }),
    ],
    { encoding: 'utf8', env: { ...process.env, FORGE_LANE_ID: mine.laneId } },
  );
  assert.equal(cli.status, 1);
  assert.equal(JSON.parse(cli.stderr.trim().split('\n').at(-1)).unacknowledgedOverlaps.count, 8);
  const notice = response.unacknowledgedOverlaps.items[0];
  const peer = notice.lanes.find(id => id !== mine.laneId);
  await f.agent.dispatch({
    action: 'peer-ack',
    laneId: mine.laneId,
    noticeId: notice.noticeId,
    choice: 'split',
  });
  response = await f.agent.dispatch({ action: 'policy' });
  assert.equal(response.unacknowledgedOverlaps.count, 7);
  assert.equal(unacknowledgedOverlaps(f.store.directory, peer).count, 1);
  const notes = f.store.select('intents', mine.intentId).notes;
  assert.equal(notes.find(note => note.overlapAnswer).overlapAnswer.disposition, 'routed-around');
  await close();
});

test('undeclared first-edit claims are bilateral and routing to another path proceeds', async t => {
  const f = await fixture(t),
    a = await f.start(),
    b = await f.start();
  assert.equal(preEdit(f.root, a.laneId, ['docs/status.md'], context('a')).status, 'allowed');
  const blocked = preEdit(f.root, b.laneId, ['docs/status.md'], context('b'));
  assert.equal(blocked.status, 'overlap');
  assert.equal(unacknowledgedOverlaps(f.store.directory, a.laneId).count, 1);
  assert.equal(preEdit(f.root, b.laneId, ['docs/architecture.md'], context('b')).status, 'allowed');
  assert.throws(() => readEditPeers(f.root, b.laneId, '../outside'), { code: 'UNSAFE_PATH' });
});

test('hook session and turn persist in saved State, automatic snapshot, making-of, review, and D1 decisions', async t => {
  const f = await fixture(t),
    lane = await f.start();
  const conversation = context();
  preEdit(f.root, lane.laneId, ['docs/status.md'], conversation);
  writeFileSync(join(lane.path, 'docs/status.md'), 'First turn edit\n');
  const snapshot = snapshotLane(f.store, lane.laneId);
  assert.equal(snapshot.status, 'snapshot');
  assert.deepEqual(readAutoSnapshot(f.store, lane.laneId).conversation, conversation);
  assert.deepEqual(new NativeSource(f.root).state(snapshot.state).conversation, conversation);
  const command = {
    action: 'checkpoint',
    laneId: lane.laneId,
    message: 'Save attributed edit',
    operationId: randomUUID(),
  };
  const saved = await f.agent.dispatch(command);
  assert.deepEqual(saved.result.conversation, conversation);
  assert.deepEqual(new NativeSource(f.root).state(saved.result.head).conversation, conversation);
  recordEditContext(f.store.directory, lane.laneId, context('agent-two', 'later-turn'));
  assert.deepEqual((await f.agent.dispatch(command)).result.conversation, conversation);
  const making = (await f.agent.dispatch({ action: 'making-of', intentId: lane.intentId })).result;
  assert.deepEqual(making.lanes[0].saves[0].conversation, conversation);
  const review = (
    await f.agent.dispatch({
      action: 'review',
      kind: 'lane',
      id: lane.laneId,
      expectedHead: saved.result.head,
    })
  ).result;
  assert.deepEqual(review.conversation, conversation);
  const source = new NativeSource(f.root);
  const sourceReview = await readNativeSourceReviewBytes(lane.head, saved.result.head, async ids =>
    ids.map(id => source.object(id)),
  );
  assert.deepEqual(sourceReview.conversation, conversation);
  const decision = await f.agent.dispatch({
    action: 'decide',
    target: { kind: 'intent', intentId: lane.intentId },
    decidedBy: 'Synthetic owner',
    what: 'Retain source attribution',
    why: 'Review the producing turn',
    conversation,
  });
  assert.deepEqual(decision.result.conversation, conversation);
  recordAgentTurn(f.store.directory, lane.laneId, context('agent-two', 'later-turn'));
  const automatic = {
    action: 'decide',
    operationId: randomUUID(),
    target: { kind: 'intent', intentId: lane.intentId },
    decidedBy: 'Synthetic owner',
    what: 'Keep the current turn',
    why: 'Attribution',
  };
  const attributed = await f.agent.dispatch(automatic);
  assert.equal(attributed.result.conversation.turnId, 'later-turn');
  recordEditContext(f.store.directory, lane.laneId, context('another-session', 'different-turn'));
  assert.deepEqual((await f.agent.dispatch(automatic)).result.conversation, attributed.result.conversation);
  assert.equal(JSON.stringify(f.store.load()).includes('transcript_path'), false);
});
