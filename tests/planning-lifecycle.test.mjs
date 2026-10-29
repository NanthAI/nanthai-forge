// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { migrateIntentWork } from '../dist/work-intent-migration.js';
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const briefs = await import(moduleUrl('../convex/projectBriefings.ts'));
const denied = error => error.data?.code === 'PROJECT_UNAVAILABLE';
function upgrade(work) {
  work.store.locked(() => {
    const tx = work.store.records();
    tx.setSchema(15);
    work.store.commitRecords(tx);
  });
  migrateIntentWork(work.store);
}
async function native(t, unified = false) {
  const root = mkdtempSync(join(tmpdir(), 'forge-planning-lifecycle-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'file.txt'), 'synthetic\n');
  initNative(root);
  const work = new WorkService(root),
    agent = new AgentWorkflow(root);
  if (unified) upgrade(work);
  const put = patch => ({
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId: randomUUID(),
    expectedVersion: 0,
    kind: 'issue',
    title: 'Synthetic proposal',
    body: 'Full planning details',
    status: 'proposed',
    intentIds: [],
    ...patch,
  });
  const send = command => work.dispatch(command, work.store.revision());
  return { work, agent, put, send };
}
test('native legacy and unified planning retain Proposed, plan, abandon and reopen versions with retry/CAS', async t => {
  for (const unified of [false, true]) {
    const f = await native(t, unified);
    const command = f.put();
    await f.send(command);
    assert.equal((await f.send(command)).result.version, 1);
    if (unified) assert.equal(f.work.store.select('intents', command.itemId).status, 'proposed');
    for (const [index, status] of ['open', 'abandoned', 'open'].entries()) {
      const next = {
        ...command,
        operationId: randomUUID(),
        expectedVersion: index + 1,
        status,
        ...(status === 'abandoned' ? { reason: 'Superseded' } : {}),
      };
      const result = (await f.send(next)).result;
      assert.equal(result.version, index + 2);
      assert.equal(result.status, status);
      if (status === 'abandoned') assert.equal(result.reason, 'Superseded');
      await assert.rejects(
        f.send({ ...next, operationId: randomUUID() }),
        error => error.code === 'PLANNING_CHANGED',
      );
    }
    if (unified) {
      const intent = f.work.store.select('intents', command.itemId);
      assert.equal(intent.status, 'active');
      assert.deepEqual(
        intent.lifecycle.map(event => event.to),
        ['proposed', 'active', 'abandoned', 'active'],
      );
      assert.equal(intent.lifecycle[2].reason, 'Superseded');
    }
  }
});
test('legacy planning start briefing and CLI start create exactly one linked Intent/Lane and retain details', async t => {
  const f = await native(t);
  const command = f.put({ status: 'open' });
  await f.send(command);
  const brief = await f.agent.dispatch({
    action: 'brief',
    situation: 'start-intent',
    intentId: command.itemId,
  });
  assert.match(JSON.stringify(brief), /Full planning details/);
  const start = {
    action: 'start',
    operationId: randomUUID(),
    intentId: command.itemId,
    outcome: command.title,
  };
  const first = (await f.agent.dispatch(start)).result;
  const retry = (await f.agent.dispatch(start)).result;
  assert.equal(first.laneId, retry.laneId);
  assert.equal(first.intentId, command.itemId);
  const data = f.work.store.load();
  assert.equal(data.intents.length, 1);
  assert.equal(data.lanes.length, 1);
  assert.equal(data.intents[0].constraints, command.body);
  assert.deepEqual(data.planningItems.at(-1).intentIds, [first.intentId]);
});
test('CLI abandons legacy planning Intents and Initiatives without changing their children, retry-safe', async t => {
  for (const unified of [false, true]) {
    const f = await native(t, unified);
    const child = f.put({ status: 'open' });
    await f.send(child);
    const group = f.put({ kind: 'initiative', status: 'open', intentIds: unified ? [child.itemId] : [] });
    await f.send(group);
    const abandon = {
      action: 'abandon',
      operationId: randomUUID(),
      intentId: group.itemId,
      reason: 'Different direction',
    };
    const original = await f.agent.dispatch(abandon);
    const retried = await f.agent.dispatch(abandon);
    assert.deepEqual(retried.result, original.result);
    assert.equal(f.work.store.load().planningItems.filter(item => item.id === group.itemId).length, 2);
    assert.equal(f.work.store.load().planningItems.at(-1).reason, abandon.reason);
    if (unified) {
      assert.equal(f.work.store.select('initiatives', group.itemId).status, 'abandoned');
      assert.equal(f.work.store.select('intents', child.itemId).status, 'active');
    } else {
      const closed = await f.agent.dispatch({
        ...abandon,
        operationId: randomUUID(),
        intentId: child.itemId,
      });
      assert.equal(closed.result.status, 'abandoned');
    }
    await assert.rejects(
      f.agent.dispatch({ ...abandon, reason: 'Changed request' }),
      error => error.code === 'WORK_OPERATION_CHANGED',
    );
  }
});
test('hosted legacy and unified Proposed/abandon writes preserve history, lifecycle index, authority and child states', async t => {
  for (const unified of [false, true]) {
    const s = await setup(t, true, unified ? (_root, work) => upgrade(work) : undefined);
    const command = s.item({ status: 'proposed' });
    await s.send(command);
    const brief = await briefs.brief._handler(s.ctx, {
      projectId: s.projectId,
      situation: 'start-intent',
      intentId: command.itemId,
      agent: 'generic',
    });
    assert.equal(brief.context.intentId, command.itemId);
    assert.equal(brief.context.intent.status, 'proposed');
    const plan = { ...command, operationId: randomUUID(), expectedVersion: 1, status: 'open' };
    await s.send(plan);
    const abandon = {
      ...plan,
      operationId: randomUUID(),
      expectedVersion: 2,
      status: 'abandoned',
      reason: 'Superseded by new plan',
    };
    const revision = (await s.read()).data.revision;
    await s.send(abandon, revision);
    await s.send(abandon, revision);
    const group = s.item({ kind: 'initiative', intentIds: unified ? [command.itemId] : [] });
    await s.send(group);
    await s.send({
      ...group,
      operationId: randomUUID(),
      expectedVersion: 1,
      status: 'abandoned',
      reason: 'Stopped Initiative',
    });
    const data = (await s.read()).data;
    assert.deepEqual(
      data.planningItems.filter(item => item.id === command.itemId).map(item => item.status),
      ['proposed', 'open', 'abandoned'],
    );
    assert.equal(data.planningItems.findLast(item => item.id === command.itemId).reason, abandon.reason);
    if (unified) {
      assert.equal(data.intents.find(item => item.id === command.itemId).status, 'abandoned');
      const events = [...s.tables.projectWorkRecords.values()]
        .filter(row => row.collection === 'lifecycle' && row.parent === command.itemId)
        .map(row => JSON.parse(row.value));
      assert.deepEqual(
        events.map(event => event.to),
        ['proposed', 'active', 'abandoned'],
      );
      assert.equal(events[2].reason, abandon.reason);
    }
    s.ctx.auth.getUserIdentity = async () => null;
    await assert.rejects(s.send({ ...plan, operationId: randomUUID(), expectedVersion: 3 }), denied);
    await assert.rejects(
      briefs.brief._handler(s.ctx, {
        projectId: s.projectId,
        situation: 'start-intent',
        intentId: command.itemId,
        agent: 'generic',
      }),
      denied,
    );
  }
});

test('first Lane starts a stored Proposed unified Intent without creating a second Intent', async t => {
  const f = await native(t, true);
  const proposal = f.put();
  await f.send(proposal);
  const lane = (
    await f.agent.dispatch({ action: 'start', intentId: proposal.itemId, outcome: proposal.title })
  ).result;
  assert.equal(lane.intentId, proposal.itemId);
  assert.equal(f.work.store.load().intents.length, 1);
  const intent = f.work.store.select('intents', proposal.itemId);
  assert.equal(intent.status, 'active');
  assert.equal(typeof intent.base, 'string');
  assert.equal(intent.lifecycle.at(-1).from, 'proposed');
  assert.equal(intent.lifecycle.at(-1).to, 'active');
});
