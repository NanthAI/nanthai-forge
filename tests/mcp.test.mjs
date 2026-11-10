// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { callTool, mcpTestEnvironment, requestOptions } from './mcp-runtime.mjs';
import assert from 'node:assert/strict';
import { realpathSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { doctor, diagnosticRuntime, mcpConfig } from '../dist/setup.js';
import { fixture, write, git } from './helpers.mjs';

test('real stdio MCP discovery, refresh, queries, mutations, validation and shutdown', async t => {
  const root = fixture(t, {
    '.gitignore': '.forge/\n',
    'a.ts': 'export const value = 1;',
    'b.ts': 'import { value } from "./a"; export const answer = value;',
  });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/cli.js'), 'mcp', root],
    env: mcpTestEnvironment(t),
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => {
    stderr += chunk;
  });
  const client = new Client({ name: 'forge-protocol-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
  });
  await client.connect(transport, requestOptions('connect'));
  const { tools } = await client.listTools(undefined, requestOptions('listTools'));
  assert.equal(tools.length, 8);
  assert.equal(tools.find(tool => tool.name === 'forge_reindex').annotations.readOnlyHint, false);
  const call = async (name, args = {}) => {
    const result = await callTool(client, { name, arguments: args });
    return { result, body: JSON.parse(result.content[0].text) };
  };
  assert.equal((await call('forge_current')).body.error.code, 'INDEX_MISSING');
  // Two TypeScript files plus the .gitignore text file's file-level entry.
  assert.equal((await call('forge_reindex')).body.files, 3);
  const original = (await call('forge_current')).body;
  assert.equal(original.freshness, 'current');
  const inspected = (await call('forge_inspect', { symbol: 'value' })).body;
  assert.equal(inspected.results[0].locator.file, 'a.ts');
  assert.ok((await call('forge_references', { symbol: inspected.results[0].id })).body.total > 0);
  assert.equal((await call('forge_trace', { file: 'b.ts' })).body.results[0].target, 'a.ts');
  assert.equal((await call('forge_impact', { file: 'a.ts' })).body.results[0].from, 'b.ts');
  assert.equal(
    (await call('forge_source', { file: 'a.ts' })).body.results[0].text,
    'export const value = 1;',
  );
  const invalid = await callTool(client, { name: 'forge_context', arguments: { limit: 0 } });
  assert.equal(invalid.isError, true);
  assert.equal((await call('forge_source', { file: '../private.ts' })).result.isError, true);
  write(root, 'a.ts', 'export const changed = 2;');
  assert.equal((await call('forge_context')).body.error.code, 'SOURCE_STALE');
  await call('forge_reindex');
  assert.equal((await call('forge_inspect', { symbol: 'value' })).body.total, 0);
  renameSync(join(root, 'a.ts'), join(root, 'renamed.ts'));
  await call('forge_reindex');
  assert.equal(
    (await call('forge_inspect', { symbol: 'changed' })).body.results[0].locator.file,
    'renamed.ts',
  );
  unlinkSync(join(root, 'renamed.ts'));
  await call('forge_reindex');
  assert.equal((await call('forge_inspect', { symbol: 'changed' })).body.total, 0);
  git(root, ['restore', 'a.ts']);
  git(root, ['checkout', '-qb', 'other']);
  git(root, ['commit', '--allow-empty', '-qm', 'new head']);
  assert.equal((await call('forge_current')).body.freshness, 'stale');
  await call('forge_reindex');
  assert.notEqual((await call('forge_current')).body.gitHead, original.gitHead);
  await client.close();
  assert.equal(stderr, '');
});

test('doctor and emitted MCP configuration preserve existing client settings', async t => {
  const root = fixture(t, { 'a.ts': 'export const a = 1;' });
  assert.equal((await doctor(root)).ready, false);
  const config = mcpConfig(root);
  assert.equal(config.mcpServers.forge.command, process.execPath);
  assert.deepEqual(config.mcpServers.forge.args.slice(1), ['mcp', realpathSync(root)]);
  assert.ok(config.mcpServers.forge.args[0].endsWith('/dist/cli-entry.js'));
});

test('doctor exposes the finite filesystem environment result and an exact diagnostic next step', async t => {
  const root = fixture(t, { 'a.ts': 'export const a = 1;' });
  const health = {
    ok: false,
    latencyMs: null,
    fseventsdRssMb: 4000,
    fseventsdCpuPercent: 99,
    reason: 'no filesystem event within 1000 ms',
    attempts: [],
  };
  t.mock.method(diagnosticRuntime, 'filesystemEventHealth', directory => {
    assert.equal(directory, root);
    return health;
  });
  const result = await doctor(root);
  assert.equal(result.filesystemEvents.status, 'environment');
  assert.equal(result.filesystemEvents.category, 'ENVIRONMENT');
  assert.equal(result.filesystemEvents.code, 'FILESYSTEM_EVENTS_UNHEALTHY');
  assert.match(result.filesystemEvents.message, /fseventsd.*sudo killall fseventsd/);
  assert.equal(result.filesystemEvents.next, `nforge doctor '${root}'`);
  assert.deepEqual(result.filesystemEvents.health, health);
});
