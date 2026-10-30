// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';
import { lowerMcpCommand } from '../dist/mcp-verbs.js';
import { verbModes } from '../dist/agent-verbs.js';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { trustAgents } from './autonomy-fixture.mjs';
import { cleanupOwner } from './owner-cleanup.mjs';
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
  ['save', 'overlap-answer', 'peer-ack', 'peer-ack'],
  ['save', 'overlap-answers', null, 'overlap-acks'],
  ['save', 'handoff', 'handoff', null],
  ['save', 'report', 'report', null],
  ['save', 'friction', 'friction', 'friction'],
  ['save', 'decision', 'decide', 'decide'],
  ['land', 'resume-ready', 'land-ready', null],
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
const modesOf = tools =>
  tools.flatMap(tool =>
    (tool.inputSchema.properties?.command?.anyOf ?? [])
      .filter(option => ['start', 'save', 'land'].includes(option.properties?.action?.const))
      .flatMap(option =>
        (option.properties.mode?.enum ?? []).map(mode => `${option.properties.action.const}/${mode}`),
      ),
  );

async function nativeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-mcp-verbs-'));
  writeFileSync(join(root, 'a.txt'), 'a\n');
  initNative(root);
  trustAgents(root);
  const agent = new AgentWorkflow(root);
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', '0'],
  });
  const connected = await connect(t, server => registerAgentWorkflow(server, root));
  t.after(() => cleanupOwner(root)); // after the server closes
  return { root, agent, ...connected };
}

test('native MCP: save, sync, status pending and land --save equal their old names and print no notices', async t => {
  const { agent, call, client } = await nativeFixture(t);
  const errors = [];
  t.mock.method(process.stderr, 'write', (chunk, ...rest) => {
    errors.push(String(chunk));
    return true;
  });
  const lane = (await call('forge_task', { action: 'start', outcome: 'MCP verbs' })).body.result;
  writeFileSync(join(lane.path, 'a.txt'), 'b\n');
  // Plain save is checkpoint: the same operationId returns the same receipt through either name.
  const saveId = randomUUID();
  const saved = await call('forge_task', {
    action: 'save',
    operationId: saveId,
    laneId: lane.laneId,
    message: 'Verb save',
  });
  assert.equal(saved.isError, undefined);
  assert.deepEqual(
    await call('forge_task', {
      action: 'checkpoint',
      operationId: saveId,
      laneId: lane.laneId,
      message: 'Verb save',
    }),
    saved,
  );
  const syncId = randomUUID();
  const synced = await call('forge_task', {
    action: 'save',
    mode: 'sync',
    operationId: syncId,
    laneId: lane.laneId,
  });
  // A fresh Lane has no accepted main to sync with; both spellings must return the same answer.
  assert.deepEqual(
    await call('forge_task', { action: 'sync', operationId: syncId, laneId: lane.laneId }),
    synced,
  );
  // status {pending:true} is pending-status.
  const pending = await call('forge_work_overview', { action: 'status', pending: true, limit: 1 });
  assert.equal(pending.isError, undefined, JSON.stringify(pending.body));
  const oldPending = await call('forge_work_overview', { action: 'pending-status', limit: 1 });
  const unclocked = value => JSON.parse(JSON.stringify(value).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T')); // reads stamp the clock
  assert.deepEqual(unclocked(oldPending), unclocked(pending));
  // land --save lands like finish {accept:true}; the old name replays the same journal.
  const landId = randomUUID();
  const landed = await call('forge_task', {
    action: 'land',
    mode: 'save',
    operationId: landId,
    laneId: lane.laneId,
    message: 'Verb land',
  });
  assert.equal(landed.isError, undefined, JSON.stringify(landed.body));
  assert.equal(landed.body.result.status, 'accepted');
  const resumed = await call('forge_task', { action: 'land', mode: 'save', operationId: landId });
  const { resolved, ...original } = landed.body.result; // only the first reply returns its filled pins
  assert.ok(resolved);
  assert.deepEqual(resumed.body.result, original);
  assert.equal(
    (await call('forge_task', { action: 'land', mode: 'save', checkOnly: true, operationId: landId })).body
      .error.code,
    'BAD_ARGUMENT',
  );
  assert.deepEqual(
    (
      await call('forge_task', {
        action: 'finish',
        operationId: landId,
        laneId: lane.laneId,
        message: 'Verb land',
        accept: true,
      })
    ).body.result,
    landed.body.result,
  );
  // check-only checks without landing.
  const second = (await agent.dispatch({ action: 'start', outcome: 'Check only' })).result;
  writeFileSync(join(second.path, 'a.txt'), 'c\n');
  const checked = await call('forge_task', {
    action: 'land',
    mode: 'save',
    checkOnly: true,
    laneId: second.laneId,
    message: 'No landing',
  });
  assert.equal(checked.isError, undefined, JSON.stringify(checked.body));
  assert.notEqual(checked.body.result.status, 'accepted');
  for (const bad of [
    { action: 'land', mode: 'save', laneId: second.laneId, accept: false },
    { action: 'land', mode: 'save', checkOnly: true, accept: true, laneId: second.laneId },
  ])
    assert.equal((await call('forge_task', bad)).body.error.code, 'BAD_ARGUMENT');
  // Mode lists are schema-checked at the tool boundary.
  const tools = (await client.listTools()).tools;
  assert.ok(modesOf(tools).includes('land/save'));
  assert.equal(
    errors.some(line => line.startsWith('Alias:')),
    false,
  );
});

test('MCP accepts exactly the CLI mode forms (drift check), natively and hosted', async t => {
  const native = await nativeFixture(t),
    s = agentFixture(t),
    hosted = await connect(t, server => registerAgentWorkflow(server, s.root, s.transport()));
  const accepted = new Set([
    ...modesOf((await native.client.listTools()).tools),
    ...modesOf((await hosted.client.listTools()).tools),
  ]);
  const cliForms = Object.entries(verbModes).flatMap(([verb, modes]) =>
    Object.keys(modes).map(flag => `${verb}/${flag.slice(2)}`),
  );
  // integrate (save --preview) is a CLI-only dry run with no agent dispatch action.
  assert.deepEqual([...accepted].sort(), cliForms.filter(form => form !== 'save/preview').sort());
  const nativeForms = new Set(modesOf((await native.client.listTools()).tools));
  for (const form of ['start/open', 'save/overlap-answers']) assert.equal(nativeForms.has(form), false);
  const hostedForms = new Set(modesOf((await hosted.client.listTools()).tools));
  for (const form of ['save/handoff', 'save/report', 'land/resume-ready'])
    assert.equal(hostedForms.has(form), false);
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
    ['forge_task', { action: 'save', mode: 'overlap-answer' }, 'peer-ack', lane],
    ['forge_task', { action: 'save', mode: 'overlap-answers' }, 'overlap-acks', lane],
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
