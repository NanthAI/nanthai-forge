// SPDX-License-Identifier: Apache-2.0
import { cleanupOwner } from './owner-cleanup.mjs';
import test from 'node:test';

import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { spawnSync } from 'node:child_process';

import { initNative } from '../dist/native-work.js';
import { pluginConfig } from '../dist/plugin-config.js';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'forge-plugin-'));
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await cleanupOwner(root);
    await cleanupOwner(base);
  });
  const root = join(base, 'source with spaces'),
    directory = join(base, 'local plugins');
  mkdirSync(root);
  writeFileSync(join(root, 'answer.ts'), 'export const answer = 1;\n');
  initNative(root);
  return { base, root, directory, clients };
}
test('generated plugin selects the checkout, copies no token and links installed docs from its skill', t => {
  const { root, directory } = fixture(t);
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
  const doc = skill.match(/\[hosted parity\]\(([^)]+)\)/)[1];
  assert.ok(doc.startsWith('file:'), doc);
  assert.ok(readFileSync(new URL(doc)).length > 0);
  assert.doesNotMatch(skill, /\]\(\.\.\/\.\.\/docs\//, 'every docs link points at the installed package');
  assert.deepEqual(
    config.args.slice(1),
    ['mcp', realpathSync(root), '--agent'],
    'agent MCP for the selected checkout',
  );
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
