// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import { callTool, mcpTestEnvironment, requestOptions } from './mcp-runtime.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const cli = resolve('dist/cli.js');
function native(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-agent-interface-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.ts'), 'export const answer = 1;\n');
  command('init-native', root);
  command('set-policy', root, JSON.stringify({ operationId: randomUUID(), preset: 'trusted' }));
  return root;
}
function invoke(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}
function command(...args) {
  const result = invoke(...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
test('agent CLI completes and replays native delivery without indexing or SDK glue', t => {
  const root = native(t),
    startId = randomUUID();
  const agent = (action, input = {}) => command('agent', root, action, JSON.stringify(input));
  const start = agent('start', { operationId: startId, outcome: 'Change answer' }).result;
  assert.equal(
    agent('start', { operationId: startId, outcome: 'Change answer' }).result.laneId,
    start.laneId,
  );
  writeFileSync(join(start.path, 'a.ts'), 'export const answer = 2;\n');
  const cp = agent('checkpoint', {
    operationId: randomUUID(),
    laneId: start.laneId,
    expectedHead: start.head,
    message: 'Answer two',
  }).result;
  const view = agent('compose', {
    operationId: randomUUID(),
    intentId: start.intentId,
    inputs: [{ laneId: start.laneId, head: cp.head }],
  }).result;
  const check = agent('define-check', {
    name: 'Actual check',
    executable: process.execPath,
    args: [
      '-e',
      "const fs=require('fs');if(!fs.readFileSync('a.ts','utf8').includes('= 2;'))process.exit(1);console.log('verified')",
    ],
  }).result;
  const runRequest = {
    operationId: randomUUID(),
    viewId: view.viewId,
    expectedHead: view.head,
    checkId: check.checkId,
  };
  const run = agent('run', runRequest).result;
  assert.equal(run.status, 'passed');
  assert.equal(run.checkDefinition, check.definition);
  assert.deepEqual(agent('run', runRequest).result, run);
  const accepted = agent('accept', {
    operationId: randomUUID(),
    viewId: view.viewId,
    expectedHead: view.head,
    expectedPrevious: null,
  }).result;
  assert.equal(accepted.head, cp.head);
  assert.equal(accepted.status, 'accepted');
  assert.match(agent('log', { operationId: run.operationId }).result.text, /verified/);
  const raw = JSON.parse(readWorkBytes(join(root, '.forge/work/work.json')));
  assert.equal(raw.schema, 12); // checkpoint actor, autonomy and recorded completion
  assert.equal(raw.lanes[0].checkpoints[0].actor.kind, 'agent');
  assert.equal(raw.runs.length, 1);
  const before = readWorkBytes(join(root, '.forge/work/work.json'));
  const invalid = invoke(
    'agent',
    root,
    'start',
    JSON.stringify({ action: 'accept', operationId: randomUUID() }),
  );
  assert.notEqual(invalid.status, 0);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'BAD_ARGUMENT');
  assert.deepEqual(readWorkBytes(join(root, '.forge/work/work.json')), before);
  const parameters = join(root, '.forge', 'agent-command.json');
  writeFileSync(parameters, JSON.stringify({ intentId: start.intentId, limit: 1 }));
  const overview = command('agent', root, 'status', '--command-file', parameters).result;
  assert.equal(overview.lanes.total, 1);
  assert.equal(overview.lanes.items[0].laneId, start.laneId);
});
test('agent MCP profile awaits graph readiness, preserves selectors and legacy tool discovery', async t => {
  const root = native(t);
  const connect = async flag => {
    const client = new Client({ name: 'agent-interface-test', version: '1' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, 'mcp', root, flag],
        stderr: 'pipe',
        env: mcpTestEnvironment(t),
      }),
      requestOptions('connect'),
    );
    t.after(() => client.close());
    return client;
  };
  const client = await connect('--agent'),
    tools = (await client.listTools(undefined, requestOptions('listTools'))).tools;
  assert.equal(tools.length, 16);
  assert.ok(!tools.some(tool => tool.name === 'forge_work_command'));
  for (const name of [
    'forge_task',
    'forge_check',
    'forge_work_overview',
    'forge_review',
    'forge_queue',
    'forge_wait',
  ])
    assert.ok(tools.some(tool => tool.name === name));
  const call = async (name, arguments_) => {
    const result = await callTool(client, { name, arguments: arguments_ });
    return { isError: result.isError, body: JSON.parse(result.content[0].text) };
  };
  const queue = await call('forge_queue', { action: 'list' });
  assert.ok(!queue.isError);
  assert.ok(Array.isArray(queue.body));
  assert.equal((await call('forge_queue', { action: 'cancel' })).body.error.code, 'BAD_ARGUMENT');
  const initial = await call('forge_context', { search: 'answer' });
  assert.ok(!initial.isError);
  assert.ok(initial.body.total > 0);
  writeFileSync(join(root, 'a.ts'), 'export const replacement = 3;\n');
  const refreshed = await call('forge_context', { search: 'replacement' });
  assert.ok(!refreshed.isError);
  assert.ok(refreshed.body.total > 0);
  assert.notEqual(refreshed.body.sourceId, initial.body.sourceId);
  const started = await call('forge_task', {
    command: { action: 'start', operationId: randomUUID(), outcome: 'MCP Lane' },
  });
  assert.ok(!started.isError);
  const lane = started.body.result;
  const reviewTool = tools.find(tool => tool.name === 'forge_review');
  assert.equal(reviewTool.annotations.readOnlyHint, true);
  assert.equal(reviewTool.annotations.idempotentHint, true);
  const diff = await call('forge_review', { command: { action: 'diff', laneId: lane.laneId } });
  assert.ok(!diff.isError);
  assert.equal(diff.body.result.head, lane.head);
  const stateDiff = await call('forge_review', {
    command: { action: 'diff', from: lane.head, to: lane.head },
  });
  assert.ok(!stateDiff.isError);
  assert.equal(stateDiff.body.result.total, 0);
  const shown = await call('forge_review', { command: { action: 'show', state: lane.head, path: 'a.ts' } });
  assert.ok(!shown.isError);
  assert.equal(shown.body.result.content, 'export const answer = 1;\n');
  assert.equal(shown.body.result.encoding, 'utf8');
  assert.equal(shown.body.result.state, lane.head);
  const missingFile = await call('forge_review', {
    command: { action: 'show', laneId: lane.laneId, path: 'missing' },
  });
  assert.equal(missingFile.isError, true);
  assert.equal(missingFile.body.error.code, 'NOT_FOUND');
  const selectedTests = await call('forge_check', { command: { action: 'tests', laneId: lane.laneId } });
  assert.ok(!selectedTests.isError);
  assert.equal(selectedTests.body.result.head, lane.head);
  assert.ok(Array.isArray(selectedTests.body.result.tests));
  const unknownTests = await call('forge_check', { command: { action: 'tests', laneId: randomUUID() } });
  assert.equal(unknownTests.isError, true);
  assert.equal(unknownTests.body.error.code, 'NOT_FOUND');
  const beforeLink = readWorkBytes(join(root, '.forge/work/work.json'));
  const linkRequest = { command: { action: 'link', laneId: lane.laneId, path: 'a.ts', line: 1 } };
  const link = await call('forge_work_overview', linkRequest);
  assert.ok(!link.isError);
  assert.equal(link.body.result.head, lane.head);
  assert.deepEqual(await call('forge_work_overview', linkRequest), link);
  assert.deepEqual(readWorkBytes(join(root, '.forge/work/work.json')), beforeLink);
  const briefing = await call('forge_brief', {
    situation: 'continue-lane',
    laneId: lane.laneId,
    agent: 'codex',
  });
  assert.ok(!briefing.isError);
  assert.equal(briefing.body.context.laneId, lane.laneId);
  assert.match(briefing.body.copyText, /First run:/);
  const missingBrief = await call('forge_brief', { situation: 'continue-lane', laneId: randomUUID() });
  assert.equal(missingBrief.isError, true);
  assert.equal(missingBrief.body.error.code, 'NOT_FOUND');
  const selected = await call('forge_source', { laneId: lane.laneId, file: 'a.ts', start: 1, end: 1 });
  assert.ok(!selected.isError);
  assert.equal(selected.body.sourceContext.laneId, lane.laneId);
  assert.match(selected.body.results[0].text, /answer = 1/);
  const foreign = await call('forge_source', { laneId: randomUUID(), file: 'a.ts' });
  assert.equal(foreign.isError, true);
  assert.equal(foreign.body.error.code, 'NOT_FOUND');
  const legacy = await connect('--work'),
    oldTools = (await legacy.listTools(undefined, requestOptions('listTools'))).tools;
  assert.equal(oldTools.length, 10);
  assert.ok(oldTools.some(tool => tool.name === 'forge_work_command'));
  const config = command('mcp-config', root, '--agent');
  assert.equal(config.mcpServers.forge.args.at(-1), '--agent');
});

test('legacy Work help is discoverable without opening a source owner', () => {
  for (const args of [
    ['work', '--help'],
    ['work', '/unavailable/forge-help-only', '--help'],
  ]) {
    const result = invoke(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /COMMAND_JSON EXPECTED_REVISION/);
    assert.match(result.stdout, /nforge agent/);
  }
});
