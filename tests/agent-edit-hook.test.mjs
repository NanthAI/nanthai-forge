// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentWorkflow } from './agent-advisory-fixture.mjs';
import { initNative } from '../dist/native-work.js';
import { runEditHook } from '../dist/agent-edit-hook.js';
import { installEditHooks } from '../dist/agent-install-hooks.js';
import { readAgentTurn, readEditContext } from '../dist/agent-edit-context.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-edit-hook-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'shared.txt'), 'Original\n');
  initNative(root);
  const agent = new AgentWorkflow(root);
  const a = (await agent.dispatch({ action: 'start', outcome: 'Hook fixture' })).result;
  const b = (await agent.dispatch({ action: 'start', outcome: 'Peer', scope: { paths: ['shared.txt'] } }))
    .result;
  return { root, agent, a, b };
}
test('Claude Edit, Write, MultiEdit, NotebookEdit and Codex patch hooks deny overlaps before writing', async t => {
  const f = await fixture(t);
  for (const [tool_name, tool_input] of [
    ['Edit', { file_path: join(f.a.path, 'shared.txt') }],
    ['Write', { file_path: join(f.a.path, 'shared.txt') }],
    ['MultiEdit', { edits: [{ file_path: join(f.a.path, 'shared.txt'), edits: [] }] }],
    ['NotebookEdit', { notebook_path: join(f.a.path, 'shared.txt') }],
    [
      'apply_patch',
      { command: '*** Begin Patch\n*** Update File: shared.txt\n@@\n-Original\n+Edited\n*** End Patch' },
    ],
  ]) {
    const result = runEditHook(f.root, f.a.laneId, {
      tool_name,
      tool_input,
      cwd: f.a.path,
      session_id: `synthetic-${tool_name}`,
      turn_id: 'turn-42',
      tool_use_id: 'call-42',
    });
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny', JSON.stringify(result));
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /peer-ack/);
    assert.equal(readFileSync(join(f.a.path, 'shared.txt'), 'utf8'), 'Original\n');
  }
  const context = readAgentTurn(f.agent.work.store.directory, f.a.laneId);
  assert.equal(context.sessionId, 'synthetic-apply_patch');
  assert.equal(context.turnId, 'turn-42');
  assert.equal(context.agent, 'codex');
});

test('Claude prompt boundaries use opaque local turn references without reading transcripts', async t => {
  const f = await fixture(t);
  runEditHook(f.root, f.a.laneId, {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'claude-session',
    prompt: 'PRIVATE PROMPT MUST NOT BE STORED',
    transcript_path: '/not/read/by/forge',
  });
  const first = readAgentTurn(f.agent.work.store.directory, f.a.laneId);
  runEditHook(f.root, f.a.laneId, {
    hook_event_name: 'PreToolUse',
    session_id: 'claude-session',
    tool_name: 'Write',
    tool_input: { file_path: join(f.a.path, 'other.txt') },
  });
  assert.deepEqual(readEditContext(f.agent.work.store.directory, f.a.laneId), first);
  runEditHook(f.root, f.a.laneId, { hook_event_name: 'UserPromptSubmit', session_id: 'claude-session' });
  const next = readAgentTurn(f.agent.work.store.directory, f.a.laneId);
  assert.notEqual(first.turnId, next.turnId);
  assert.deepEqual(
    readEditContext(f.agent.work.store.directory, f.a.laneId),
    first,
    'a prompt without an edit must not relabel saved bytes',
  );
  assert.equal(JSON.stringify(next).includes('PRIVATE'), false);
});

test('unreachable, slow and malformed Forge responses fail open with recorded events', async t => {
  const f = await fixture(t);
  const absent = join(f.root, 'absent-owner');
  const missing = runEditHook(absent, f.a.laneId, {});
  assert.equal(missing.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(existsSync(absent), false, 'fail-open must not recreate a missing owner');
  for (const [name, source, reason] of [
    ['slow', 'setInterval(() => {}, 1000)', 'timeout'],
    ['broken', 'process.exit(1)', 'unreachable'],
    ['malformed', 'process.stdout.write("not-json")', 'unreachable'],
  ]) {
    const worker = join(f.root, `${name}.mjs`);
    writeFileSync(worker, source);
    const start = performance.now();
    const result = runEditHook(f.root, f.a.laneId, {}, worker);
    assert.equal(result.hookSpecificOutput.permissionDecision, undefined);
    assert.ok(performance.now() - start < 1600);
    const events = readFileSync(join(f.agent.work.store.directory, 'edit-hook', 'fail-open.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(events.at(-1).reason, reason);
  }
});

test('hook workers receive the existing minimal environment, without agent credentials', async t => {
  const f = await fixture(t);
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

test('install/uninstall are idempotent and preserve existing Claude and Codex config in temporary HOME', async t => {
  const f = await fixture(t),
    home = join(f.root, 'fake-home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  const unrelated = { matcher: 'Read', hooks: [{ type: 'command', command: 'existing-hook' }] };
  const original = { theme: 'dark', hooks: { PreToolUse: [unrelated] } };
  for (const path of ['.claude/settings.json', '.codex/hooks.json'])
    writeFileSync(join(home, path), JSON.stringify(original));
  for (let i = 0; i < 2; i++) installEditHooks(f.root, f.a.laneId, false, home);
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
