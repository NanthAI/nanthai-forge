// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { runEditHook } from '../dist/agent-edit-hook.js';
import { installEditHooks } from '../dist/agent-install-hooks.js';

const RUNNER = fileURLToPath(new URL('../dist/agent-edit-hook.js', import.meta.url));
// Install and environment cases need only a folder and a Lane id; overlap delivery is
// covered against hosted peers in agent-edit-hosted.test.mjs.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-edit-hook-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return { root, a: { laneId: randomUUID() } };
}
test('hook workers receive the existing minimal environment, without agent credentials', t => {
  const f = fixture(t);
  const name = 'FORGE_SYNTHETIC_HOOK_CREDENTIAL';
  const previous = process.env[name];
  process.env[name] = 'synthetic-test-value';
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
  const worker = join(f.root, 'environment.mjs');
  writeFileSync(worker, `process.stdout.write(JSON.stringify({ leaked: Boolean(process.env.${name}) }))`);
  assert.equal(runEditHook(f.root, f.a.laneId, {}, worker).leaked, false);
});

test('install/uninstall are idempotent and preserve existing Claude and Codex config in temporary HOME', t => {
  const f = fixture(t),
    home = join(f.root, 'fake-home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  const unrelated = { matcher: 'Read', hooks: [{ type: 'command', command: 'existing-hook' }] };
  const original = { theme: 'dark', hooks: { PreToolUse: [unrelated] } };
  for (const path of ['.claude/settings.json', '.codex/hooks.json'])
    writeFileSync(join(home, path), JSON.stringify(original));
  for (let i = 0; i < 2; i++) installEditHooks(f.root, f.a.laneId, false, home, false, { runner: RUNNER });
  for (const path of ['.claude/settings.json', '.codex/hooks.json']) {
    const config = JSON.parse(readFileSync(join(home, path), 'utf8'));
    assert.equal(config.hooks.PreToolUse.length, 2);
    assert.equal(config.hooks.UserPromptSubmit.length, 1);
    assert.ok(
      config.hooks.PreToolUse[1].hooks[0].command.includes(
        fileURLToPath(new URL('../dist/agent-edit-hook.js', import.meta.url)),
      ),
    );
  }
  for (let i = 0; i < 2; i++) installEditHooks(f.root, f.a.laneId, true, home);
  for (const path of ['.claude/settings.json', '.codex/hooks.json'])
    assert.deepEqual(JSON.parse(readFileSync(join(home, path), 'utf8')), original);
});

test('malformed config preserves both clients and unrelated hooks sharing a Forge group survive migration', t => {
  const f = fixture(t),
    home = join(f.root, 'fake-home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  const claude = join(home, '.claude/settings.json'),
    codex = join(home, '.codex/hooks.json');
  const runner = fileURLToPath(new URL('../dist/agent-edit-hook.js', import.meta.url));
  const legacy = [process.execPath, runner, f.root, f.a.laneId].map(s => `'${s}'`).join(' ');
  const other = { type: 'command', command: 'other-hook', custom: 'keep' };
  const original = {
    custom: true,
    hooks: {
      PreToolUse: [{ matcher: 'Write', custom: true, hooks: [{ type: 'command', command: legacy }, other] }],
    },
  };
  writeFileSync(claude, JSON.stringify(original));
  writeFileSync(codex, 'invalid');
  const before = readFileSync(claude, 'utf8');
  assert.throws(() => installEditHooks(f.root, undefined, false, home, false, { runner: RUNNER }));
  assert.equal(readFileSync(claude, 'utf8'), before);
  assert.equal(readFileSync(codex, 'utf8'), 'invalid');
  writeFileSync(codex, '{}');
  installEditHooks(f.root, undefined, false, home, false, { runner: RUNNER });
  const installed = JSON.parse(readFileSync(claude, 'utf8'));
  assert.deepEqual(installed.hooks.PreToolUse[0], { matcher: 'Write', custom: true, hooks: [other] });
  assert.equal(
    installed.hooks.PreToolUse.length,
    2,
    'legacy command replaced by one Lane-independent command',
  );
  assert.match(installed.hooks.PreToolUse[1].hooks[0].command, /--auto/);
  installEditHooks(f.root, undefined, true, home);
  assert.deepEqual(JSON.parse(readFileSync(claude, 'utf8')), {
    ...original,
    hooks: { PreToolUse: [{ matcher: 'Write', custom: true, hooks: [other] }] },
  });
});
