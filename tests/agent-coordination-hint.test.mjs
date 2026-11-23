// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Issue c6615b66: Forge teaches coordination itself. Each agent client's first write to a file another
// Lane is changing shows the claim and one coordination line; nothing else ever carries that line.
import { testDeploymentOrigin } from './trusted-origin.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runEditHook } from '../dist/agent-edit-hook.js';
import { antigravityHook } from '../dist/agent-antigravity-hook.js';
import { hostedEditContext } from '../dist/agent-edit-hosted.js';
import { rememberBoardServerFeatures } from '../dist/board-local.js';
import {
  COORDINATE_HINT,
  FIRST_START_TIP,
  coordinateField,
  firstStartTip,
} from '../dist/member-data-notice.js';
import { hostedEditServer, hostedMarker } from './hosted-edit-fixture.mjs';

const CLAIM = /^Claim on shared\.txt: @?thevarsek\/peer \(Lane 11111111\) is editing it/m;

async function hosted(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-coordinate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = await hostedEditServer();
  t.after(() => server.close());
  const saved = Object.fromEntries(
    ['FORGE_AUTH_TOKEN', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'].map(name => [name, process.env[name]]),
  );
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  process.env.FORGE_AUTH_TOKEN = 'synthetic-only';
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.XDG_STATE_HOME = join(root, 'state');
  testDeploymentOrigin(server.url);
  const lane = join(root, 'lane');
  hostedMarker(lane, server.url);
  rememberBoardServerFeatures('synthetic-project', ['agent-board']);
  return { root, lane, server };
}
const hook = data => runEditHook('--auto', '', data);

test('the coordination line is one short line: under 200 bytes, named commands for CLI and MCP', () => {
  assert.ok(Buffer.byteLength(COORDINATE_HINT) < 200, `${Buffer.byteLength(COORDINATE_HINT)} bytes`);
  assert.equal(COORDINATE_HINT.includes('\n'), false);
  for (const name of ['peers', 'stackOn', 'ask', 'forge_review', 'forge_task'])
    assert.ok(COORDINATE_HINT.includes(name), name);
});

test('Claude Code: a first Write to a file another Lane is changing shows the claim and the coordination line', async t => {
  const f = await hosted(t);
  const write = file => ({
    cwd: f.root,
    session_id: 'claude-session',
    tool_name: 'Write',
    tool_input: { file_path: join(f.lane, file) },
  });
  const context = hook(write('shared.txt')).hookSpecificOutput.additionalContext;
  assert.match(context, CLAIM);
  assert.equal(context.split('\n').filter(line => line === COORDINATE_HINT).length, 1);
  assert.deepEqual(hook(write('different.txt')), {}, 'no overlap: no line');
});

test('Codex: a first apply_patch touching a file another Lane is changing shows the claim and the line once', async t => {
  const f = await hosted(t);
  const output = hook({
    cwd: f.lane,
    session_id: 'codex-thread',
    tool_name: 'apply_patch',
    tool_input: { patch: '*** Update File: shared.txt\n*** Add File: different.txt' },
  });
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, CLAIM);
  assert.equal(context.split('\n').filter(line => line === COORDINATE_HINT).length, 1);
});

test('Antigravity: the write check runs after the write and its notice reaches the next model call once', async t => {
  const f = await hosted(t);
  const post = (name, args, conversationId = 'agy-conversation') => ({
    hookEventName: 'PostToolUse',
    conversationId,
    cwd: f.lane,
    toolCall: { id: 'call-1', name, args },
  });
  const invoke = (conversationId = 'agy-conversation') => ({
    hookEventName: 'PreInvocation',
    conversationId,
  });
  // Nothing pending yet: the reply Antigravity accepts for "no change".
  assert.deepEqual(await antigravityHook(invoke()), {});
  // PostToolUse always answers {} (any other field fails the tool in Antigravity).
  assert.deepEqual(
    await antigravityHook(post('write_file', { Path: join(f.lane, 'shared.txt'), Content: 'x' })),
    {},
  );
  const injected = await antigravityHook(invoke());
  const text = injected.injectSteps[0].systemMessage.systemMessage;
  assert.match(text, CLAIM);
  assert.ok(text.includes(COORDINATE_HINT));
  assert.deepEqual(await antigravityHook(invoke()), {}, 'delivered once');
  // An edit_file on a file nobody else changes, and a non-write tool, leave nothing to inject.
  await antigravityHook(
    post('edit_file', { Path: join(f.lane, 'different.txt'), Target: 'a', Replacement: 'b' }),
  );
  await antigravityHook(post('run_command', { CommandLine: 'cat shared.txt' }));
  assert.deepEqual(await antigravityHook(invoke()), {});
  // Another conversation does not receive this one's notice.
  await antigravityHook(post('write_file', { Path: join(f.lane, 'shared.txt') }, 'other-conversation'));
  assert.deepEqual(await antigravityHook(invoke()), {});
  assert.ok((await antigravityHook(invoke('other-conversation'))).injectSteps);
});

test('Antigravity entry: malformed or unknown input still gets an accepted reply on stdout', t => {
  const state = mkdtempSync(join(tmpdir(), 'forge-agy-state-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const run = input =>
    spawnSync(process.execPath, [new URL('../dist/agent-antigravity-hook.js', import.meta.url).pathname], {
      input,
      encoding: 'utf8',
      env: { ...process.env, XDG_STATE_HOME: state },
    });
  for (const input of ['not json', 'null', '7', '{}', JSON.stringify({ hookEventName: 'Stop' })]) {
    const result = run(input);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  }
});

test('the line shows only beside an overlap: board notes alone carry no coordination line', () => {
  const notesOnly = hostedEditContext({
    status: 'allowed',
    coverage: 'hosted',
    checked: 1,
    board: { claims: [], notices: ['Note from @peer: synthetic'] },
  });
  assert.ok(notesOnly.length > 0);
  assert.equal(notesOnly.includes(COORDINATE_HINT), false);
  assert.equal(hostedEditContext({ status: 'allowed', coverage: 'hosted', checked: 1 }), '');
});

test('CLI and MCP receipts carry the line only when another Lane shares a path', () => {
  const peer = { items: [{ with: 'lane-2' }] };
  const mainOnly = { items: [{ with: 'main' }] };
  const lanes = why => ({ lanes: [{ why }] });
  assert.deepEqual(coordinateField(peer), { coordinate: COORDINATE_HINT });
  assert.deepEqual(coordinateField(undefined, lanes(['issue', 'paths'])), { coordinate: COORDINATE_HINT });
  assert.deepEqual(coordinateField(mainOnly), {}, 'a main-only conflict names no Lane');
  assert.deepEqual(coordinateField(undefined, lanes(['issue'])), {}, 'same Issue, no shared file');
  assert.deepEqual(coordinateField(undefined, lanes(['goal'])), {}, 'similar goal, no shared file');
  assert.deepEqual(coordinateField(), {});
});

test('first-start tip: shown once per machine, then never; test receipts never carry it', t => {
  const state = mkdtempSync(join(tmpdir(), 'forge-tip-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  assert.equal(firstStartTip(), undefined, 'receipts under test never show the tip');
  const marker = join(state, 'forge', 'coordination-tip.json');
  assert.equal(firstStartTip(marker), FIRST_START_TIP);
  assert.ok(FIRST_START_TIP.includes(COORDINATE_HINT));
  assert.equal(firstStartTip(marker), undefined);
  assert.deepEqual(readdirSync(join(state, 'forge')), ['coordination-tip.json']);
});
