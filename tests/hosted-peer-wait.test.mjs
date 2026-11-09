// SPDX-License-Identifier: Apache-2.0
// Issue 544b3375: `wait {peer}` through the real CLI dispatcher (with the binary's validation step) and MCP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import { agentCli } from '../dist/agent-cli.js';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
import { peerWaitHooks } from '../dist/hosted-board-wait.js';
import { approvalWaitHooks } from '../dist/hosted-agent-approval.js';
import { hostedAgentHelp } from '../dist/hosted-agent-help.js';
import { agentFixture } from './hosted-agent-fixture.mjs';

const code = expected => error => error.code === expected;
const turn = () => new Promise(resolve => setImmediate(resolve));
const until = async ready => {
  for (let i = 0; i < 200 && !ready(); i++) await turn();
  assert(ready(), 'condition reached');
};

function environment(t) {
  const s = agentFixture(t);
  s.caps.features = ['board-wait'];
  const previous = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-test-credential';
  const exitCode = process.exitCode;
  const subs = [];
  peerWaitHooks.subscribe = () => ({
    onUpdate(ref, args, next) {
      subs.push({ name: getFunctionName(ref), args, next });
      return () => {};
    },
    async close() {},
  });
  approvalWaitHooks.subscribe = peerWaitHooks.subscribe;
  t.after(() => {
    peerWaitHooks.subscribe = undefined;
    approvalWaitHooks.subscribe = undefined;
    process.exitCode = exitCode;
    if (previous === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = previous;
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert(String(url).startsWith(s.address.url), 'No real HTTP calls');
    const body = JSON.parse(init.body);
    const ref = makeFunctionReference(body.path);
    const value = await (String(url).endsWith('/api/query')
      ? s.exchange.client.query(ref, body.args[0])
      : s.exchange.client.mutation(ref, body.args[0]));
    return new Response(JSON.stringify({ status: 'success', value }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  return { s, subs };
}
// The installed binary validates before dispatch (enableCliRuntimePreparation); this is that step.
const binary = { process: true, beforeDispatch: async () => true };
const peerState = (laneId, state, extra = {}) =>
  JSON.stringify({ peer: { laneId, state, terminal: state !== 'open', ...extra } });

for (const [name, kind] of [
  ['a clone root', 'clone'],
  ['a Lane root', 'lane'],
]) {
  test(`CLI wait {peer} works from ${name}: one capability read, one subscription, ends on every terminal state`, async t => {
    const { s, subs } = environment(t);
    let root = join(dirname(s.root), 'clone');
    const address = { url: s.address.url, projectId: s.address.projectId };
    if (kind === 'lane') {
      await s.transport().dispatch('open', { laneId: s.lane.laneId });
      root = s.root;
    }
    const peer = randomUUID();
    const run = async state => {
      const before = s.calls.length;
      const subscribed = subs.length;
      const waiting = agentCli(
        [root, 'wait', JSON.stringify({ ...(kind === 'clone' ? address : {}), peer: peer.slice(0, 8) })],
        binary,
      );
      await until(() => subs.length > subscribed);
      const subscription = subs.at(-1);
      assert.equal(subscription.name, 'projectBoardWait:peer');
      assert.equal(subscription.args.peer, peer.slice(0, 8));
      assert.equal(
        'laneId' in subscription.args,
        kind === 'lane',
        'a Lane root also watches its own inbox; a clone root has no Lane',
      );
      subscription.next(peerState(peer, 'open'));
      await turn();
      subscription.next(
        peerState(
          peer,
          state,
          state === 'accepted'
            ? { receiptId: 'r', commit: 'c' }
            : { landing: { operationId: randomUUID(), phase: 'terminal-failed' } },
        ),
      );
      const response = await waiting;
      assert.equal(response.result.status, 'terminal');
      assert.equal(response.result.reason, 'peer');
      assert.equal(response.result.peer.state, state);
      assert.equal(process.exitCode, 0);
      // Budget: exactly one capability read; the only other traffic is the one subscription.
      assert.deepEqual(
        s.calls.slice(before).map(call => call.name),
        ['projectHostedAgent:capabilities'],
      );
      return response;
    };
    await run('accepted');
    const failed = await run('failed');
    assert.match(failed.result.next, /latest landing failed.*still open/);
    const cancelled = await run('cancelled');
    assert.match(cancelled.result.next, /latest landing cancelled/);
    await run('closed');
    assert.equal(subs.length, 4, 'one subscription per wait');
  });
}

test('CLI wait {approval} is one subscription with no other call; it returns on the owner decision', async t => {
  const { s, subs } = environment(t);
  const root = join(dirname(s.root), 'clone');
  const address = { url: s.address.url, projectId: s.address.projectId };
  const laneId = randomUUID();
  for (const decision of ['granted', 'declined']) {
    const before = s.calls.length;
    const subscribed = subs.length;
    const waiting = agentCli([root, 'wait', JSON.stringify({ ...address, approval: laneId })], binary);
    await until(() => subs.length > subscribed);
    const subscription = subs.at(-1);
    assert.equal(subscription.name, 'projectHostedApprovals:observe');
    assert.deepEqual(subscription.args, { projectId: s.address.projectId, laneId });
    subscription.next(JSON.stringify({ laneId, status: 'requested', version: 1 }));
    await turn();
    subscription.next(JSON.stringify({ laneId, status: decision, version: 2 }));
    const response = await waiting;
    assert.equal(response.result.status, 'terminal');
    assert.equal(response.result.reason, 'approval');
    assert.equal(response.result.approval.status, decision);
    assert.match(response.result.next, decision === 'granted' ? /granted.*land --save/ : /declined/);
    assert.equal(process.exitCode, 0);
    assert.deepEqual(s.calls.slice(before), [], 'no query or mutation: only the subscription');
  }
});

test('CLI request-approval defaults to the checkout Lane: one mutation with a generated operationId', async t => {
  const { s } = environment(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const before = s.calls.length;
  const reply = await agentCli(
    [s.root, 'request-approval', JSON.stringify({ reason: 'touches billing' })],
    binary,
  );
  const calls = s.calls.slice(before);
  assert.deepEqual(
    calls.map(call => call.name),
    ['projectHostedApprovals:request'],
  );
  assert.equal(calls[0].args.laneId, s.lane.laneId);
  assert.equal(calls[0].args.reason, 'touches billing');
  assert.match(calls[0].args.operationId, /^[0-9a-f-]{36}$/);
  assert.equal(reply.operationId, calls[0].args.operationId);
  assert.equal(reply.result.status, 'requested');
  await assert.rejects(
    agentCli([s.root, 'request-approval', JSON.stringify({})], binary),
    code('BAD_ARGUMENT'),
  );
  const dropped = await agentCli([s.root, 'request-approval', JSON.stringify({ withdraw: true })], binary);
  assert.equal(dropped.result.live, false);
});

test('CLI wait takes exactly one of runId, operationIds, peer', async t => {
  const { s } = environment(t);
  const root = join(dirname(s.root), 'clone');
  const address = { url: s.address.url, projectId: s.address.projectId };
  const peer = randomUUID().slice(0, 8);
  for (const extra of [
    {},
    { peer, runId: randomUUID() },
    { peer, operationIds: [randomUUID()] },
    { approval: randomUUID(), runId: randomUUID() },
    { approval: randomUUID(), peer },
    { runId: randomUUID(), operationIds: [randomUUID()] },
  ])
    await assert.rejects(
      agentCli([root, 'wait', JSON.stringify({ ...address, ...extra })], binary),
      code('BAD_ARGUMENT'),
      JSON.stringify(Object.keys(extra)),
    );
  assert.equal(s.calls.length, 0, 'refused before any call');
  assert.match(hostedAgentHelp('wait'), /wait takes exactly one of runId, operationIds, peer or approval/);
  assert.match(hostedAgentHelp('wait'), /latest landing fails or is cancelled/);
});

test('MCP forge_wait {peer} ends on accepted, failed and cancelled; one capability read, one subscription', async t => {
  const { s, subs } = environment(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const server = new McpServer({ name: 'nanthai-forge', version: 'test' });
  const close = registerHostedAgentWorkflow(server, s.transport(), () => peerWaitHooks.subscribe());
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    close();
    await client.close();
    await server.close();
  });
  const peer = randomUUID();
  for (const state of ['accepted', 'failed', 'cancelled']) {
    const before = s.calls.length;
    const subscribed = subs.length;
    const waiting = client.callTool({ name: 'forge_wait', arguments: { peer: peer.slice(0, 8) } });
    await until(() => subs.length > subscribed);
    subs.at(-1).next(peerState(peer, state));
    const response = await waiting;
    assert.notEqual(response.isError, true, response.content?.[0]?.text);
    const result = JSON.parse(response.content[0].text).result;
    assert.equal(result.status, 'terminal');
    assert.equal(result.peer.state, state);
    assert.deepEqual(
      s.calls.slice(before).map(call => call.name),
      ['projectHostedAgent:capabilities'],
    );
  }
  const refused = await client.callTool({
    name: 'forge_wait',
    arguments: { peer: peer.slice(0, 8), runId: randomUUID() },
  });
  assert.equal(refused.isError, true);
});
