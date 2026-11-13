// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_CLIENTS, nearestAgentProcess, resolveAgentSession } from '../dist/agent-session.js';
import { agentSlug, sessionAgentSlug } from '../dist/agent-slug-session.js';

const row = (ppid, command, started = 'session-start') => ({ ppid, command, started });
const tree = rows => pid => rows[pid];
const identify = (env, rows, from = 30) => resolveAgentSession(env, nearestAgentProcess(tree(rows), from));

for (const client of AGENT_CLIENTS.filter(row => row.harness !== 'other')) {
  test(`${client.harness}: concurrent sibling processes have distinct runs, stable across Lane commands`, () => {
    const env = { CLAUDE_CODE_SESSION_ID: 'outer-claude', CODEX_THREAD_ID: 'outer-codex' };
    const executable = client.executables[0];
    const session = n =>
      identify(
        { ...env, ...(client.sessionVariable ? { [client.sessionVariable]: `own-${n}` } : {}) },
        { 30: row(20 + n, '/bin/sh'), [20 + n]: row(10, `/tools/${executable}`), 10: row(1, '/tools/t3') },
      );
    const [a, b] = [session(1), session(2)];
    assert.ok(a && b);
    assert.notEqual(a.key, b.key);
    assert.deepEqual(a, session(1));
    assert.deepEqual(b, session(2));
    assert.equal(a.harness, client.harness);
    if (client.sessionVariable) assert.equal(a.key, 'own-1', 'closest client owns the declaration');
    else assert.match(a.key, /^process:[a-f0-9]{64}$/);
    assert.notEqual(agentSlug(a.key), agentSlug(b.key));
    assert.ok(!a.key.includes('/tools/'));
  });
}

test('nesting both ways and through a parent-environment relay selects the closest agent', () => {
  const env = {
    CLAUDE_CODE_SESSION_ID: 'claude-own',
    CODEX_THREAD_ID: 'codex-own',
    PI_SESSION_ID: 'pi-own',
    T3CODE_THREAD_ID: 'outer-t3',
  };
  for (const [child, parent, expected] of [
    ['codex', 'claude', 'codex-own'],
    ['claude', 'codex', 'claude-own'],
    ['pi', 'codex', 'pi-own'],
  ]) {
    const rows = {
      30: row(25, '/bin/sh'),
      25: row(20, '/tools/node'),
      20: row(10, `/tools/${child}`),
      10: row(5, `/tools/${parent}`),
      5: row(1, '/tools/T3'),
    };
    assert.equal(identify(env, rows).key, expected);
  }
});

test('an unknown recognisable agent without its own variable never inherits its parent session', () => {
  const env = { CLAUDE_CODE_SESSION_ID: 'outer-session' };
  const first = {
    30: row(20, '/bin/zsh'),
    20: row(10, '/tools/custom-coding-agent'),
    10: row(1, '/tools/claude'),
  };
  const a = identify(env, first);
  const b = identify(env, { ...first, 20: row(10, '/tools/custom-coding-agent', 'new-process-start') });
  assert.match(a.key, /^process:[a-f0-9]{64}$/);
  assert.notEqual(a.key, env.CLAUDE_CODE_SESSION_ID);
  assert.notEqual(a.key, b.key, 'reused pid is a new agent session');
  assert.deepEqual(a, identify(env, first));
});

test('explicit session wins over ambient clients and MCP; human override and plain shells stay people', () => {
  const ancestor = { harness: 'codex', sessionVariable: 'CODEX_THREAD_ID', pid: 20, started: 'start' };
  const ambient = { CLAUDE_CODE_SESSION_ID: 'parent', CODEX_THREAD_ID: 'child' };
  const a = { ...ambient, FORGE_AGENT_SESSION: 'lead-proof-a' };
  const b = { ...ambient, FORGE_AGENT_SESSION: 'lead-proof-b' };
  assert.equal(resolveAgentSession(a, ancestor).key, 'lead-proof-a');
  assert.equal(resolveAgentSession(b, ancestor).key, 'lead-proof-b');
  assert.equal(sessionAgentSlug('mcp:ambient', a), agentSlug('lead-proof-a'));
  assert.notEqual(sessionAgentSlug(undefined, a), sessionAgentSlug(undefined, b));
  assert.equal(resolveAgentSession({ ...a, FORGE_HUMAN: '1' }, ancestor), undefined);
  assert.equal(identify({}, { 30: row(10, '/bin/zsh'), 10: row(1, '/tools/Terminal') }), undefined);
});

test('unreadable ancestry does not choose a parent from a fixed variable precedence', () => {
  const a = resolveAgentSession(
    { CLAUDE_CODE_SESSION_ID: 'shared-parent', CODEX_THREAD_ID: 'child-a' },
    null,
  );
  const b = resolveAgentSession(
    { CLAUDE_CODE_SESSION_ID: 'shared-parent', CODEX_THREAD_ID: 'child-b' },
    null,
  );
  assert.match(a.key, /^sessions:[a-f0-9]{64}$/);
  assert.notEqual(a.key, b.key);
  assert.equal(
    nearestAgentProcess(() => undefined, 30),
    null,
  );
  const loop = tree({ 30: row(20, 'sh'), 20: row(30, 'node') });
  assert.equal(nearestAgentProcess(loop, 30), null);
});
