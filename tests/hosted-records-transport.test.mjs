// SPDX-License-Identifier: Apache-2.0
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
import { z } from 'zod';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import {
  hostedAgentActions,
  hostedAgentCapabilitiesSchema,
  hostedAgentRecordActions,
} from '../dist/hosted-agent-contract.js';
import { recordsFixture } from './hosted-context-records-fixture.mjs';
const code = expected => error => (error.code ?? error.data?.code) === expected;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-record-transport-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(directory, 'checkout'),
    address = { url: 'https://fixture.invalid', projectId: 'project' },
    s = recordsFixture(),
    calls = [];
  const call = async (ref, args) => {
    const name = getFunctionName(ref);
    calls.push(name);
    return s.invoke(name, args);
  };
  const transport = new HostedAgentTransport(root, address, {
    projectId: 'project',
    client: { query: call, mutation: call },
  });
  return { ...s, root, address, transport, calls };
}

test('record transport uses one call, keeps original operations across lost replies, and adds no advertised capability', async t => {
  const s = fixture(t),
    command = { title: 'Synthetic friction', detail: 'Hosted ROOT', area: 'records' };
  const first = await s.transport.dispatch('friction', command);
  assert.deepEqual(s.calls, ['projectHostedFriction:capture']);
  const replay = await s.transport.dispatch('friction', command);
  assert.deepEqual(replay, first);
  assert.equal(s.tables.projectHostedFriction.size, 1);
  await assert.rejects(
    s.transport.dispatch('friction', { ...command, operationId: first.operationId, title: 'Changed' }),
    code('WORK_OPERATION_CHANGED'),
  );
  const decide = {
    operationId: randomUUID(),
    target: { kind: 'project' },
    decidedBy: 'Owner',
    what: 'Hosted record',
    why: 'Context',
  };
  const mutate = s.transport.exchange.client.mutation;
  let lose = true;
  s.transport.exchange.client.mutation = async (...args) => {
    const result = await mutate(...args);
    if (lose) {
      lose = false;
      throw new Error('Synthetic lost reply');
    }
    return result;
  };
  await assert.rejects(s.transport.dispatch('decide', decide), code('HOSTED_ACTION_FAILED'));
  const result = await s.transport.dispatch('decide', decide);
  assert.equal(result.result.id, decide.operationId);
  assert.equal(s.tables.projectHostedDecisions.size, 1);
  const before = s.calls.length;
  assert.equal((await s.transport.dispatch('decisions', {})).result.page.length, 1);
  assert.equal(s.calls.length - before, 1);
  assert.equal(s.calls.at(-1), 'projectHostedDecisions:list');
  assert(!existsSync(join(s.root, '.forge', 'native')));
  assert(!existsSync(join(s.root, '.forge', 'work')));
  for (const action of hostedAgentRecordActions) assert(!hostedAgentActions.includes(action));
  const capabilities = {
    schema: 1,
    projectId: 'project',
    actor: 'owner',
    authority: { mode: 'server', epoch: 1 },
    actions: hostedAgentActions,
    mainReady: true,
    sourceWorkerConfigured: true,
    checkCallbackConfigured: true,
    nativeOwnerRequired: false,
    observation: 'finite',
  };
  assert.ok(hostedAgentCapabilitiesSchema.safeParse(capabilities).success);
  assert(
    !hostedAgentCapabilitiesSchema.safeParse({ ...capabilities, actions: [...hostedAgentActions, 'decide'] })
      .success,
  );
});

test('old hosted server returns HOSTED_ACTION_UNSUPPORTED without native fallback', async t => {
  const s = fixture(t);
  s.transport.exchange.client.mutation = async () => {
    throw new Error('Could not find public function for projectHostedFriction:capture');
  };
  await assert.rejects(
    s.transport.dispatch('friction', { title: 'Skew', detail: 'Old server', area: 'records' }),
    code('HOSTED_ACTION_UNSUPPORTED'),
  );
  s.transport.exchange.client.query = async () => {
    throw new Error('Could not find public function for projectHostedDecisions:list');
  };
  await assert.rejects(s.transport.dispatch('decisions', {}), code('HOSTED_ACTION_UNSUPPORTED'));
  assert(!existsSync(join(s.root, '.forge', 'work')));
});

test('hosted MCP exposes record writes and paged decision reads through the shared transport', async t => {
  const s = fixture(t),
    tools = new Map();
  const close = registerHostedAgentWorkflow(
    {
      registerTool(name, configuration, call) {
        tools.set(name, { ...configuration, call });
      },
    },
    s.transport,
  );
  t.after(close);
  for (const command of [
    { action: 'friction', title: 'MCP capture', detail: 'Synthetic', area: 'records' },
    {
      action: 'decide',
      target: { kind: 'project' },
      decidedBy: 'Owner',
      what: 'MCP decision',
      why: 'Context',
    },
    { action: 'decisions', cursor: null },
  ]) {
    const tool = tools.get(command.action === 'decisions' ? 'forge_work_overview' : 'forge_task');
    const parsed = z.object(tool.inputSchema).parse({ command });
    const before = s.calls.length,
      response = await tool.call(parsed);
    assert.ok(!response.isError, response.content[0].text);
    assert.equal(s.calls.length - before, 1);
    assert.equal(JSON.parse(response.content[0].text).action, command.action);
  }
});

test('friction validation names every field without a network call', async t => {
  const s = fixture(t);
  for (const [field, value] of [
    ['title', ''],
    ['detail', 3],
    ['area', null],
    ['laneId', 'wrong'],
    ['cost', { minutes: -1 }],
    ['operationId', 'wrong'],
  ]) {
    await assert.rejects(
      s.transport.dispatch('friction', { title: 'Title', detail: 'Detail', area: 'cli', [field]: value }),
      error =>
        error.code === 'BAD_ARGUMENT' && error.message.includes(field) && error.message.includes('--help'),
    );
  }
  assert.deepEqual(s.calls, []);
});

test('project friction omits Lane and Lane friction infers it using the same single mutation', async t => {
  const s = fixture(t);
  const project = await s.transport.dispatch('friction', { title: 'Project', detail: 'Detail', area: 'cli' });
  assert.equal(project.result.laneId, undefined);
  const laneId = randomUUID(),
    head = 'a'.repeat(64);
  mkdirSync(join(s.root, '.forge'), { recursive: true });
  writeFileSync(
    join(s.root, '.forge/hosted-lane.json'),
    JSON.stringify({
      schema: 1,
      kind: 'forge-hosted-lane-checkout',
      url: s.address.url,
      operationId: randomUUID(),
      selection: {
        schema: 2,
        projectId: 'project',
        laneId,
        intentId: randomUUID(),
        head,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: 'active',
        base: { head, receiptId: randomUUID() },
        authority: { mode: 'server', epoch: 1 },
      },
      state: {
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: [],
        message: 'Fixture',
        at: '2026-01-01T00:00:00Z',
      },
      scope: null,
      materialized: [],
    }),
  );
  s.tables.projectHostedRecordHeads.set('lane', { projectId: 'project', kind: 'lane', key: laneId });
  const lane = await s.transport.dispatch('friction', { title: 'Lane', detail: 'Detail', area: 'cli' });
  assert.equal(lane.result.laneId, laneId);
  assert.deepEqual(s.calls, ['projectHostedFriction:capture', 'projectHostedFriction:capture']);
});

test('records discovers canonical saved work in one bounded call and reads exact authorized versions', async t => {
  const s = fixture(t);
  const { writeHostedRecord } = await import(
    (await import('./convex-module.mjs')).moduleUrl('../convex/projectHostedRecords.ts')
  );
  const parentId = randomUUID(),
    hash = 'a'.repeat(64);
  const records = [];
  for (let i = 0; i < 205; i++) {
    const record = {
      kind: 'save',
      id: randomUUID(),
      version: 0,
      at: '2026-01-01T00:00:00.000Z',
      laneId: parentId,
      actor: 'owner',
      operationId: randomUUID(),
      expectedHead: hash,
      expectedSourceVersion: i,
      head: hash,
      sourceVersion: i + 1,
      changes: { sha256: hash, size: 1 },
    };
    await writeHostedRecord(s.ctx, {
      projectId: 'project',
      actor: 'owner',
      authorityEpoch: 1,
      record,
      expectedVersion: null,
    });
    records.push(record);
  }
  const before = s.counts();
  const first = (await s.transport.dispatch('records', { collection: 'saves', parentId })).result;
  const after = s.counts();
  assert.equal(after.calls - before.calls, 1);
  assert.equal(after.writes, before.writes);
  assert.equal(
    after.reads - before.reads,
    201,
    'one project, 100 heads and 100 descriptors; no bodies or project hydration',
  );
  assert.equal(first.items.length, 100);
  assert(first.items.every(row => row.parentId === parentId && row.source.digest && !row.value));
  const second = (
    await s.transport.dispatch('records', { collection: 'saves', parentId, cursor: first.nextCursor })
  ).result;
  const third = (
    await s.transport.dispatch('records', { collection: 'saves', parentId, cursor: second.nextCursor })
  ).result;
  assert.equal(third.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map(row => row.id)).size, 205);
  const calls = s.calls.length;
  await assert.rejects(
    s.transport.dispatch('records', { collection: 'jobs', cursor: first.nextCursor }),
    code('BAD_ARGUMENT'),
  );
  await assert.rejects(
    s.transport.dispatch('records', { collection: 'saves', parentId, status: 'active' }),
    code('BAD_ARGUMENT'),
  );
  assert.equal(s.calls.length, calls, 'invalid selection cannot make a network call');
  const selected = records[0];
  const exact = (await s.transport.dispatch('records', { collection: 'saves', id: selected.id, version: 0 }))
    .result;
  assert.deepEqual(exact.record.value, selected);
  await assert.rejects(
    s.transport.dispatch('records', { collection: 'saves', id: selected.id, version: 1 }),
    code('NOT_FOUND'),
  );
  s.caller('stranger');
  for (const input of [{ collection: 'saves' }, { collection: 'saves', id: selected.id, version: 0 }])
    await assert.rejects(s.transport.dispatch('records', input), code('PROJECT_UNAVAILABLE'));
  assert.equal(s.scheduled.length, 0);
  assert(!existsSync(join(s.root, '.forge', 'work')));
});

test('MCP dispatches records and retained check logs through the same supported read paths', async t => {
  const s = fixture(t),
    tools = new Map();
  t.after(
    registerHostedAgentWorkflow(
      {
        registerTool(name, configuration, call) {
          tools.set(name, { ...configuration, call });
        },
      },
      s.transport,
    ),
  );
  const query = s.transport.exchange.client.query;
  s.transport.exchange.client.query = async (ref, args) => {
    const name = getFunctionName(ref);
    if (name === 'projectHostedOutputRead:manifest') return { status: 'passed', complete: true };
    if (name === 'projectHostedOutputRead:streams') return { page: [], isDone: true, continueCursor: '' };
    return query(ref, args);
  };
  for (const [toolName, command] of [
    ['forge_work_overview', { action: 'records', collection: 'candidates' }],
    ['forge_check', { action: 'log', runId: randomUUID() }],
  ]) {
    const tool = tools.get(toolName);
    const parsed = z.object(tool.inputSchema).parse({ command });
    const reply = await tool.call(parsed);
    assert(!reply.isError, reply.content[0].text);
    const actual = JSON.parse(reply.content[0].text);
    const { action, ...input } = command;
    assert.deepEqual(actual.result, (await s.transport.dispatch(action, input)).result);
    assert.equal(actual.action, action);
    assert.equal(actual.operationId, null);
  }
});
