// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';
import { lowerMcpCommand } from '../dist/mcp-verbs.js';
import { verbModes } from '../dist/agent-verbs.js';

import { agentFixture } from './hosted-agent-fixture.mjs';

/**
 * V2a part 2 MCP rows: [verb, mode, native wire action, hosted wire action | null when hosted has none].
 * Same table as the CLI mapping in agent-verbs.test.mjs, written out so a drift in either shows here.
 */
const rows = [
  ['start', 'open', null, 'open'],
  ['start', 'reopen', 'reopen', 'reopen'],
  ['save', undefined, 'checkpoint', 'save'],
  ['save', 'sync', 'sync', 'sync'],
  ['save', 'candidate', 'compose', 'compose'],
  ['save', 'check', 'run', 'check'],
  ['save', 'contract', 'confirm-tests', 'confirm-tests'],
  // Hosted overlap answers are gone (Issue 853fcde3); native pre-edit notices keep peer-ack for now.
  ['save', 'overlap-answer', 'peer-ack', null],
  ['save', 'friction', 'friction', 'friction'],
  ['save', 'decision', 'decide', 'decide'],
  ['land', 'withdraw', null, 'withdraw'],
];

test('lowering: every start/save/land form maps to its existing wire action and keeps fields', () => {
  for (const [verb, mode, native, hosted] of rows) {
    const command = { action: verb, ...(mode ? { mode } : {}), laneId: 'L', message: 'm' };
    for (const [wire, isHosted] of [
      [native, false],
      [hosted, true],
    ]) {
      if (wire === null) continue;
      assert.deepEqual(lowerMcpCommand(command, isHosted), { laneId: 'L', message: 'm', action: wire });
    }
  }
  // land --save: native requests acceptance, hosted finish already submits; check-only never accepts.
  const save = { action: 'land', mode: 'save', laneId: 'L' };
  assert.deepEqual(lowerMcpCommand(save, false), { laneId: 'L', accept: true, action: 'finish' });
  assert.deepEqual(lowerMcpCommand(save, true), { laneId: 'L', action: 'finish' });
  assert.deepEqual(lowerMcpCommand({ ...save, checkOnly: true }, false), { laneId: 'L', action: 'finish' });
  assert.deepEqual(lowerMcpCommand({ ...save, checkOnly: true }, true), {
    laneId: 'L',
    accept: false,
    action: 'finish',
  });
  assert.deepEqual(lowerMcpCommand({ ...save, accept: { channel: 'main' } }, false), {
    laneId: 'L',
    accept: { channel: 'main' },
    action: 'finish',
  });
  // Old action names pass through untouched.
  for (const old of [
    { action: 'finish', laneId: 'L' },
    { action: 'start', outcome: 'o' },
    { action: 'land' },
  ])
    assert.equal(lowerMcpCommand(old, false), old);
});

test('lowering refuses ambiguous land --save requests instead of reinterpreting them', () => {
  const save = { action: 'land', mode: 'save', laneId: 'L' };
  for (const command of [
    { ...save, accept: false },
    { ...save, checkOnly: true, accept: true },
    { action: 'land', checkOnly: true },
    { action: 'save', mode: 'nope' },
    { action: 'start', mode: 'sync' },
    { action: 'save', mode: 'sync', checkOnly: true },
  ])
    for (const hosted of [false, true])
      assert.throws(
        () => lowerMcpCommand(command, hosted),
        { code: 'BAD_ARGUMENT' },
        JSON.stringify(command),
      );
  assert.throws(
    () =>
      lowerMcpCommand(
        { action: 'land', mode: 'save', checkOnly: true, operationId: randomUUID() },
        false,
        () => ({
          accept: true,
          action: 'finish',
        }),
      ),
    {
      code: 'BAD_ARGUMENT',
    },
  );
});

test('lowering resumes a retained native finish without injecting accept', () => {
  const operationId = randomUUID();
  const retained = { action: 'finish', laneId: 'L', message: 'm', accept: true };
  assert.deepEqual(
    lowerMcpCommand({ action: 'land', mode: 'save', operationId }, false, () => retained),
    {
      ...retained,
      operationId,
    },
  );
  const retainedCheck = { action: 'finish', laneId: 'L', message: 'm' };
  assert.deepEqual(
    lowerMcpCommand({ action: 'land', mode: 'save', operationId }, false, () => retainedCheck),
    {
      ...retainedCheck,
      operationId,
    },
  );
  assert.deepEqual(
    lowerMcpCommand(
      { action: 'land', mode: 'save', checkOnly: true, operationId },
      false,
      () => retainedCheck,
    ),
    { ...retainedCheck, operationId },
  );
});

async function connect(t, register) {
  const server = new McpServer({ name: 'nanthai-forge', version: 'test' });
  const close = register(server);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await close();
    await client.close();
    await server.close();
  });
  const call = async (name, command) => {
    const result = await client.callTool({ name, arguments: { command } });
    assert.equal(result.content.length, 1, 'MCP results carry one envelope, never a notice');
    return { isError: result.isError, body: JSON.parse(result.content[0].text) };
  };
  return { client, call };
}
// Native listings carry one schema variant per form; the hosted listing is compact and names each
// form in the command's per-action signature ("save:sync|candidate(laneId)").
const modesOf = tools =>
  tools.flatMap(tool => {
    const command = tool.inputSchema.properties?.command;
    const variants = (command?.anyOf ?? [])
      .filter(option => ['start', 'save', 'land'].includes(option.properties?.action?.const))
      .flatMap(option =>
        (option.properties.mode?.enum ?? []).map(mode => `${option.properties.action.const}/${mode}`),
      );
    const signed = [
      ...(command?.description ?? '').matchAll(/\b(start|save|land):([a-z|-]+)(?=[( ])/g),
    ].flatMap(([, verb, modes]) => modes.split('|').map(mode => `${verb}/${mode}`));
    return [...variants, ...signed];
  });

test('MCP accepts exactly the CLI mode forms (drift check)', async t => {
  // One client mode (Issue 657d63ee): the hosted MCP is the only agent MCP, so its forms equal the CLI's.
  const s = agentFixture(t),
    hosted = await connect(t, server => registerAgentWorkflow(server, s.root, s.transport()));
  const cliForms = Object.entries(verbModes).flatMap(([verb, modes]) =>
    Object.keys(modes).map(flag => `${verb}/${flag.slice(2)}`),
  );
  // save --overlap-answer is native-only since Issue 853fcde3: hosted MCP no longer offers it.
  assert.deepEqual(
    [...new Set(modesOf((await hosted.client.listTools()).tools))].sort(),
    cliForms.filter(form => form !== 'save/overlap-answer').sort(),
  );
});

test('hosted MCP: each new form reaches the transport exactly like its old action, one dispatch each', async t => {
  const s = agentFixture(t);
  const transport = s.transport();
  const dispatched = [];
  t.mock.method(transport, 'dispatch', async (action, body) => {
    dispatched.push({ action, body: structuredClone(body) });
    return { recorded: true };
  });
  const tools = new Map();
  const close = registerAgentWorkflow(
    { registerTool: (name, config, handler) => tools.set(name, { ...config, handler }) },
    s.root,
    transport,
  );
  t.after(close);
  const lane = { laneId: s.lane.laneId, operationId: randomUUID() };
  const hostedRows = [
    // [tool, new form, old action, extra fields]
    ['forge_task', { action: 'start', mode: 'open' }, 'open', lane],
    ['forge_task', { action: 'start', mode: 'reopen' }, 'reopen', lane],
    ['forge_task', { action: 'save', mode: 'sync' }, 'sync', { ...lane, apply: false }],
    ['forge_task', { action: 'save', mode: 'candidate' }, 'compose', lane],
    ['forge_task', { action: 'save', mode: 'friction' }, 'friction', lane],
    ['forge_task', { action: 'save', mode: 'decision' }, 'decide', lane],
    ['forge_task', { action: 'land', mode: 'save' }, 'finish', lane],
    ['forge_check', { action: 'save', mode: 'check' }, 'check', lane],
    ['forge_check', { action: 'save', mode: 'contract' }, 'confirm-tests', lane],
  ];
  for (const [tool, form, old, fields] of hostedRows) {
    const entry = tools.get(tool);
    const parsed = z.object(entry.inputSchema).parse({ command: { ...form, ...fields } });
    dispatched.length = 0;
    const response = await entry.handler(parsed, {});
    assert(!response.isError, response.content[0].text);
    assert.equal(dispatched.length, 1, `${form.action}/${form.mode} dispatches once`);
    const viaNew = dispatched[0];
    dispatched.length = 0;
    await entry.handler({ command: { action: old, ...fields } }, {});
    assert.deepEqual(viaNew, dispatched[0], `${form.action}/${form.mode} equals ${old}`);
    assert.equal(response.content.length, 1);
  }
  // Plain save keeps its strict hosted schema; check-only adds accept:false like hosted finish {accept:false}.
  dispatched.length = 0;
  const task = tools.get('forge_task');
  await task.handler({ command: { action: 'land', mode: 'save', checkOnly: true, ...lane } }, {});
  await task.handler({ command: { action: 'finish', accept: false, ...lane } }, {});
  assert.deepEqual(dispatched[0], dispatched[1]);
  assert.equal(dispatched[0].body.accept, false);
  dispatched.length = 0;
  const refused = await task.handler(
    { command: { action: 'land', mode: 'save', accept: false, ...lane } },
    {},
  );
  assert.equal(refused.isError, true);
  assert.equal(JSON.parse(refused.content[0].text).error.code, 'BAD_ARGUMENT');
  assert.equal(dispatched.length, 0);
  // Hosted status stays strict: it has no pending read and rejects unknown fields.
  assert.throws(() =>
    z
      .object(tools.get('forge_work_overview').inputSchema)
      .parse({ command: { action: 'status', pending: true, bogus: 1 } }),
  );
});
