// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandUsage, USAGE_COMMAND_MAX_BYTES } from '../dist/auto-exchange-usage-command.js';
import { observeSpend, SPEND_WINDOW_MS } from '../dist/auto-exchange-spend.js';
const context = { projectId: 'synthetic', deployment: 'https://synthetic.invalid' };
function script(t, body) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-fake-usage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const command = join(directory, 'usage command');
  writeFileSync(command, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return command;
}

test('command receives binding arguments and private directories, without inherited Forge secrets', async t => {
  // Synthetic env name only; never inspect real credential values.
  process.env.FORGE_SYNTHETIC_USAGE_SECRET = 'synthetic-secret';
  t.after(() => delete process.env.FORGE_SYNTHETIC_USAGE_SECRET);
  const command = script(
    t,
    `
    const fs = require('node:fs');
    if (process.env.FORGE_SYNTHETIC_USAGE_SECRET) process.exit(2);
    if (Object.keys(process.env).some(key => /FORGE|CONVEX|TOKEN|KEY/.test(key))) process.exit(3);
    for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
      if (!fs.realpathSync(process.env[key]).startsWith(fs.realpathSync(process.cwd()) + '/')) process.exit(4);
      if (!fs.statSync(process.env[key]).isDirectory()) process.exit(5);
    }
    console.log(JSON.stringify({projectId:process.argv[2], deployment:process.argv[3], directory:process.cwd()}));
  `,
  );
  const value = await commandUsage(command)(context);
  assert.equal(value.projectId, context.projectId);
  assert.equal(value.deployment, context.deployment);
  assert.equal(existsSync(value.directory), false);
});

test('unconfigured, relative, missing, failing, malformed and excessive output commands are unavailable', async t => {
  assert.equal(await commandUsage(undefined)(context), undefined);
  await assert.rejects(commandUsage('relative')(context));
  for (const command of [
    '/synthetic/missing-command',
    script(t, 'console.error("synthetic-provider-secret"); process.exit(1);'),
    script(t, 'console.log("garbage");'),
    script(t, `process.stdout.write('x'.repeat(${USAGE_COMMAND_MAX_BYTES + 1}));`),
    script(t, `process.stderr.write('x'.repeat(${USAGE_COMMAND_MAX_BYTES + 1}));`),
  ]) {
    const state = await observeSpend(context, [], Date.now(), commandUsage(command));
    assert.equal(state.spend.reason, 'unavailable');
    assert.doesNotMatch(JSON.stringify(state), /synthetic-provider-secret/);
  }
});

test('command timeout is unavailable even if a descendant holds stdout open', async t => {
  const command = script(
    t,
    `
    require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'});
    process.exit(0);
  `,
  );
  const state = await observeSpend(context, [], Date.now(), commandUsage(command));
  assert.equal(state.spend.reason, 'unavailable');
});

test('command JSON is validated for project, measurement kind and age', async t => {
  const now = Date.now();
  const base = {
    kind: 'measured',
    scope: 'team',
    subject: 'synthetic-team',
    ...context,
    observedAt: now,
    totalUsd: 10,
  };
  for (const [patch, reason] of [
    [{}, 'within-window'],
    [{ projectId: 'other' }, 'unavailable'],
    [{ deployment: 'https://other.invalid' }, 'unavailable'],
    [{ kind: 'estimated' }, 'unavailable'],
    [{ observedAt: now - SPEND_WINDOW_MS }, 'stale'],
  ]) {
    const command = script(t, `console.log(${JSON.stringify(JSON.stringify({ ...base, ...patch }))});`);
    const state = await observeSpend(context, [], now, commandUsage(command));
    assert.equal(state.spend.reason, reason);
  }
});

test('fresh command timestamps are checked after the asynchronous command returns', async t => {
  const command = script(
    t,
    `console.log(JSON.stringify({kind:'measured',scope:'team',subject:'team',projectId:process.argv[2],deployment:process.argv[3],observedAt:Date.now(),totalUsd:1}));`,
  );
  const state = await observeSpend(context, [], Date.now, commandUsage(command));
  assert.equal(state.spend.reason, 'within-window');
});
