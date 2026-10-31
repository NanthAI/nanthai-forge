// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mcpTestEnvironment, requestOptions } from './mcp-runtime.mjs';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { makeFunctionReference, getFunctionName } from 'convex/server';
import { checkArgs } from './convex-args.mjs';
import { moduleUrl } from './convex-module.mjs';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';
import { hostedAgentCommandSchemas, hostedAgentAction } from '../dist/hosted-agent-contract.js';
import { startMcp } from '../dist/mcp.js';
import { agentCli } from '../dist/agent-cli.js';
import { agentFixture } from './hosted-agent-fixture.mjs';

function syntheticAuth(t) {
  const previous = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-account-credential';
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = previous;
  });
}
function registry(t, s) {
  const tools = new Map();
  const close = registerAgentWorkflow(
    {
      registerTool(name, config, call) {
        tools.set(name, { ...config, call });
      },
    },
    s.root,
    s.transport(),
  );
  t.after(close);
  return tools;
}
const body = response => JSON.parse(response.content[0].text);
const parameters = s => ({
  start: { outcome: 'MCP parity' },
  open: { laneId: s.lane.laneId },
  save: { message: 'Save parity' },
  checkpoint: { message: 'Save parity' },
  compose: { laneId: s.lane.laneId },
  sync: { laneId: s.lane.laneId, apply: false },
  check: { candidateId: s.candidate.id, checkId: randomUUID() },
  run: { candidateId: s.candidate.id, checkId: randomUUID() },
  finish: { laneId: s.lane.laneId },
  prioritize: { submissionId: randomUUID(), priority: 'urgent' },
  cancel: { submissionId: randomUUID() },
  revert: { target: { kind: 'receipt', receiptId: randomUUID() } },
  abandon: { laneId: s.lane.laneId, reason: 'Superseded' },
  reopen: { laneId: s.lane.laneId },
  pin: { laneId: s.lane.laneId, pinned: true },
  status: { laneId: s.lane.laneId },
  observe: { runId: randomUUID() },
  capabilities: {},
});
for (const action of [
  'start',
  'open',
  'save',
  'checkpoint',
  'compose',
  'sync',
  'check',
  'run',
  'finish',
  'prioritize',
  'cancel',
  'revert',
  'abandon',
  'reopen',
  'pin',
  'status',
  'observe',
  'capabilities',
])
  test(`MCP ${action} uses the CLI action schema, envelope and original journal`, async t => {
    const s = agentFixture(t),
      tools = registry(t, s);
    if (['save', 'checkpoint'].includes(action))
      await s.transport().dispatch('open', { laneId: s.lane.laneId });
    const tool = tools.get(
      ['check', 'run', 'observe'].includes(action)
        ? 'forge_check'
        : ['status', 'capabilities'].includes(action)
          ? 'forge_work_overview'
          : 'forge_task',
    );
    const command = { action, ...parameters(s)[action] };
    const parsed = z.object(tool.inputSchema).parse({ command }).command;
    const { action: requested, ...input } = parsed;
    const response = await tool.call({ command: parsed });
    assert(!response.isError, response.content[0].text);
    const actual = body(response);
    assert.deepEqual(actual, await s.transport().dispatch(requested, input));
    const { operationId, ...data } = input;
    const expected = hostedAgentCommandSchemas[hostedAgentAction(action)].parse(
      ['status', 'observe'].includes(action) ? input : data,
    );
    assert.deepEqual(
      data,
      Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'operationId')),
    );
    assert(!existsSync(join(s.root, '.forge', 'native')));
    assert(!existsSync(join(s.root, '.forge', 'work')));
  });

for (const [action, api] of [
  ['start', 'projectHostedStart:start'],
  ['check', 'projectHostedChecks:enqueue'],
  ['finish', 'projectHostedLanding:enqueue'],
  ['prioritize', 'projectHostedLandingPriority:prioritize'],
  ['cancel', 'projectHostedLanding:cancel'],
])
  test(`MCP ${action} lost response reconciles through the actual CLI with the original UUID`, async t => {
    const s = agentFixture(t),
      tools = registry(t, s);
    const input =
      action === 'finish'
        ? { candidateId: s.candidate.id, composeOperationId: randomUUID() }
        : parameters(s)[action];
    const tool = tools.get(action === 'check' ? 'forge_check' : 'forge_task');
    s.lose(api);
    assert.equal((await tool.call({ command: { action, ...input } })).isError, true);
    const original = structuredClone(s.calls.filter(call => call.name === api).at(-1).args);
    // Synthetic HTTP adapter exercises the real CLI/ConvexHttpClient without any network.
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert(String(url).startsWith(s.address.url));
      const request = JSON.parse(init.body),
        ref = makeFunctionReference(request.path);
      const value = await s.exchange.client[String(url).endsWith('/api/query') ? 'query' : 'mutation'](
        ref,
        request.args[0],
      );
      return new Response(JSON.stringify({ status: 'success', value }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    syntheticAuth(t);
    const cli = await agentCli([s.root, action, JSON.stringify({ ...s.address, ...input })]);
    assert.equal(
      cli.operationId,
      ['start', 'prioritize'].includes(action)
        ? original.operationId
        : JSON.parse(original.request).operationId,
    );
    assert.deepEqual(body(await tool.call({ command: { action, ...input } })), cli);
    assert.deepEqual(s.calls.filter(call => call.name === api).at(-1).args, original);
    if (action === 'finish') assert.equal(cli.result.submission.request.agent, true);
  });

test('real MCP discovery preserves agent-only authority with strict schemas and no native accept tool', async t => {
  const s = agentFixture(t),
    server = new McpServer({ name: 'nanthai-forge', version: 'test' });
  const close = registerAgentWorkflow(server, s.root, s.transport());
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    close();
    await client.close();
    await server.close();
  });
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'forge_check',
    'forge_current',
    'forge_planning',
    'forge_review',
    'forge_source',
    'forge_task',
    'forge_wait',
    'forge_work_overview',
  ]);
  // Decision conversation attribution has a legitimate nested agent field.
  // Acceptance authority must remain absent from the finish command itself.
  const task = tools.find(tool => tool.name === 'forge_task');
  const variants = task.inputSchema.properties.command.anyOf;
  assert.ok(Array.isArray(variants));
  const finish = variants.find(option => option.properties?.action?.const === 'finish');
  assert.ok(finish);
  assert(!Object.hasOwn(finish.properties, 'agent'));
  for (const command of [
    { action: 'accept', candidateId: s.candidate.id },
    { action: 'finish', laneId: s.lane.laneId, agent: false },
    { action: 'finish', laneId: s.lane.laneId, actor: { kind: 'person' } },
    { action: 'finish', laneId: s.lane.laneId, check: { kind: 'none' } },
  ])
    assert.equal((await client.callTool({ name: 'forge_task', arguments: { command } })).isError, true);
  assert.equal(s.calls.length, 0);
  const response = body(
    await client.callTool({
      name: 'forge_task',
      arguments: { command: { action: 'finish', laneId: s.lane.laneId } },
    }),
  );
  assert.equal(response.result.submission.request.agent, true);
  assert.equal(response.result.submission.phase, 'queued');
  assert.equal(response.result.submission.request.check.kind, 'request');
  const after = s.calls.length;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(s.calls.length, after, 'idle registration starts no remote work');
});

test('hosted startup uses the existing server without owner, presence, graph or network initialization', async t => {
  const s = agentFixture(t);
  syntheticAuth(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('No network during hosted startup'));
  t.mock.method(StdioServerTransport.prototype, 'start', async () => {});
  const server = await startMcp(s.root, true, true, s.address);
  await server.close();
  assert(!existsSync(s.root));
  assert(!existsSync(`${s.root}.forge-client`));
  await assert.rejects(startMcp(s.root, true, true, { projectId: 'project' }), { code: 'BAD_ARGUMENT' });
});

test('finite hosted MCP reads query only capabilities and the selected target; current authority is rechecked', async t => {
  const s = agentFixture(t),
    tools = registry(t, s);
  for (const command of [
    { action: 'observe', runId: randomUUID() },
    { action: 'observe', kind: 'save', operationId: randomUUID() },
    { action: 'observe', submissionId: randomUUID(), version: 3 },
  ]) {
    const before = s.calls.length;
    assert(!(await tools.get('forge_check').call({ command })).isError);
    assert.equal(s.calls.length - before, 2);
  }
  s.allow(false);
  const response = await tools.get('forge_work_overview').call({ command: { action: 'capabilities' } });
  assert.equal(body(response).error.code, 'PROJECT_UNAVAILABLE');
  assert.deepEqual(readdirSync(join(`${s.root}.forge-client`, 'agent')), ['address.json']);
});

test('the existing stdio CLI accepts explicit hosted addressing and discovers tools without a local owner', async t => {
  const s = agentFixture(t),
    client = new Client({ name: 'hosted-stdio-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve('dist/cli.js'),
      'mcp',
      s.root,
      '--agent',
      '--url',
      s.address.url,
      '--project-id',
      s.address.projectId,
    ],
    stderr: 'pipe',
    env: { ...mcpTestEnvironment(t), FORGE_AUTH_TOKEN: 'synthetic-only' },
  });
  t.after(() => client.close());
  await client.connect(transport, requestOptions('connect'));
  const tools = (await client.listTools(undefined, requestOptions('listTools'))).tools;
  assert.equal(tools.length, 8);
  assert(tools.some(tool => tool.name === 'forge_task'));
  assert(!existsSync(s.root));
  assert(!existsSync(`${s.root}.forge-client`));
});

test('MCP hosted metrics uses eight finite metadata streams, one bill page and its authenticated input transport', async t => {
  const s = agentFixture(t);
  const api = await import(moduleUrl('../convex/projectSelfMetrics.ts'));
  const original = s.exchange.client.query.bind(s.exchange.client);
  let pages = 0;
  const streams = [];
  const { buildComposePages } = await import('../dist/hosted-compose.js');
  const { saveBytes } = await import('../dist/hosted-save.js');
  const input = buildComposePages([]);
  let objectCalls = 0;
  t.mock.method(s.exchange, 'downloadBatch', async pins => {
    objectCalls++;
    assert.deepEqual(pins, [input.manifest.root]);
    return [saveBytes(input.pages[0].value)];
  });
  let billPages = 0;
  t.mock.method(s.exchange.client, 'query', async (ref, args) => {
    if (getFunctionName(ref) === 'projectSelfMetricBills:page') {
      billPages++;
      return JSON.stringify({ page: [], isDone: true, continueCursor: '' });
    }
    if (getFunctionName(ref) === 'projectBytePlacement:convexWritten')
      return { count: 0, bytes: 0, isDone: true, cursor: '' };
    if (getFunctionName(ref) !== 'projectSelfMetrics:page') return original(ref, args);
    checkArgs(api.page, args, 'metrics');
    pages++;
    streams.push(args.stream);
    return JSON.stringify({
      page:
        args.stream === 'acceptances'
          ? [
              {
                id: 'synthetic-move',
                at: '2026-10-29T00:00:00.000Z',
                head: 'synthetic-head',
                submissionId: 'synthetic-request',
                submittedAt: null,
                trusted: false,
                kind: 'landing',
                inputPin: input.manifest.root,
              },
            ]
          : [],
      isDone: true,
      continueCursor: '',
      cutover: '2026-10-28T00:00:00.000Z',
      authority: { mode: 'server', epoch: 1 },
    });
  });
  const tool = registry(t, s).get('forge_work_overview');
  const command = { action: 'metrics', from: '2026-10-28', to: '2026-11-04' };
  const parsed = z.object(tool.inputSchema).parse({ command });
  const response = await tool.call(parsed);
  assert(!response.isError, response.content[0].text);
  const result = body(response);
  assert.equal(result.action, 'metrics');
  assert.equal(result.operationId, null);
  assert.equal(result.result.source.kind, 'hosted');
  assert.equal(pages, 8);
  assert.equal(billPages, 1);
  assert.deepEqual(streams, [
    'acceptances',
    'requests',
    'runs',
    'operations',
    'attempts',
    'lanes',
    'saves',
    'receipts',
  ]);
  assert.equal(objectCalls, 1);
  assert(s.calls.every(call => call.name === 'projectHostedAgent:capabilities'));
  assert(!existsSync(`${s.root}.forge-metrics.jsonl`));
});
