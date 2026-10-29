// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AgentWorkflow } from './agent-advisory-fixture.mjs';
import { initNative } from '../dist/native-work.js';
import { restoreNativeWork } from '../dist/native-backup.js';
import { readPendingStatus } from '../dist/pending-status-read.js';
import { formatPendingStatus } from '../dist/pending-status-format.js';
import { localBrief } from '../dist/agent-brief-local.js';
import { CoordinationJournal } from '../dist/agent-coordination-journal.js';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';
import { briefingContext } from '../dist/agent-brief-context.js';
import { records, ids, states, guidance } from './agent-brief-fixture.mjs';
const cli = resolve('dist/cli.js');
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-handoff-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'example.txt'), 'synthetic source\n');
  initNative(root);
  const agent = new AgentWorkflow(root);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Synthetic delivery' })).result;
  return { root, agent, lane };
}
const command = (lane, extra = {}) => ({
  action: 'handoff',
  operationId: randomUUID(),
  laneId: lane.laneId,
  summary: 'Implemented synthetic delivery',
  changes: ['example.txt'],
  tests: [{ command: 'synthetic-test', passed: 4, failed: 0, skipped: 1 }],
  unrun: ['Full suite'],
  next: ['Lead reviews and lands'],
  evidence: ['advisory/path'],
  ...extra,
});
const read = async (agent, lane) =>
  (await agent.dispatch({ action: 'handoff-read', laneId: lane.laneId })).result.handoff;
function invoke(root, input) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [cli, 'agent', root, 'handoff', JSON.stringify(input)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '',
      err = '';
    child.stdout.on('data', chunk => (out += chunk));
    child.stderr.on('data', chunk => (err += chunk));
    child.on('error', reject);
    child.on('close', code => (code === 0 ? accept(JSON.parse(out)) : reject(new Error(err))));
  });
}
test('handoff round trip separates optional self reports from check evidence and reads latest', async t => {
  const { agent, lane } = await fixture(t);
  assert.equal(await read(agent, lane), null);
  const request = command(lane);
  const written = (await agent.dispatch(request)).result.handoff;
  assert.deepEqual(await read(agent, lane), written);
  assert.equal(written.head, lane.head);
  assert.equal(written.tests[0].source, 'self-reported');
  assert.deepEqual(written.recordedChecks, []);
  assert.deepEqual(written.unrun, ['Full suite']);
  await agent.dispatch(command(lane, { summary: 'Next delivery', tests: undefined }));
  const latest = await read(agent, lane);
  assert.equal(latest.summary, 'Next delivery');
  assert.deepEqual(latest.tests, []);
  assert.equal(agent.work.store.select('intents', lane.intentId).notes.length, 2);
});
test('CLI handoff delivers a peer notice created after the last checkpoint exactly once', async t => {
  const { root, agent, lane } = await fixture(t);
  const peer = (await agent.dispatch({ action: 'start', outcome: 'Peer edit' })).result;
  writeFileSync(join(lane.path, 'example.txt'), 'my saved change\n');
  const saved = (
    await agent.dispatch({
      action: 'checkpoint',
      laneId: lane.laneId,
      message: 'Last checkpoint',
    })
  ).result;
  assert.equal(saved.peers.inbox, undefined);
  writeFileSync(join(peer.path, 'example.txt'), 'peer saved change\n');
  const reciprocal = (
    await agent.dispatch({
      action: 'checkpoint',
      laneId: peer.laneId,
      message: 'Later peer save',
    })
  ).result.peers.inbox;
  assert.equal(reciprocal.length, 1);
  const noticeId = reciprocal[0].noticeId;
  const request = command(lane);
  const first = (await invoke(root, request)).result;
  assert.equal(first.handoff.head, saved.head);
  assert.deepEqual(
    first.peers.inbox.map(notice => notice.noticeId),
    [noticeId],
  );
  assert.ok(Buffer.byteLength(JSON.stringify(first.peers)) <= 12_000);
  assert.equal(new CoordinationJournal(agent.work.store).pendingOverlaps(lane.laneId).length, 0);
  const replay = (await invoke(root, request)).result;
  assert.deepEqual(replay, first);
  const later = (await invoke(root, command(lane))).result;
  assert.equal(later.peers?.inbox, undefined);
  assert.equal(
    (await agent.dispatch({ action: 'status', laneId: lane.laneId })).result.peers.inbox,
    undefined,
  );
  assert.ok(
    (await agent.dispatch({ action: 'peers', laneId: lane.laneId })).result.inbox.some(
      notice => notice.noticeId === noticeId,
    ),
    'historical notices remain readable',
  );
});
test('replay returns original saved source and evidence after later edits and handoffs', async t => {
  const { agent, lane } = await fixture(t),
    request = command(lane);
  const first = (await agent.dispatch(request)).result;
  writeFileSync(join(lane.path, 'example.txt'), 'later saved source\n');
  await agent.dispatch({
    action: 'checkpoint',
    laneId: lane.laneId,
    message: 'Later save',
  });
  await agent.dispatch(command(lane, { summary: 'New handoff' }));
  const revision = agent.work.store.revision();
  assert.deepEqual((await agent.dispatch(request)).result, first);
  assert.equal(agent.work.store.revision(), revision);
  assert.equal((await read(agent, lane)).summary, 'New handoff');
  await assert.rejects(agent.dispatch({ ...request, summary: 'Changed retry' }), {
    code: 'WORK_OPERATION_CHANGED',
  });
});
test('two concurrent CLI writers on sibling Lanes preserve both notes without source conflicts', async t => {
  const { root, agent, lane } = await fixture(t);
  const sibling = (
    await agent.dispatch({
      action: 'start',
      intentId: lane.intentId,
      outcome: 'Sibling',
    })
  ).result;
  const a = command(lane),
    b = command(sibling, { summary: 'Sibling delivery' });
  // check-runtime deliberately sets zero lock patience. A racing writer can
  // return WORK_BUSY; reconcile its original operation after its peer completes.
  const replies = await Promise.allSettled([invoke(root, a), invoke(root, b)]);
  for (const [index, reply] of replies.entries()) {
    if (reply.status === 'rejected') {
      assert.match(reply.reason.message, /"code":"WORK_BUSY"/);
      await invoke(root, [a, b][index]);
    }
  }
  assert.equal((await read(agent, lane)).operationId, a.operationId);
  assert.equal((await read(agent, sibling)).operationId, b.operationId);
  assert.equal(agent.work.store.select('intents', lane.intentId).notes.length, 2);
  assert.equal(agent.work.store.select('lanes', lane.laneId).head, lane.head);
});
test('matching recorded checks link automatically; prior heads and unrelated Lanes do not', async t => {
  const { agent, lane } = await fixture(t);
  const check = (
    await agent.dispatch({
      action: 'define-check',
      name: 'synthetic',
      executable: process.execPath,
      args: ['-e', '0'],
    })
  ).result;
  const compose = async inputs =>
    (
      await agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId: lane.intentId,
        inputs,
      })
    ).result;
  const view = await compose([{ laneId: lane.laneId, head: lane.head }]);
  const run = (
    await agent.dispatch({
      action: 'run',
      viewId: view.viewId,
      checkId: check.checkId,
    })
  ).result;
  const first = (await agent.dispatch(command(lane, { evidence: [run.operationId, 'invented-check-id'] })))
    .result.handoff;
  assert.equal(first.recordedChecks.length, 1);
  assert.equal(first.recordedChecks[0].source, 'forge-recorded');
  assert.equal(first.recordedChecks[0].operationId, run.operationId);
  assert.equal(first.recordedChecks[0].status, 'passed');
  assert.equal(first.tests[0].source, 'self-reported');
  const sibling = (
    await agent.dispatch({
      action: 'start',
      intentId: lane.intentId,
      outcome: 'Sibling',
    })
  ).result;
  assert.deepEqual((await agent.dispatch(command(sibling))).result.handoff.recordedChecks, []);
  writeFileSync(join(lane.path, 'example.txt'), 'new exact source\n');
  await agent.dispatch({
    action: 'checkpoint',
    laneId: lane.laneId,
    message: 'New source',
  });
  const next = (await agent.dispatch(command(lane))).result.handoff;
  assert.notEqual(next.head, first.head);
  assert.deepEqual(next.recordedChecks, []);
});
test('portable export and restore preserve delivery payload, replay, and briefing context', async t => {
  const { root, agent, lane } = await fixture(t),
    request = command(lane);
  const first = (await agent.dispatch(request)).result.handoff;
  const backup = (
    await agent.work.dispatch({ action: 'export-work', archive: true }, agent.work.store.revision())
  ).result;
  const target = join(root, 'restored');
  await restoreNativeWork(backup.archive.path, target);
  const restored = new AgentWorkflow(target);
  assert.deepEqual(await read(restored, lane), first);
  assert.deepEqual((await restored.dispatch(request)).result.handoff, first);
  const brief = localBrief(restored.work.store, {
    situation: 'continue-lane',
    laneId: lane.laneId,
  });
  assert.deepEqual(brief.context.handoff, first);
});
test('status, peers, diff, pending status and next-agent brief show latest delivery', async t => {
  const { agent, lane } = await fixture(t);
  await agent.dispatch(command(lane, { summary: 'Old delivery' }));
  const last = (await agent.dispatch(command(lane, { summary: 'Current delivery' }))).result.handoff;
  const status = (await agent.dispatch({ action: 'status', laneId: lane.laneId })).result.lane;
  assert.equal(status.handoff.operationId, last.operationId);
  const peers = (await agent.dispatch({ action: 'peers', laneId: lane.laneId })).result;
  assert.equal(peers.handoff.operationId, last.operationId);
  assert.ok(Buffer.byteLength(JSON.stringify(peers)) <= 1500);
  const diff = (await agent.dispatch({ action: 'diff', laneId: lane.laneId })).result;
  assert.equal(diff.handoff.operationId, last.operationId);
  const pending = readPendingStatus(agent.work.store, undefined, undefined, { detail: true });
  assert.equal(pending.lanes[0].handoff.operationId, last.operationId);
  assert.match(formatPendingStatus(pending), /Current delivery.*self-reported.*Forge-recorded/);
  const context = new CoordinationJournal(agent.work.store).context(lane.laneId);
  assert.deepEqual(context.handoffs, [last]);
  const brief = localBrief(agent.work.store, {
    situation: 'take-handoff',
    messageId: last.operationId,
  });
  assert.deepEqual(brief.context.handoff, last);
  assert.match(brief.full, /unrun/);
  assert.match(brief.full, /Lead reviews and lands/);
  assert.match(brief.full, /Read the delivery handoff/);
});
test('missing Lanes fail current reads and mutations; invalid counts never persist', async t => {
  const { agent, lane } = await fixture(t);
  await agent.dispatch(command(lane));
  await assert.rejects(agent.dispatch({ action: 'handoff-read', laneId: randomUUID() }), {
    code: 'NOT_FOUND',
  });
  await assert.rejects(agent.dispatch(command({ laneId: randomUUID() })), {
    code: 'NOT_FOUND',
  });
  const revision = agent.work.store.revision();
  await assert.rejects(
    agent.dispatch(
      command(lane, {
        tests: [{ command: 'invalid', passed: -1, failed: 0, skipped: 0 }],
      }),
    ),
    { code: 'BAD_ARGUMENT' },
  );
  assert.equal(agent.work.store.revision(), revision);
});
test('MCP task records handoffs and overview reads them using the same command contracts', async t => {
  const { root, lane } = await fixture(t),
    registrations = new Map();
  registerAgentWorkflow(
    {
      registerTool(name, definition, handler) {
        registrations.set(name, { definition, handler });
      },
    },
    root,
  );
  const request = command(lane);
  const response = await registrations.get('forge_task').handler({ command: request });
  assert.ok(!response.isError);
  const result = JSON.parse(response.content[0].text).result.handoff;
  const readResponse = await registrations
    .get('forge_work_overview')
    .handler({ command: { action: 'handoff-read', laneId: lane.laneId } });
  assert.deepEqual(JSON.parse(readResponse.content[0].text).result.handoff, result);
});
test('brief selection never returns a cached delivery for a removed Lane', () => {
  const saved = structuredClone(records);
  saved.lanes = [];
  assert.throws(
    () =>
      briefingContext(
        { situation: 'continue-lane', laneId: ids.lane },
        saved,
        head => states[head],
        guidance,
        () => '',
      ),
    { code: 'NOT_FOUND' },
  );
});
