// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { callTool, mcpTestEnvironment, requestOptions } from './mcp-runtime.mjs';
import { initNative } from '../dist/native-work.js';

test('MCP captures, triages and reads friction through the same owner Work', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-friction-mcp-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'file.txt'), 'original\n');
  initNative(root);
  const client = new Client({ name: 'friction-test', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/cli.js'), 'mcp', root, '--agent'],
      stderr: 'pipe',
      env: mcpTestEnvironment(t),
    }),
    requestOptions('connect'),
  );
  t.after(() => client.close());
  const call = async (name, command) => {
    const response = await callTool(client, { name, arguments: { command } });
    assert.ok(!response.isError, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  };
  const captured = await call('forge_task', {
    action: 'friction',
    title: 'Manual script needed',
    detail: 'Had to reconstruct a receipt',
    area: 'workflow',
  });
  assert.equal(captured.result.kind, 'capture');
  const list = await call('forge_work_overview', { action: 'improve' });
  assert.deepEqual(list.result.groups[0].frictionIds, [captured.result.id]);
  await call('forge_task', {
    action: 'friction-triage',
    frictionIds: [captured.result.id],
    status: 'planned',
    reason: 'Build the receipt command',
  });
  assert.equal((await call('forge_work_overview', { action: 'improve' })).result.groups[0].status, 'planned');
  const invalid = await callTool(client, {
    name: 'forge_task',
    arguments: {
      command: {
        action: 'friction-triage',
        frictionIds: [captured.result.id],
        status: 'fixed',
        reason: 'Missing fixing Lane',
      },
    },
  });
  assert.equal(invalid.isError, true);
  assert.equal(JSON.parse(invalid.content[0].text).error.code, 'BAD_ARGUMENT');
});
