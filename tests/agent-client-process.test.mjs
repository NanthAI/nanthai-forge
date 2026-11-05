// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { agentClientProcess } from '../dist/agent-client-process.js';

const tree = rows => pid => rows[pid];
const row = (ppid, command, started = 'Thu Nov  5 10:00:00 2026') => ({ ppid, command, started });

test('the client is the nearest ancestor that is not a shell or launcher', () => {
  const read = tree({
    300: row(200, '/bin/zsh'),
    200: row(150, '/bin/sh'),
    150: row(100, '/usr/local/bin/claude'),
    100: row(1, '/Applications/Host.app/Host'),
  });
  assert.equal(agentClientProcess(read, 300), '150@Thu Nov  5 10:00:00 2026');
  assert.equal(agentClientProcess(read, 150), '150@Thu Nov  5 10:00:00 2026');
});

test('two client processes with one session id differ; a reused pid with a new start time differs', () => {
  const a = agentClientProcess(tree({ 10: row(2, '/bin/bash'), 2: row(1, 'claude') }), 10);
  const b = agentClientProcess(tree({ 11: row(3, '/bin/bash'), 3: row(1, 'claude') }), 11);
  const reused = agentClientProcess(
    tree({ 10: row(2, '/bin/bash'), 2: row(1, 'claude', 'Thu Nov  5 12:00:00 2026') }),
    10,
  );
  assert.notEqual(a, b);
  assert.notEqual(a, reused);
  assert.equal(a, agentClientProcess(tree({ 12: row(2, '/bin/bash'), 2: row(1, 'claude') }), 12));
});

test('an unreadable or all-wrapper ancestry gives no client process', () => {
  assert.equal(
    agentClientProcess(() => undefined, 10),
    undefined,
  );
  assert.equal(agentClientProcess(tree({ 10: row(1, '/bin/sh') }), 10), undefined);
  const loop = tree({ 10: row(11, 'bash'), 11: row(10, 'bash') });
  assert.equal(agentClientProcess(loop, 10), undefined, 'bounded walk');
});

test('real processes: separate clients sharing a session id differ; one client is stable across shells', () => {
  const module = new URL('../dist/agent-client-process.js', import.meta.url).href;
  // A subagent-like client: a node process whose shells (sh -c) run the probe, as a client tool does.
  const client = `
    import { spawnSync } from 'node:child_process';
    const probe = "node --input-type=module -e \\"import('${module}').then(m => console.log(m.agentClientProcess()))\\"";
    for (let i = 0; i < 2; i++) console.log(spawnSync('sh', ['-c', probe], { encoding: 'utf8' }).stdout.trim());
  `;
  const run = () =>
    spawnSync(process.execPath, ['--input-type=module', '-e', client], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'shared-session' },
    })
      .stdout.trim()
      .split('\n');
  const [a1, a2] = run(),
    [b1, b2] = run();
  assert.match(a1, /^\d+@/);
  assert.equal(a1, a2, 'a retry from another shell of the same client process');
  assert.equal(b1, b2);
  assert.notEqual(a1, b1, 'a different client process sharing the session id');
});
