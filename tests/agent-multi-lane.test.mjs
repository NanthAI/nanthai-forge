// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { parseWork } from '../dist/work-unified-types.js';
import { WorkService } from '../dist/work.js';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { laneSummary } from '../dist/work-hosted-summary.js';
import { localBrief } from '../dist/agent-brief-local.js';
import { trustAgents } from './autonomy-fixture.mjs';
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
async function fixture(t, { native = true, supervised = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-multi-lane-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.txt'), 'a\n');
  writeFileSync(join(root, 'b.txt'), 'b\n');
  if (native) initNative(root);
  else {
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'Fixture']);
  }
  if (!supervised) trustAgents(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', '0'],
  });
  const start = async (outcome, options = {}) =>
    (await agent.dispatch({ action: 'start', outcome, ...options })).result;
  const edit = (lane, file, value) => {
    writeFileSync(join(lane.path, file), value);
    if (!native) git(lane.path, ['add', file]);
  };
  const checkpoint = async lane =>
    (await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Save sibling' })).result;
  const finish = async (lane, options = {}) =>
    (
      await agent.dispatch({
        action: 'finish',
        laneId: lane.laneId,
        message: 'Land work',
        accept: true,
        ...options,
      })
    ).result;
  const contents = (head, path) => {
    if (!native) return git(root, ['show', `${head}:${path}`]) + '\n';
    const source = new NativeSource(root);
    return source.object(source.state(head).files.find(file => file.path === path).blob).toString();
  };
  return { root, agent, store, start, edit, checkpoint, finish, contents };
}
for (const native of [true, false]) {
  test(`joint ${native ? 'native' : 'Git'} finish lands two sibling Lanes once and completes only included work`, async t => {
    const f = await fixture(t, { native });
    const a = await f.start('Change both files');
    const startB = { action: 'start', operationId: randomUUID(), intentId: a.intentId, outcome: 'Change B' };
    const b = (await f.agent.dispatch(startB)).result;
    assert.equal(b.intentId, a.intentId);
    assert.equal(b.siblingLanes[0].laneId, a.laneId);
    assert.equal((await f.agent.dispatch(startB)).result.laneId, b.laneId);
    await assert.rejects(f.agent.dispatch({ ...startB, outcome: 'Changed request' }), {
      code: 'WORK_OPERATION_CHANGED',
    });
    const c = await f.start('Remaining work', { intentId: a.intentId });
    f.edit(a, 'a.txt', 'A\n');
    f.edit(b, 'b.txt', 'B\n');
    const cpB = await f.checkpoint(b);
    const result = await f.finish(a, { with: [b.laneId] });
    assert.equal(result.status, 'accepted');
    assert.deepEqual(
      result.view.inputs.map(pin => pin.laneId),
      [a.laneId, b.laneId],
    );
    assert.equal(result.view.inputs[1].head, cpB.head);
    assert.equal(f.contents(result.acceptance.head, 'a.txt'), 'A\n');
    assert.equal(f.contents(result.acceptance.head, 'b.txt'), 'B\n');
    let data = f.store.load();
    assert.equal(data.intents.length, 1);
    assert.equal(data.views.length, 1);
    assert.equal(data.runs.length, 1);
    assert.equal(data.channelMoves.length, 1);
    assert.equal(data.schema, 24);
    const attributed = structuredClone(data);
    attributed.lanes[0].checkpoints[0].actor = { kind: 'agent', name: 'Synthetic H17 actor' };
    assert.deepEqual(
      parseWork(attributed).lanes[0].checkpoints[0].actor,
      attributed.lanes[0].checkpoints[0].actor,
    );
    assert.deepEqual(
      data.lanes.map(lane => lane.state),
      ['completed', 'completed', 'active'],
    );
    assert.equal(data.intents[0].status, 'active');
    const status = (await f.agent.dispatch({ action: 'status', intentId: a.intentId })).result;
    assert.equal(status.intents.items[0].lanes.length, 3);
    assert.equal(status.views.items[0].inputs.length, 2);
    const history = (await f.agent.dispatch({ action: 'records', collection: 'intents' })).result;
    assert.equal(history.items[0].lanes.length, 3);
    const brief = localBrief(f.store, { situation: 'continue-lane', laneId: c.laneId });
    assert.equal(brief.context.siblingLanes.length, 2);
    assert.match(brief.copyText, /Sibling Lanes/);
    const { resolved, ...receipt } = result;
    assert.deepEqual(
      (
        await f.agent.dispatch({
          action: 'finish',
          laneId: a.laneId,
          message: 'Land work',
          accept: true,
          with: [b.laneId],
          ...resolved,
        })
      ).result,
      receipt,
    );
    await f.finish(c);
    data = f.store.load();
    assert.equal(data.intents[0].status, 'completed');
    await assert.rejects(f.start('Too late', { intentId: a.intentId }), { code: 'INTENT_CLOSED' });
  });
  test(`sibling ${native ? 'native' : 'Git'} overlaps stop as composition conflicts without checking or accepting`, async t => {
    const f = await fixture(t, { native }),
      a = await f.start('Conflict'),
      b = await f.start('Sibling', { intentId: a.intentId });
    f.edit(a, 'a.txt', 'A\n');
    f.edit(b, 'a.txt', 'B\n');
    await f.checkpoint(b);
    const result = await f.finish(a, { with: [b.laneId] });
    assert.equal(result.phase, 'compose');
    assert.equal(result.status, 'conflict');
    assert.equal(result.view.inputs.length, 2);
    assert.equal(f.store.load().runs.length, 0);
    assert.equal(f.store.load().channelMoves.length, 0);
  });
}
test('dependency Intent waits durably, resumes through land-ready, syncs main and checks exact combined source', async t => {
  const f = await fixture(t),
    base = await f.start('Foundation'),
    stacked = await f.start('Stacked', { after: { intentId: base.intentId } });
  f.edit(base, 'a.txt', 'Foundation\n');
  f.edit(stacked, 'b.txt', 'Stacked\n');
  const waiting = await f.finish(stacked);
  assert.equal(waiting.status, 'waiting-for-dependency');
  assert.equal(waiting.terminal, false);
  assert.equal(f.store.load().runs.length, 0);
  const retained = f.store.select('lanes', stacked.laneId);
  assert.deepEqual(retained.after, { intentId: base.intentId });
  assert.deepEqual(laneSummary(retained).after, retained.after);
  assert.deepEqual(
    (await f.agent.dispatch({ action: 'status' })).result.lanes.items.find(
      lane => lane.laneId === stacked.laneId,
    ).after,
    retained.after,
  );
  const stillWaiting = (await new AgentWorkflow(f.root).dispatch({ action: 'land-ready' })).result.finishes;
  assert.equal(stillWaiting[0].status, 'waiting-for-dependency');
  const upstream = await f.finish(base);
  const ready = (await new AgentWorkflow(f.root).dispatch({ action: 'land-ready' })).result.finishes;
  assert.equal(ready.length, 1);
  assert.equal(ready[0].status, 'accepted');
  assert.equal(ready[0].sync.target, upstream.acceptance.head);
  assert.equal(f.contents(ready[0].acceptance.head, 'a.txt'), 'Foundation\n');
  assert.equal(f.contents(ready[0].acceptance.head, 'b.txt'), 'Stacked\n');
  assert.equal(f.store.load().runs.length, 2);
  assert.equal((await f.agent.dispatch({ action: 'land-ready' })).result.finishes.length, 0);
});
test('finish after a View resumes the same operation after that exact View lands', async t => {
  const f = await fixture(t),
    base = await f.start('Foundation'),
    stacked = await f.start('Stacked');
  f.edit(base, 'a.txt', 'Foundation\n');
  f.edit(stacked, 'b.txt', 'Stacked\n');
  const proposed = await f.finish(base, { accept: undefined });
  const request = {
    action: 'finish',
    operationId: randomUUID(),
    laneId: stacked.laneId,
    message: 'Stacked',
    accept: true,
    after: { viewId: proposed.view.viewId },
  };
  const waiting = (await f.agent.dispatch(request)).result;
  assert.equal(waiting.status, 'waiting-for-dependency');
  await f.agent.dispatch({ action: 'accept', viewId: proposed.view.viewId });
  const landed = (await f.agent.dispatch({ ...request, ...waiting.resolved })).result;
  assert.equal(landed.status, 'accepted');
  assert.equal(landed.run.head, landed.view.head);
  assert.equal(f.store.select('lanes', stacked.laneId).checkpoints.length, 2); // checkpoint + main sync
});
test('joint finish and dependency resume respect supervised review', async t => {
  const f = await fixture(t, { supervised: true }),
    base = await f.start('Foundation'),
    a = await f.start('Joint'),
    b = await f.start('Sibling', { intentId: a.intentId });
  f.edit(base, 'a.txt', 'Foundation\n');
  f.edit(b, 'b.txt', 'Joint\n');
  await f.checkpoint(b);
  const upstream = await f.finish(base);
  assert.equal(upstream.status, 'awaiting-review');
  const waiting = await f.finish(a, { with: [b.laneId], after: { viewId: upstream.view.viewId } });
  assert.equal(waiting.status, 'waiting-for-dependency');
  const person = new WorkService(f.root);
  await person.dispatch(
    {
      action: 'accept-channel',
      operationId: randomUUID(),
      viewId: upstream.view.viewId,
      expectedHead: upstream.view.head,
      channel: 'main',
      expectedPrevious: null,
    },
    person.store.revision(),
  );
  const resumed = (await f.agent.dispatch({ action: 'land-ready' })).result.finishes[0];
  assert.equal(resumed.status, 'sync-required');
  await f.agent.dispatch({ action: 'sync', laneId: a.laneId });
  const joint = await f.finish(a, { with: [b.laneId] });
  assert.equal(joint.status, 'awaiting-review');
  assert.equal(joint.run.status, 'passed');
  assert.equal(joint.view.inputs.length, 2);
  assert.equal(joint.acceptance, null);
  assert.equal(f.store.load().channelMoves.length, 1);
});
test('invalid Intent, foreign siblings, duplicate Lanes and unknown dependencies fail without source mutations', async t => {
  const f = await fixture(t),
    a = await f.start('A'),
    b = await f.start('B');
  await assert.rejects(f.start('Missing', { intentId: randomUUID() }), { code: 'NOT_FOUND' });
  await assert.rejects(f.finish(a, { with: [b.laneId] }), { code: 'BAD_ARGUMENT' });
  await assert.rejects(f.finish(a, { with: [a.laneId] }), { code: 'BAD_ARGUMENT' });
  await assert.rejects(f.finish(a, { after: { intentId: a.intentId } }), { code: 'BAD_ARGUMENT' });
  await assert.rejects(f.finish(a, { after: { viewId: randomUUID() } }), { code: 'NOT_FOUND' });
  assert.equal(f.store.select('lanes', a.laneId).checkpoints.length, 0);
});

test('an Intent dependency waits for every sibling, including an unchanged unlanded Lane', async t => {
  const f = await fixture(t),
    base = await f.start('Foundation'),
    sibling = await f.start('Still pending', { intentId: base.intentId });
  f.edit(base, 'a.txt', 'Foundation\n');
  const stacked = await f.start('Stacked', { after: { intentId: base.intentId } });
  f.edit(stacked, 'b.txt', 'Stacked\n');
  await f.finish(base);
  assert.equal((await f.finish(stacked)).status, 'waiting-for-dependency');
  const siblingFinish = await f.finish(sibling);
  assert.equal(siblingFinish.status, 'accepted');
  assert.equal(siblingFinish.run.status, 'passed');
  const acceptedView = f.store.select('views', siblingFinish.acceptance.viewId);
  assert.ok(acceptedView.inputs.some(pin => pin.laneId === sibling.laneId));
  assert.equal((await f.agent.dispatch({ action: 'land-ready' })).result.finishes[0].status, 'accepted');
});

test('joint finish rechecks all input pins after a main race', async t => {
  const f = await fixture(t),
    a = await f.start('Joint'),
    b = await f.start('Sibling', { intentId: a.intentId }),
    other = await f.start('Other accepted work');
  f.edit(a, 'a.txt', 'A\n');
  f.edit(b, 'b.txt', 'B\n');
  f.edit(other, 'c.txt', 'C\n');
  await f.checkpoint(b);
  const original = f.agent.work.dispatch.bind(f.agent.work);
  let raced = false;
  f.agent.work.dispatch = async (...args) => {
    const result = await original(...args);
    if (!raced && args[0].action === 'run-check') {
      raced = true;
      const competitor = new AgentWorkflow(f.root);
      assert.equal(
        (
          await competitor.dispatch({
            action: 'finish',
            laneId: other.laneId,
            message: 'Win race',
            accept: true,
          })
        ).result.status,
        'accepted',
      );
    }
    return result;
  };
  const result = await f.finish(a, { with: [b.laneId] });
  assert.equal(result.status, 'accepted');
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[1].view.inputs.length, 2);
  for (const file of ['a', 'b', 'c'])
    assert.equal(f.contents(result.acceptance.head, `${file}.txt`), `${file.toUpperCase()}\n`);
});

test('accepting joint recorded heads preserves later sibling checkpoints as open work', async t => {
  const f = await fixture(t),
    a = await f.start('Joint'),
    b = await f.start('Sibling', { intentId: a.intentId });
  f.edit(a, 'a.txt', 'A\n');
  f.edit(b, 'b.txt', 'B\n');
  await f.checkpoint(b);
  const original = f.agent.work.dispatch.bind(f.agent.work);
  let advanced = false;
  f.agent.work.dispatch = async (...args) => {
    const result = await original(...args);
    if (!advanced && args[0].action === 'run-check') {
      advanced = true;
      f.edit(b, 'b.txt', 'B later\n');
      await f.checkpoint(b);
    }
    return result;
  };
  const result = await f.finish(a, { with: [b.laneId] });
  assert.equal(result.status, 'accepted');
  assert.equal(f.contents(result.acceptance.head, 'b.txt'), 'B\n');
  assert.equal(f.store.select('lanes', b.laneId).state, 'active');
  assert.equal(f.store.select('intents', a.intentId).status, 'active');
  assert.deepEqual(result.acceptance.completed.skipped, [{ laneId: b.laneId, code: 'LANE_STALE' }]);
});

test('ordinary fully pinned finish retains its pre-multi-Lane request encoding', async t => {
  const f = await fixture(t),
    lane = await f.start('Legacy retry'),
    check = f.store.load().checks[0];
  const request = {
    action: 'finish',
    operationId: randomUUID(),
    laneId: lane.laneId,
    expectedHead: lane.head,
    message: 'Legacy retry',
    dependencies: [],
    checkId: check.id,
    expectedDefinition: check.definition,
    accept: { channel: 'main', expectedPrevious: null },
  };
  const { agentActionSchema } = await import('../dist/agent-workflow-schema.js');
  const { resolveAgentDefaults } = await import('../dist/agent-defaults.js');
  const selected = resolveAgentDefaults(f.store, agentActionSchema.parse(request));
  assert.equal(JSON.stringify(selected.command), JSON.stringify(request));
  assert.equal(selected.resolved, undefined);
});
