import { trustAgents } from './autonomy-fixture.mjs';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';

const git = (root, args) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  }).trim();
function fixture(native) {
  const root = mkdtempSync(join(tmpdir(), 'forge-agent-lifecycle-'));
  writeFileSync(join(root, 'file.txt'), 'original\n');
  if (native) initNative(root);
  else {
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'initial']);
  }
  trustAgents(root);
  return root;
}
async function setup(native, script = "console.log('ok')") {
  const root = fixture(native),
    agent = new AgentWorkflow(root);
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', script],
  });
  return { root, agent };
}
const dispatch = (agent, action, body = {}) => agent.dispatch({ action, ...body });
async function work(agent, native, file, text, extra = {}) {
  const lane = (await dispatch(agent, 'start', { outcome: `Edit ${file}` })).result;
  writeFileSync(join(lane.path, file), text);
  if (!native) git(lane.path, ['add', file]);
  return {
    lane,
    finish: () => dispatch(agent, 'finish', { laneId: lane.laneId, message: 'Edit', ...extra }),
  };
}
const lanes = async (agent, body = {}) =>
  (await dispatch(agent, 'records', { collection: 'lanes', ...body })).result;

for (const native of [true, false])
  test(`${native ? 'native' : 'Git'} acceptance completes Lane and Intent unless keepOpen; merged and complete-merged`, async () => {
    const { agent } = await setup(native);
    const a = await work(agent, native, 'a.txt', 'a\n', { accept: true });
    const fresh = (await dispatch(agent, 'start', { outcome: 'Idle' })).result;
    const accepted = (await a.finish()).result;
    assert.equal(accepted.status, 'accepted');
    assert.deepEqual(accepted.acceptance.completed.lanes, [a.lane.laneId]);
    assert.equal(accepted.acceptance.completed.intent, true);
    const status = (await dispatch(agent, 'status', { limit: 10, detail: true })).result;
    const receipt = id => status.lanes.items.find(item => item.laneId === id);
    assert.equal(receipt(a.lane.laneId).state, 'completed');
    assert.equal(receipt(a.lane.laneId).merged, true);
    assert.equal(receipt(a.lane.laneId).mergedInto, 'main');
    // A Lane with no work of its own is never reported merged.
    assert.equal(receipt(fresh.laneId).merged, false);
    assert.equal(status.intents.items.find(i => i.intentId === a.lane.intentId).status, 'completed');
    assert.equal(status.intents.items.find(i => i.intentId === fresh.intentId).status, 'active');

    // keepOpen leaves it open but detectable; complete-merged is explicit and retry-safe.
    const b = await work(agent, native, 'b.txt', 'b\n', { accept: true, keepOpen: true });
    assert.equal((await b.finish()).result.acceptance.completed, undefined);
    const open = (await lanes(agent, { state: 'active', merged: true })).items;
    assert.deepEqual(
      open.map(item => item.id),
      [b.lane.laneId],
    );
    const swept = (await dispatch(agent, 'complete-merged')).result;
    assert.deepEqual(swept.lanes, [b.lane.laneId]);
    assert.deepEqual(swept.intents, [b.lane.intentId]);
    const again = (await dispatch(agent, 'complete-merged')).result;
    assert.deepEqual([again.lanes, again.intents, again.skipped], [[], [], []]);
    assert.equal((await lanes(agent, { state: 'active' })).items.length, 1);
    assert.equal(
      (await lanes(agent, { merged: false })).items.every(item => !item.merged),
      true,
    );
  });

test('accept action completes input Lanes; complete and reopen wrap lifecycle without a revision', async () => {
  const { agent } = await setup(true);
  const a = await work(agent, true, 'a.txt', 'a\n');
  const receipt = (await a.finish()).result;
  assert.equal(receipt.complete, true);
  assert.equal(receipt.acceptance, null);
  const accepted = (await dispatch(agent, 'accept', { viewId: receipt.view.viewId })).result;
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(accepted.completed.lanes, [a.lane.laneId]);
  const reopened = (await dispatch(agent, 'reopen', { laneId: a.lane.laneId })).result;
  assert.equal(reopened.state, 'active');
  assert.equal((await dispatch(agent, 'reopen', { intentId: a.lane.intentId })).result.status, 'active');
  assert.equal((await dispatch(agent, 'complete', { laneId: a.lane.laneId })).result.state, 'completed');
  assert.equal((await dispatch(agent, 'complete', { intentId: a.lane.intentId })).result.status, 'completed');
  await assert.rejects(dispatch(agent, 'complete', {}), error => error.code === 'BAD_ARGUMENT');
});

test('records share the status page shape, keep records, and filter by state and merged', async () => {
  const { agent } = await setup(true);
  for (const name of ['one', 'two', 'three']) await dispatch(agent, 'start', { outcome: name });
  const all = await lanes(agent, { limit: 2 });
  assert.equal(all.items.length, 2);
  assert.deepEqual(
    all.records.map(r => r.id),
    all.items.map(r => r.id),
  );
  assert.equal(all.total, 3);
  assert.equal(all.more, true);
  assert.equal(all.nextOffset, 2);
  const rest = await lanes(agent, { offset: 2, limit: 2 });
  assert.deepEqual([rest.items.length, rest.more, rest.nextOffset], [1, false, null]);
  const filtered = await lanes(agent, { state: 'active', merged: false, limit: 2 });
  assert.deepEqual(
    [filtered.total, filtered.items.length, filtered.more, filtered.nextOffset],
    [3, 2, true, 2],
  );
  assert.equal((await lanes(agent, { state: 'completed' })).total, 0);
  assert.equal(
    (await dispatch(agent, 'records', { collection: 'intents', status: 'active' })).result.total,
    3,
  );
  await assert.rejects(
    dispatch(agent, 'records', { collection: 'intents', merged: true }),
    error => error.code === 'BAD_ARGUMENT',
  );
});

test('failed run receipts carry a bounded failureSummary and log reads a tail', async () => {
  const script =
    "for(let i=0;i<100;i++)console.log('line '+i);console.log('not ok 1 - broken');console.error('Error: boom');for(let i=0;i<60;i++)console.error('trace '+i);process.exit(1)";
  const { agent } = await setup(true, script);
  const a = await work(agent, true, 'a.txt', 'a\n');
  const failed = (await a.finish()).result;
  assert.equal(failed.status, 'failed');
  const summary = failed.run.failureSummary;
  assert.match(summary, /not ok 1 - broken/);
  assert.match(summary, /Error: boom/);
  assert.match(summary, /trace 59/);
  assert.doesNotMatch(summary, /trace 0\b/);
  assert.doesNotMatch(summary, /line 5\b/);
  assert.ok(summary.length <= 4096);
  const tail = (
    await dispatch(agent, 'log', { operationId: failed.run.operationId, stream: 'stderr', tail: 30 })
  ).result;
  assert.equal(tail.text.length, 30);
  assert.ok(tail.text.endsWith('trace 59\n'));
  assert.equal(tail.more, false);
  const observed = (await dispatch(agent, 'observe', { operationId: failed.run.operationId })).result;
  assert.equal(observed.failureSummary, summary);
});

test('run takes a Lane and the default check, and re-runs the latest clean View', async () => {
  const { agent } = await setup(true);
  const a = await work(agent, true, 'a.txt', 'a\n');
  const finished = (await a.finish()).result;
  const run = (await dispatch(agent, 'run', { laneId: a.lane.laneId })).result;
  assert.equal(run.status, 'passed');
  assert.equal(run.viewId, finished.view.viewId);
  assert.equal(run.head, finished.view.head);
  assert.notEqual(run.operationId, finished.run.operationId);
  assert.equal(run.checkId, finished.run.checkId);
  await assert.rejects(dispatch(agent, 'run', {}), error => error.code === 'BAD_ARGUMENT');
  await assert.rejects(dispatch(agent, 'run', { laneId: randomUUID() }), error => error.code === 'NOT_FOUND');
});

for (const native of [true, false])
  test(`${native ? 'native' : 'Git'} abandon saves dirty work explicitly, retries after reopen, and retains hosted lifecycle`, async () => {
    const { agent } = await setup(native);
    const lane = (await dispatch(agent, 'start', { outcome: 'Superseded candidate' })).result;
    writeFileSync(join(lane.path, 'unsaved.txt'), 'keep me\n');
    await assert.rejects(
      dispatch(agent, 'abandon', { laneId: lane.laneId, reason: 'Superseded' }),
      e => e.code === 'LANE_DIRTY',
    );
    assert.equal(agent.work.store.select('lanes', lane.laneId).state, 'active');
    const command = {
      laneId: lane.laneId,
      reason: 'Superseded',
      saveFirst: true,
      expectedHead: lane.head,
      operationId: randomUUID(),
    };
    const abandoned = await dispatch(agent, 'abandon', command);
    const saved = agent.work.store.select('lanes', lane.laneId);
    assert.equal(saved.state, 'abandoned');
    assert.equal(saved.checkpoints.length, 1);
    assert.equal(saved.lifecycle[0].reason, 'Superseded');
    assert.equal(saved.lifecycle[0].actor.kind, 'agent');
    assert.ok(Date.parse(saved.lifecycle[0].at));
    assert.equal(agent.work.store.load().schema, 24);
    const { laneSummary } = await import('../dist/work-hosted-summary.js');
    assert.equal(laneSummary(saved).state, 'abandoned');
    assert.equal((await lanes(agent, { state: 'abandoned' })).total, 1);
    assert.equal((await lanes(agent, { state: 'active' })).total, 0);
    await dispatch(agent, 'reopen', { laneId: lane.laneId });
    assert.deepEqual((await dispatch(agent, 'abandon', command)).result, abandoned.result);
    assert.equal(agent.work.store.select('lanes', lane.laneId).state, 'active');
    await assert.rejects(
      dispatch(agent, 'abandon', { ...command, reason: 'Changed' }),
      e => e.code === 'WORK_OPERATION_CHANGED',
    );
    assert.equal(agent.work.store.select('lanes', lane.laneId).checkpoints.length, 1);
  });

test('Intent abandon preflights cascade, preserves all children and can reopen after clean', async () => {
  const { agent } = await setup(true);
  const a = (await dispatch(agent, 'start', { outcome: 'Discarded approach' })).result;
  const b = (await dispatch(agent, 'start', { intentId: a.intentId, outcome: 'Second approach' })).result;
  writeFileSync(join(b.path, 'dirty.txt'), 'retained\n');
  await assert.rejects(
    dispatch(agent, 'abandon', { intentId: a.intentId, reason: 'Superseded' }),
    e => e.code === 'INTENT_OPEN_LANES',
  );
  await assert.rejects(
    dispatch(agent, 'abandon', { intentId: a.intentId, reason: 'Superseded', cascade: true }),
    e => e.code === 'LANE_DIRTY',
  );
  assert.equal(agent.work.store.select('lanes', a.laneId).state, 'active');
  const command = {
    intentId: a.intentId,
    reason: 'Superseded',
    cascade: true,
    saveFirst: true,
    operationId: randomUUID(),
  };
  const result = await dispatch(agent, 'abandon', command);
  assert.equal(agent.work.store.select('intents', a.intentId).status, 'abandoned');
  assert.equal(agent.work.store.select('lanes', a.laneId).state, 'abandoned');
  assert.equal(agent.work.store.select('lanes', b.laneId).state, 'abandoned');
  assert.deepEqual((await dispatch(agent, 'abandon', command)).result, result.result);
  const { parseWork } = await import('../dist/work-unified-types.js');
  const data = parseWork(JSON.parse(JSON.stringify(agent.work.store.load())));
  assert.equal(data.intents[0].lifecycle[0].reason, 'Superseded');
  assert.equal(data.lanes.find(l => l.id === b.laneId).checkpoints.length, 1);
  await dispatch(agent, 'clean', { apply: true });
  await dispatch(agent, 'reopen', { laneId: b.laneId });
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(join(b.path, 'dirty.txt'), 'utf8'), 'retained\n');
});

test('local HTTP Work surface uses abandon semantics and rejects stale Lane pins', async () => {
  const { agent, root } = await setup(true);
  const lane = (await dispatch(agent, 'start', { outcome: 'HTTP candidate' })).result;
  const { workRequest } = await import('../dist/work-http.js');
  const { Readable } = await import('node:stream');
  const request = command =>
    Object.assign(Readable.from([JSON.stringify({ revision: agent.work.store.revision(), command })]), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
  await assert.rejects(
    workRequest(
      root,
      request({ action: 'abandon', laneId: lane.laneId, reason: 'Superseded', expectedHead: '0'.repeat(64) }),
    ),
    e => e.code === 'LANE_STALE',
  );
  const result = await workRequest(
    root,
    request({ action: 'abandon', laneId: lane.laneId, reason: 'Superseded' }),
  );
  assert.equal(result.result.state, 'abandoned');
  await assert.rejects(
    dispatch(agent, 'abandon', { reason: 'Missing target' }),
    e => e.code === 'BAD_ARGUMENT',
  );
});

test('abandon leaves a concurrent later save open, including on retry without expectedHead', async () => {
  const { agent } = await setup(true);
  const lane = (await dispatch(agent, 'start', { outcome: 'Concurrent saves' })).result;
  writeFileSync(join(lane.path, 'file.txt'), 'save first\n');
  const store = agent.work.store,
    locked = store.locked.bind(store);
  const { agentCheckpoint } = await import('../dist/agent-workflow-mutations.js');
  let calls = 0;
  store.locked = run => {
    if (++calls === 3) {
      const current = store.select('lanes', lane.laneId);
      writeFileSync(join(lane.path, 'file.txt'), 'later accepted candidate\n');
      agentCheckpoint(store, {
        action: 'checkpoint',
        laneId: lane.laneId,
        expectedHead: current.head,
        operationId: randomUUID(),
        message: 'Concurrent save',
      });
    }
    return locked(run);
  };
  const command = { laneId: lane.laneId, reason: 'Superseded', saveFirst: true, operationId: randomUUID() };
  await assert.rejects(dispatch(agent, 'abandon', command), e => e.code === 'LANE_STALE');
  store.locked = locked;
  assert.equal(store.select('lanes', lane.laneId).state, 'active');
  assert.equal(store.select('lanes', lane.laneId).checkpoints.length, 2);
  await assert.rejects(dispatch(agent, 'abandon', command), e => e.code === 'LANE_STALE');
});

test('Intent cascade does not absorb a child created while saving or on original-operation retry', async () => {
  const { agent } = await setup(true);
  const lane = (await dispatch(agent, 'start', { outcome: 'Concurrent child' })).result;
  writeFileSync(join(lane.path, 'file.txt'), 'save first\n');
  const store = agent.work.store,
    locked = store.locked.bind(store);
  const { agentStart } = await import('../dist/agent-workflow-mutations.js');
  let calls = 0;
  store.locked = run => {
    if (++calls === 3)
      agentStart(store, {
        action: 'start',
        operationId: randomUUID(),
        intentId: lane.intentId,
        outcome: 'New child',
        constraints: '',
        assignment: '',
        target: '',
      });
    return locked(run);
  };
  const command = {
    intentId: lane.intentId,
    reason: 'Superseded',
    saveFirst: true,
    cascade: true,
    operationId: randomUUID(),
  };
  await assert.rejects(dispatch(agent, 'abandon', command), e => e.code === 'LANE_STALE');
  store.locked = locked;
  assert.equal(store.select('intents', lane.intentId).status, 'active');
  await assert.rejects(dispatch(agent, 'abandon', command), e => e.code === 'WORK_OPERATION_CHANGED');
  assert.ok(store.load().lanes.every(item => item.state === 'active'));
});

for (const native of [true, false])
  test(`${native ? 'native' : 'Git'} abandon retains unresolved merge bytes and context for reopening`, async () => {
    const { agent } = await setup(native);
    const a = await work(agent, native, 'file.txt', 'main change\n', { accept: true });
    const b = await work(agent, native, 'file.txt', 'other change\n');
    await a.finish();
    await dispatch(agent, 'checkpoint', { laneId: b.lane.laneId, message: 'Other candidate' });
    const sync = await dispatch(agent, 'sync', { laneId: b.lane.laneId });
    assert.equal(sync.result.status, 'conflict');
    const { readFileSync } = await import('node:fs');
    const markerBytes = readFileSync(join(b.lane.path, 'file.txt'), 'utf8');
    assert.match(markerBytes, /<<<<<<</);
    await dispatch(agent, 'abandon', {
      laneId: b.lane.laneId,
      reason: 'Try another approach',
      saveFirst: true,
    });
    const saved = agent.work.store.select('lanes', b.lane.laneId);
    assert.equal(saved.state, 'abandoned');
    assert.ok(saved.pendingMerge);
    await dispatch(agent, 'reopen', { laneId: b.lane.laneId });
    assert.equal(readFileSync(join(b.lane.path, 'file.txt'), 'utf8'), markerBytes);
    writeFileSync(join(b.lane.path, 'file.txt'), 'resolved\n');
    if (!native) git(b.lane.path, ['add', 'file.txt']);
    await dispatch(agent, 'checkpoint', { laneId: b.lane.laneId, message: 'Resolve after reopen' });
    assert.equal(agent.work.store.select('lanes', b.lane.laneId).pendingMerge, undefined);
  });

test('abandon retains long reasons in full without introducing a reason-length policy', async () => {
  const { agent } = await setup(true);
  const lane = (await dispatch(agent, 'start', { outcome: 'Long explanation' })).result;
  const reason = 'Detailed supersession context. '.repeat(300).trim();
  writeFileSync(join(lane.path, 'file.txt'), 'preserved candidate\n');
  await dispatch(agent, 'abandon', { laneId: lane.laneId, reason, saveFirst: true });
  const saved = agent.work.store.select('lanes', lane.laneId);
  assert.equal(saved.state, 'abandoned');
  assert.equal(saved.lifecycle[0].reason, reason);
  assert.equal(saved.checkpoints.length, 1);
});
