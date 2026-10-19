// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { callTool, mcpTestEnvironment, requestOptions } from './mcp-runtime.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initNative } from '../dist/native-work.js';
import { pluginConfig } from '../dist/plugin-config.js';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'forge-plugin-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'source with spaces'),
    directory = join(base, 'local plugins');
  mkdirSync(root);
  writeFileSync(join(root, 'answer.ts'), 'export const answer = 1;\n');
  initNative(root);
  return { base, root, directory };
}
test('generated plugin connects the selected owner and completes a real recorded check', async t => {
  const { base, root, directory } = fixture(t);
  const generated = spawnSync(process.execPath, [resolve('dist/cli.js'), 'plugin-config', root, directory], {
    encoding: 'utf8',
    env: { ...process.env, FORGE_AUTH_TOKEN: 'synthetic-must-not-be-copied' },
  });
  assert.equal(generated.status, 0, generated.stderr);
  const receipt = JSON.parse(generated.stdout);
  assert.equal(receipt.installed, false);
  const plugin = receipt.plugin,
    raw = readFileSync(join(plugin, '.mcp.json'), 'utf8');
  assert.ok(!raw.includes('synthetic-must-not-be-copied'));
  const manifest = JSON.parse(readFileSync(join(plugin, '.codex-plugin/plugin.json')));
  assert.equal(manifest.mcpServers, './.mcp.json');
  const catalog = JSON.parse(readFileSync(join(directory, '.agents/plugins/marketplace.json')));
  assert.equal(resolve(directory, catalog.plugins[0].source.path), plugin);
  const config = JSON.parse(raw).mcpServers.forge;
  assert.equal(config.command, process.execPath);
  assert.deepEqual(config.env_vars, ['FORGE_AUTH_TOKEN']);
  const skill = readFileSync(join(plugin, 'skills/forge-agent/SKILL.md'), 'utf8');
  const doc = skill.match(/\[source exchange\]\(([^)]+)\)/)[1];
  assert.ok(readFileSync(new URL(doc)).length > 0);
  const client = new Client({ name: 'plugin-proof', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: config.command,
      args: config.args,
      stderr: 'pipe',
      env: mcpTestEnvironment(t),
    }),
    requestOptions('connect'),
  );
  t.after(() => client.close());
  const tools = (await client.listTools(undefined, requestOptions('listTools'))).tools.map(tool => tool.name);
  for (const name of ['forge_task', 'forge_check', 'forge_review', 'forge_work_overview', 'forge_source'])
    assert.ok(tools.includes(name));
  assert.ok(!tools.includes('forge_hosted_work'));
  assert.ok(!tools.includes('forge_exchange'));
  const call = async (name, command) => {
    const result = await callTool(client, { name, arguments: { command } });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text).result;
  };
  const lane = await call('forge_task', {
    action: 'start',
    operationId: randomUUID(),
    outcome: 'Plugin changes answer',
  });
  writeFileSync(join(lane.path, 'answer.ts'), 'export const answer = 2;\n');
  const check = await call('forge_check', {
    action: 'define-check',
    name: 'Plugin answer check',
    executable: process.execPath,
    args: ['-e', "if(!require('fs').readFileSync('answer.ts','utf8').includes('= 2;'))process.exit(1)"],
  });
  const request = {
    action: 'finish',
    operationId: randomUUID(),
    laneId: lane.laneId,
    expectedHead: lane.head,
    message: 'Answer two',
    checkId: check.checkId,
    expectedDefinition: check.definition,
  };
  const finished = await call('forge_task', request);
  assert.equal(finished.complete, true);
  assert.deepEqual(await call('forge_task', request), finished);
  assert.equal(readFileSync(join(root, 'answer.ts'), 'utf8'), 'export const answer = 1;\n');
});
test('plugin retries preserve identical files and refuse to overwrite changed files or follow links', t => {
  const { base, root, directory } = fixture(t);
  assert.equal(pluginConfig(root, directory).reused, false);
  assert.equal(pluginConfig(root, directory).reused, true);
  const readme = join(directory, 'README.md');
  writeFileSync(readme, 'User changes');
  assert.throws(
    () => pluginConfig(root, directory),
    error => error.code === 'PLUGIN_CONFIG_CHANGED',
  );
  assert.equal(readFileSync(readme, 'utf8'), 'User changes');
  const alias = join(base, 'alias');
  symlinkSync(directory, alias);
  assert.throws(
    () => pluginConfig(root, alias),
    error => error.code === 'PLUGIN_CONFIG_CHANGED',
  );
  rmSync(readme);
  symlinkSync(join(root, 'answer.ts'), readme);
  assert.throws(
    () => pluginConfig(root, directory),
    error => error.code === 'PLUGIN_CONFIG_CHANGED',
  );
  assert.equal(readFileSync(join(root, 'answer.ts'), 'utf8'), 'export const answer = 1;\n');
});
