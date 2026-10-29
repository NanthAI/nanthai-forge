import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
import { z } from 'zod';
// SPDX-License-Identifier: Apache-2.0
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
import { boundAgentRecords } from '../dist/hosted-agent-bound.js';
import { updateHostState } from '../dist/host-binding.js';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { unacknowledgedOverlaps } from '../dist/agent-edit-notices.js';
import { recordsFixture } from './hosted-context-records-fixture.mjs';
const code = expected => error => error.code === expected;
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

test('server-bound workflow routes records and acknowledgements to hosted without changing native Work', async t => {
  const previousToken = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-only';
  t.after(() => {
    if (previousToken === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = previousToken;
  });
  const s = fixture(t);
  mkdirSync(s.root);
  writeFileSync(join(s.root, 'synthetic.txt'), 'fixture\n');
  initNative(s.root);
  const agent = new AgentWorkflow(s.root),
    lane = (await agent.dispatch({ action: 'start', outcome: 'Synthetic bound records' })).result,
    store = agent.work.store;
  updateHostState(store, state => {
    state.binding = {
      projectId: 'project',
      operationId: randomUUID(),
      deployment: s.address.url,
      projectUrl: `${s.address.url}/project`,
      name: 'Fixture',
      visibility: 'private',
      backupId: 'backup',
      autoSync: false,
      sourceAuthority: { mode: 'server', epoch: 1 },
    };
  });
  t.mock.method(HostedAgentTransport.prototype, 'query', (name, args) =>
    s.invoke(name, { projectId: 'project', ...args }),
  );
  t.mock.method(HostedAgentTransport.prototype, 'mutation', (name, args) =>
    s.invoke(name, { projectId: 'project', ...args }),
  );
  const revision = store.revision();
  await agent.dispatch({
    action: 'friction',
    title: 'Bound friction',
    detail: 'Hosted write',
    area: 'records',
  });
  await agent.dispatch({
    action: 'decide',
    target: { kind: 'project' },
    decidedBy: 'Owner',
    what: 'Hosted decision',
    why: 'Context',
  });
  assert.equal((await agent.dispatch({ action: 'decisions' })).result.page.length, 1);
  const noticeId = 'b'.repeat(64),
    directory = join(store.directory, 'overlap-inbox', lane.laneId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${noticeId}.json`),
    JSON.stringify({ noticeId, lanes: [lane.laneId], file: 'synthetic.txt', text: 'Synthetic overlap' }),
  );
  assert.equal(unacknowledgedOverlaps(store.directory, lane.laneId).count, 1);
  const calls = s.counts().calls;
  await agent.dispatch({ action: 'peer-ack', laneId: lane.laneId, noticeId, choice: 'split' });
  assert.equal(s.counts().calls - calls, 1);
  assert.equal(unacknowledgedOverlaps(store.directory, lane.laneId).count, 0);
  assert.equal(store.revision(), revision);
  assert.equal(store.readRecords().manifest.collections.decisions?.count ?? 0, 0);
  assert.equal(store.readRecords().manifest.collections.frictionEvents?.count ?? 0, 0);
  assert.equal(s.tables.projectHostedOverlapAcks.size, 1);
  updateHostState(store, state => {
    state.binding.sourceAuthority = { mode: 'native-owner', epoch: 0 };
  });
  let native = 0;
  await boundAgentRecords(
    store,
    { action: 'friction', title: 'Native' },
    async () => {
      native++;
      return { revision, result: 'native' };
    },
    s.transport,
  );
  assert.equal(native, 1);
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
    { action: 'peer-ack', laneId: randomUUID(), noticeId: 'c'.repeat(64), choice: 'accept-order' },
    { action: 'decisions', cursor: null },
  ]) {
    const tool = tools.get(command.action === 'decisions' ? 'forge_work_overview' : 'forge_task');
    const parsed = z.object(tool.inputSchema).parse({ command });
    const before = s.calls.length,
      response = await tool.call(parsed);
    assert.ok(!response.isError, response.content[0].text);
    assert.equal(s.calls.length - before, 1);
    assert.equal(JSON.parse(response.content[0].text).transport, 'hosted');
  }
});
