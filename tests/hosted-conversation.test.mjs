// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { lifecycleFixture, code } from './hosted-lane-lifecycle-fixture.mjs';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
import { dispatchCoordination } from '../dist/coordination-client.js';
import { sessionAgentIdentity } from '../dist/agent-slug-session.js';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';

const events = await import(moduleUrl('../convex/projectCoordination.ts'));
const reads = await import(moduleUrl('../convex/projectCoordinationReads.ts'));
const modules = { projectCoordination: events, projectCoordinationReads: reads };

async function fixture(t) {
  const f = await lifecycleFixture();
  const s = agentFixture(t);
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'writer' });
  const lane = await f.addLane({
    actor: 'writer',
    holder: {
      actor: 'writer',
      sessionId: sessionAgentIdentity('fixture-agent-session').sessionId,
      since: 100,
      lastSeen: 100,
    },
  });
  const transport = s.transport();
  const requests = [];
  const invoke = (actor, name, args) => {
    const [module, method] = name.split(':');
    requests.push({ actor, name });
    return f.transaction(name, modules[module][method], { projectId: f.projectId, ...args }, actor);
  };
  t.mock.method(transport, 'mutation', (name, args) => invoke('writer', name, args));
  const coord = (actor, input) => {
    const run = (ref, { projectId: _, ...args }) => invoke(actor, getFunctionName(ref), args);
    return dispatchCoordination({ query: run, mutation: run }, f.projectId, input);
  };
  const cli = (action, body) => hostedAgentCli(s.root, action, body, s.address, transport);
  return { ...f, lane, cli, transport, coord, invoke, requests };
}

test('a Lane question keeps its exact choice and prompt after the asking CLI exits', async t => {
  const f = await fixture(t);
  const { id: laneId } = f.lane;
  const input = {
    laneId,
    operationId: randomUUID(),
    to: 'owner',
    text: 'Which shared endpoint?',
    choices: ['Use v1', 'Use v2'],
  };
  await assert.rejects(f.cli('ask', { ...input, choices: ['Use v1', 'Use v1'] }));
  assert.equal(f.requests.length, 0);
  const sent = await f.cli('ask', input);
  assert.equal(sent.operationId, input.operationId);
  assert.equal(sent.result.kind, 'question');
  assert.deepEqual(sent.result.choices, input.choices);
  assert.deepEqual(await f.cli('ask', input), sent);
  await assert.rejects(f.cli('ask', { ...input, text: 'Changed question?' }), code('WORK_OPERATION_CHANGED'));
  assert(f.requests.every(r => r.name === 'projectCoordination:publish'));
  assert.equal(f.requests.length, 3, 'each valid send or replay makes one mutation');

  const answer = {
    action: 'ack',
    operationId: randomUUID(),
    messageId: sent.operationId,
    choice: 'Use v2',
    text: 'Both clients support it.',
  };
  await assert.rejects(f.coord('writer', answer), /recipient/);
  await assert.rejects(f.coord('owner', { ...answer, choice: 'use v2' }), /exact choices/);
  await f.coord('owner', { action: 'ack', messageId: sent.operationId });
  const question = (await f.coord('owner', { action: 'unacked' })).items[0];
  assert.equal(question.id, sent.operationId);
  assert.equal(question.acked, true);
  assert.deepEqual(await f.coord('owner', answer), await f.coord('owner', answer));
  await assert.rejects(
    f.coord('owner', { ...answer, operationId: randomUUID() }),
    /already has your chosen answer/,
  );
  const inbox = await f.coord('writer', { action: 'inbox' });
  assert.equal(inbox.items.length, 1);
  const [retained] = inbox.items;
  assert.equal(retained.kind, 'answer');
  assert.equal(retained.laneId, laneId);
  assert.equal(retained.messageId, sent.operationId);
  assert.equal(retained.choice, 'Use v2');
  assert.match(retained.resumePrompt, new RegExp(laneId));
  assert.match(retained.resumePrompt, /"Use v2".*"Both clients support it\."/);
  assert.equal(retained.acked, false);
  assert.equal(f.tables.projectCoordinationReceipts.size, 1);
  assert.equal(f.tables.projectCoordinationEvents.size, 3);
  assert.deepEqual((await f.coord('writer', { action: 'unacked' })).items, [retained]);
  const seen = { action: 'ack', messageId: retained.id, operationId: randomUUID() };
  await assert.rejects(f.coord('owner', seen), /recipient/);
  await assert.rejects(f.coord('writer', { ...seen, choice: 'Use v1' }), /exact choices/);
  await f.coord('writer', seen);
  assert.deepEqual((await f.coord('writer', { action: 'unacked' })).items, []);
  assert.deepEqual((await f.coord('writer', { action: 'inbox' })).items, [{ ...retained, acked: true }]);
  assert.deepEqual(await f.read(laneId), f.lane);
  assert.equal(f.scheduled.length, 0);
});

test('one Item feed retains questions and answers independent of the number of unrelated events', async t => {
  const f = await fixture(t);
  const planningItemId = randomUUID();
  const backupId = 'projectBackups-fixture';
  const generationId = f.insert('projectWorkGenerations', {
    projectId: f.projectId,
    backupId,
    format: HOSTED_WORK_INDEX_FORMAT,
    status: 'ready',
    initialRevision: 0,
    revision: 0,
    nextBatch: 0,
    metadata: '{"schema":24}',
  });
  f.patch('hostedProjects', f.projectId, {
    work: { operationId: randomUUID(), initialRevision: 0, revision: 0, backupId, generationId },
  });
  f.insert('projectPlanningRecords', {
    projectId: f.projectId,
    generationId,
    collection: 'planningSearch',
    key: planningItemId,
    parent: '',
    position: 1,
    value: JSON.stringify({ id: planningItemId, kind: 'issue', status: 'open' }),
  });
  const input = {
    planningItemId,
    to: 'owner',
    text: 'Which shared endpoint?',
    choices: ['A', 'B'],
    holdsWork: false,
  };
  await assert.rejects(f.cli('ask', { ...input, planningItemId: randomUUID() }), code('NOT_FOUND'));
  const costs = [];
  for (const scale of [400, 800]) {
    while (f.tables.projectCoordinationEvents.size < scale) {
      f.insert('projectCoordinationEvents', {
        projectId: f.projectId,
        operationId: randomUUID(),
        actor: 'owner',
        at: 1,
        command: { kind: 'message', text: 'Unrelated', context: {} },
      });
    }
    const start = performance.now();
    const question = await f.cli('ask', input);
    const cost = f.counts.at(-1);
    costs.push({ documents: cost.documents, ranges: cost.ranges, writes: cost.writes });
    t.diagnostic(
      JSON.stringify({
        scale,
        ...costs.at(-1),
        readBytes: cost.readBytes,
        writeBytes: cost.writeBytes,
        elapsedMs: performance.now() - start,
        peakRssKiB: process.resourceUsage().maxRSS,
      }),
    );
    assert.equal(question.result.planningItemId, planningItemId);
    assert.equal(question.result.holdsWork, false);
    await f.coord('owner', { action: 'ack', messageId: question.operationId, choice: 'A' });
  }
  assert.deepEqual(costs[0], costs[1], 'the same operation touches the same rows at doubled scale');
  const feed = await f.coord('writer', { action: 'feed', planningItemId, pageSize: 20 });
  assert.deepEqual(
    feed.page.map(event => event.command.kind),
    ['message', 'ack', 'message', 'ack'],
  );
  assert(feed.page.filter(row => row.resumePrompt).every(row => row.resumePrompt.includes(planningItemId)));
  assert(feed.isDone);
});

test('MCP hand-back releases the current holder with one write call and keeps the saved source', async t => {
  const f = await fixture(t);
  const server = new McpServer({ name: 'forge', version: 'test' });
  const close = registerHostedAgentWorkflow(server, f.transport);
  const client = new Client({ name: 'forge-fixture', version: 'test' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    close();
    await client.close();
    await server.close();
  });
  const input = {
    action: 'hand-back',
    operationId: randomUUID(),
    laneId: f.lane.id,
    head: f.lane.head,
    to: 'owner',
    tried: 'Ran compatibility tests',
    left: 'Choose an endpoint',
  };
  const call = async command => {
    const response = await client.callTool({ name: 'forge_task', arguments: { command } });
    return JSON.parse(response.content[0].text);
  };
  const wrongHead = await call({ ...input, head: 'b'.repeat(64) });
  assert.equal(wrongHead.error.code, 'WORK_STALE');
  f.transport.agentSession = 'another-agent';
  assert.equal((await call(input)).error.code, 'WORK_STALE');
  f.transport.agentSession = 'fixture-agent-session';
  const sent = await call(input);
  assert.equal(sent.operationId, input.operationId);
  assert.equal(sent.result.kind, 'hand-back');
  assert.equal(sent.result.tried, input.tried);
  assert.equal(sent.result.left, input.left);
  assert.deepEqual(await call(input), sent);
  assert.equal((await call({ ...input, left: 'Changed follow-up' })).error.code, 'WORK_OPERATION_CHANGED');
  assert.equal(f.tables.projectCoordinationEvents.size, 1);
  assert(!JSON.stringify([...f.tables.projectCoordinationEvents.values()]).includes(f.lane.holder.sessionId));
  assert.equal(f.requests.length, 5);
  assert(f.requests.every(r => r.name === 'projectCoordination:publish'));
  const unheld = await f.read(f.lane.id);
  assert.equal(unheld.holder, undefined);
  for (const field of ['actor', 'at', 'base', 'head', 'sourceVersion', 'lifecycleVersion', 'state'])
    assert.deepEqual(unheld[field], f.lane[field]);
  assert.equal(unheld.version, f.lane.version + 1);
  assert.equal((await f.coord('owner', { action: 'inbox' })).items[0].head, f.lane.head);
  await f.coord('owner', {
    action: 'ack',
    messageId: input.operationId,
    choice: 'Decline',
    text: 'Try v1 first.',
  });
  assert.equal((await f.coord('writer', { action: 'unacked' })).items[0].choice, 'Decline');
  assert.deepEqual(await f.read(f.lane.id), unheld);
});

test('the project owner can hand a Lane back to its author and receives a decline', async t => {
  const f = await fixture(t);
  const operationId = randomUUID();
  await f.invoke('owner', 'projectCoordination:publish', {
    operationId,
    command: {
      kind: 'handoff',
      to: 'writer',
      summary: 'Ran review',
      head: f.lane.head,
      laneId: f.lane.id,
      handBack: { left: 'Choose state' },
    },
  });
  await f.coord('writer', { action: 'ack', messageId: operationId, choice: 'Decline' });
  const [decline] = (await f.coord('owner', { action: 'unacked' })).items;
  assert.equal(decline.messageId, operationId);
  assert.equal(decline.choice, 'Decline');
  assert.equal(decline.laneId, f.lane.id);
  const lane = await f.read(f.lane.id);
  assert.equal(lane.actor, f.lane.actor, 'the author record remains provenance');
  assert.equal(lane.holder, undefined);
});

test('public Activity and read-only roles cannot read questions, answers or hand-back content', async t => {
  const f = await fixture(t);
  f.patch('hostedProjects', f.projectId, { visibility: 'public' });
  f.insert('projectReaders', { projectId: f.projectId, reader: 'reader' });
  const laneId = f.lane.id;
  const question = await f.cli('ask', {
    laneId,
    to: 'owner',
    text: 'Which endpoint?',
    choices: ['Choose X', 'Choose Y'],
  });
  await f.coord('owner', { action: 'ack', messageId: question.operationId, choice: 'Choose X' });
  const back = await f.cli('hand-back', {
    laneId,
    head: f.lane.head,
    to: 'owner',
    tried: 'Tried X',
    left: 'Review Y',
  });
  const legacyId = randomUUID();
  await f.invoke('owner', 'projectCoordination:publish', {
    operationId: legacyId,
    command: { kind: 'message', text: 'Public coordination', context: { laneId } },
  });
  for (const pick of [{ action: 'feed' }, { action: 'recent' }, { action: 'related', laneIds: [laneId] }]) {
    const owner = await f.coord('owner', pick);
    assert((owner.page ?? owner.items).some(row => (row.operationId ?? row.id) === back.operationId));
    for (const actor of ['reader', 'visitor']) {
      const reply = await f.coord(actor, { ...pick, pageSize: 10 });
      assert.deepEqual(
        (reply.page ?? reply.items).map(row => row.operationId ?? row.id),
        [legacyId],
      );
      assert(reply.isDone);
    }
  }
});
