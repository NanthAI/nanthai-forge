// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { callTool, mcpTestEnvironment, requestOptions } from './mcp-runtime.mjs';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { decisionRecords } from '../dist/decisions.js';

test('CLI and MCP create and replay the same native decision records with attribution', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-decisions-mcp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'file.txt'), 'synthetic\n');
  initNative(root);
  const cli = resolve('dist/cli.js');
  const env = { ...mcpTestEnvironment(t), FORGE_AGENT_NAME: 'Synthetic requester' };
  const command = {
    action: 'decide',
    operationId: randomUUID(),
    target: { kind: 'project' },
    decidedBy: 'Owner',
    what: 'Retain declared decisions',
    why: 'Next agent needs their overrides',
    actor: 'Synthetic builder',
    tool: 'fixture',
    overrides: { kind: 'default', description: 'Decisions in a private handoff' },
  };
  const invoke = (action, input) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, 'agent', root, action, JSON.stringify(input)], {
        env,
        encoding: 'utf8',
      }),
    );
  const created = invoke('decide', command).result;
  const client = new Client({ name: 'decisions-test', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'mcp', root, '--agent'],
      stderr: 'pipe',
      env,
    }),
    requestOptions('connect'),
  );
  t.after(() => client.close());
  const call = async (name, input) => {
    const response = await callTool(client, { name, arguments: { command: input } });
    assert.ok(!response.isError, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  };
  assert.deepEqual((await call('forge_task', command)).result, created);
  const replacementCommand = {
    ...command,
    operationId: randomUUID(),
    what: 'Publish decisions in briefs',
    supersedes: created.id,
  };
  const replacement = (await call('forge_task', replacementCommand)).result;
  assert.deepEqual(invoke('decide', replacementCommand).result, replacement);
  assert.deepEqual(replacement.actor, { kind: 'agent', name: 'Synthetic builder', tool: 'fixture' });
  assert.equal(replacement.requester.name, 'Synthetic requester');
  const mcpList = await call('forge_work_overview', { action: 'decisions' });
  assert.deepEqual(invoke('decisions', {}).result, mcpList.result);
  assert.deepEqual(mcpList.result.decisions[0].supersededBy, [replacement.id]);
  assert.equal(decisionRecords(new WorkStore(root)).length, 2);
  const invalid = await callTool(client, {
    name: 'forge_task',
    arguments: { command: { ...command, operationId: randomUUID(), supersedes: randomUUID() } },
  });
  assert.equal(invalid.isError, true);
  assert.equal(JSON.parse(invalid.content[0].text).error.code, 'NOT_FOUND');
});
