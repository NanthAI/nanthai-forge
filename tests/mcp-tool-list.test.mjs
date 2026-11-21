// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';
import { AGENT_DEFAULTS, effectiveAgentDefaults } from '../dist/agent-parallel-defaults.js';
import { agentFixture } from './hosted-agent-fixture.mjs';

// Issue 47558a99: the advertised tool list is per-session context. Budgets are in characters of the
// tools/list JSON; tokens are about chars / 4. Raise one only with before/after numbers on the Issue.
const LIST_CHARS = 5_758; // 657d63ee: measured pre-parity tools/list, including array punctuation.
const CLAUDE_CHARS = 5_746;
const CODEX_CHARS = 5_874; // Same baseline as server-prefixed Codex function definitions.
const DESCRIPTION_CHARS = 920;
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
  assert.match(tools.find(tool => tool.name === 'forge_task').description, /model or FORGE_AGENT_MODEL/);
  const chars = JSON.stringify(tools).length;
  const listBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
  const descriptions = tools.reduce((n, tool) => n + tool.description.length, 0);
  const descriptionBytes = tools.reduce((n, tool) => n + Buffer.byteLength(tool.description, 'utf8'), 0);
  t.diagnostic(`MCP UTF-8 bytes: tools/list ${listBytes}, descriptions ${descriptionBytes}`);
  // Byte weight is enforced once, on the installed tools/list in package smoke (92dbde9d).
  // 675 -> 666 (d3357f40): forge_planning says Items and is 9 bytes shorter, paying for the one `fields` token.
  // 666 -> 632 (9a3d6f5f): forge_planning drops its status:all hint (the field line lists it, help explains it),
  // paying for the `replyTo decision:b` comment tokens.
  // 632 -> 590 (76e3ae31): concise existing summaries pay for explicit holder/session fields.
  // 590 -> 588 (58478c0b): Find/edit pays for the transfer field without growing tools/list bytes.
  // P10: shorter source prose pays for history selectors in the same listing budget.
  // 527 -> 524 (17ea21ac): forge_review says 'History, blame, changes.', paying for diff's new `from` field.
  // 524 -> 490 (f0d0fdd6): forge_work_overview says 'Lanes, records, status, metrics, board.', paying for the
  // lanes action and its fields (MCP lanes names id/intentId/view; view is a checked string, so its values stay in help).
  // 490 -> 472 (a61d3c91): forge_task drops 'Help: forge_task.' (every listing already ends 'forge_work_overview help'),
  // paying for land's optional `tokens:n` field.
  // 472 -> 463 (ad80e037): forge_check says 'read runs and logs' (help names retained logs), paying with the
  // shorter name for land's new `maxChecks:n` field (tools/list 5712 -> 5715, under its 5723 ceiling).
  // 463 -> 442: shorter forge_task description fits notVerified:a into the same tool list ceiling.
  // 442 -> 423 (e7812d8f): forge_task drops the repeated wait hint to fit the undo action.
  assert.equal(descriptionBytes, 423, 'the per-session MCP description bytes match the recorded budget');
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
  t.diagnostic(`Codex definitions ${codex} chars`);
  assert(codex <= CODEX_CHARS, `Codex function definitions: ${codex}`);
  const claude = JSON.stringify(
    tools.map(tool => ({
      name: `mcp__nanthai-forge__${tool.name}`,
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
  ).length;
  t.diagnostic(`Claude definitions ${claude} chars`);
  assert(claude <= CLAUDE_CHARS, `Claude tool definitions: ${claude}`);
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

test('the live project settings remove and restore each configurable rule in forge_task help', async t => {
  const { s, client, help } = await connect(t);
  const taskDescription = async () => (await help('forge_task')).description;
  const refresh = async agentDefaults => {
    s.caps.agentDefaults = agentDefaults;
    const start = s.calls.length;
    const reply = await client.callTool({
      name: 'forge_work_overview',
      arguments: { command: { action: 'capabilities' } },
    });
    assert.ok(!reply.isError, JSON.stringify(reply.content));
    const description = await taskDescription();
    assert.deepEqual(
      s.calls.slice(start).map(call => call.name),
      ['projectHostedAgent:capabilities'],
    );
    return description;
  };

  for (const [setting, off, sentence] of [
    ['affected-test preflight', { preflight: 'off' }, /land --save runs required preflight|Affected tests:/],
    ['save reminders', { checkpointNudgeMinutes: 0 }, /save after each meaningful step/i],
    ['agent urgent priority', { urgentRoles: ['owner', 'agents'] }, /never request urgent priority/i],
    ['stall alerts', { stallAlerts: { enabled: false } }, /LANDING_STALLED receipt names its repair command/],
  ]) {
    await t.test(setting, async () => {
      assert.match(await taskDescription(), sentence);
      assert.doesNotMatch(await refresh(effectiveAgentDefaults(off)), sentence);
      assert.match(await refresh(AGENT_DEFAULTS), sentence);
    });
  }
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
