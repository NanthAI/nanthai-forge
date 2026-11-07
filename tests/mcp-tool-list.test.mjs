// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';
import { agentFixture } from './hosted-agent-fixture.mjs';

// Issue 47558a99: the advertised tool list is per-session context. Budgets are in characters of the
// tools/list JSON; tokens are about chars / 4. Raise one only with before/after numbers on the Issue.
const LIST_CHARS = 6_050; // 1.5k tokens, the Issue target. 2026-11-06: ~5,950 (was 11,725, before that 54,565). 2026-11-07: land --save gained allowEmpty (a930de4c): list 5,882 -> 5,895, Codex form ~5,998 -> 6,011
const DESCRIPTION_CHARS = 1_400; // 2026-11-06: ~1,150 of the 6,000 (was 2,259, then 3,955)
const body = response => JSON.parse(response.content[0].text);
// The listing names fields in a description ("Fields: a b:n c=x|y ...") and required fields per action.
function listing(tool) {
  const text = (tool.inputSchema.properties.command ?? tool.inputSchema).description;
  const fields = new Set(
    /Fields: (.*?) \(:b bool/
      .exec(text)[1]
      .split(' ')
      .map(token => token.replace(/[:=(].*$/, '')),
  );
  const required = /Required: (.*?)\. Fields:/.exec(text)?.[1] ?? '';
  return { fields, required: required.split(/[ (),/:|]+/) };
}

async function connect(t) {
  const s = agentFixture(t),
    server = new McpServer({ name: 'nanthai-forge', version: 'test' }),
    close = registerAgentWorkflow(server, s.root, s.transport()),
    client = new Client({ name: 'test', version: '1' }),
    [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    close();
    await client.close();
    await server.close();
  });
  const help = async topic =>
    body(
      await client.callTool({
        name: 'forge_work_overview',
        arguments: { command: topic === undefined ? { action: 'help' } : { action: 'help', topic } },
      }),
    );
  return { s, client, help };
}

test('the hosted tool list stays inside its context budget', async t => {
  const { client } = await connect(t);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 8);
  const chars = JSON.stringify(tools).length;
  const descriptions = tools.reduce((n, tool) => n + tool.description.length, 0);
  t.diagnostic(`tools/list ${chars} chars (~${Math.ceil(chars / 4)} tokens); descriptions ${descriptions}`);
  assert(chars <= LIST_CHARS, `tool list characters: ${chars}`);
  // Codex sends each tool as a function definition under a server-prefixed name: same budget.
  const codex = JSON.stringify(
    tools.map(tool => ({
      type: 'function',
      name: `mcp__nanthai-forge__${tool.name}`,
      description: tool.description,
      parameters: tool.inputSchema,
    })),
  ).length;
  assert(codex <= LIST_CHARS, `Codex function definitions: ${codex}`);
  assert(descriptions <= DESCRIPTION_CHARS, `description characters: ${descriptions}`);
});

test('every action stays reachable: listed, with its exact schema and fields behind help', async t => {
  const { client, help } = await connect(t);
  const tools = (await client.listTools()).tools;
  const index = await help();
  assert.deepEqual(index.topics.map(topic => topic.tool).sort(), tools.map(tool => tool.name).sort());
  let actions = 0;
  for (const tool of tools) {
    const command = tool.inputSchema.properties.command;
    if (!command) continue;
    for (const action of command.properties.action.enum) {
      actions++;
      const detail = await help(action);
      assert(detail.variants?.length, `${tool.name} ${action} has no help`);
      // The verb forms (start, save, land) exist on more than one tool: judge each variant on its own tool.
      for (const { tool: owner, schema } of detail.variants) {
        const listed = listing(tools.find(candidate => candidate.name === owner));
        for (const key of Object.keys(schema.properties))
          if (key !== 'action' && key !== 'mode')
            assert(listed.fields.has(key), `${owner} ${action} field ${key} is not listed`);
        for (const mode of schema.properties.mode?.enum ?? [])
          assert(listed.required.includes(mode), `${owner} ${action} mode ${mode} is not listed`);
        for (const key of schema.required ?? [])
          if (key !== 'action' && key !== 'mode')
            assert(listed.required.includes(key), `${owner} ${action} required ${key} is not listed`);
      }
    }
  }
  assert(actions >= 40, `listed actions: ${actions}`);
});

test('long tool prose and the project rules moved to help, not lost', async t => {
  const { help } = await connect(t);
  const task = await help('forge_task');
  assert.match(task.description, /Finish always requests agent acceptance/);
  assert.match(task.description, /Pinned Lanes skip/);
  assert.match(task.description, /Project rules:/);
  assert((await help('forge_wait')).description.includes('progressToken'));
  assert.equal((await help('no-such-topic')).error.code, 'BAD_ARGUMENT');
});

test('the compact listing changes nothing about validation', async t => {
  const { s, client } = await connect(t);
  for (const command of [
    { action: 'ack', laneId: s.lane.laneId, unknownField: true },
    { action: 'finish', laneId: s.lane.laneId, agent: false },
    { action: 'help', topic: 'x'.repeat(65) },
  ])
    assert.equal(
      (await client.callTool({ name: 'forge_task', arguments: { command } })).isError,
      true,
      JSON.stringify(command),
    );
  assert.equal(s.calls.length, 0, 'invalid commands reach no remote function');
});
