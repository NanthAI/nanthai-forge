// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { SHOW_MAX_BYTES } from '../dist/agent-source-read.js';
import { fixture as gitFixture, git, code } from './helpers.mjs';

function fixture(t, native) {
  const root = native ? mkdtempSync(join(tmpdir(), 'forge-source-read-')) : gitFixture(t);
  if (native) t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.txt'), '\ufeffone\r\nlast');
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'colon:name.txt'), 'nested');
  writeFileSync(join(root, 'empty.txt'), '');
  writeFileSync(join(root, 'binary.dat'), Buffer.from([0, 255, 1]));
  writeFileSync(join(root, 'invalid.dat'), Buffer.from([255, 254]));
  writeFileSync(join(root, 'large.txt'), 'x'.repeat(SHOW_MAX_BYTES + 1));
  writeFileSync(join(root, 'huge.txt'), 'h'.repeat(4 * 1024 * 1024 + 1));
  symlinkSync('a.txt', join(root, 'link'));
  if (native) initNative(root);
  else {
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'Synthetic source']);
  }
  const agent = new AgentWorkflow(root);
  return { root, agent, act: (action, input = {}) => agent.dispatch({ action, ...input }) };
}

test('source-read actions validate selectors, full digests and contained paths', async t => {
  const f = fixture(t, true),
    lane = (await f.act('start', { outcome: 'Invalid selectors' })).result;
  for (const input of [
    { action: 'diff' },
    { action: 'diff', from: lane.head },
    { action: 'diff', from: 'abcd', to: lane.head },
    { action: 'diff', laneId: lane.laneId, from: lane.head, to: lane.head },
    { action: 'diff', laneId: lane.laneId, paths: ['../outside'] },
    { action: 'show', path: 'a.txt' },
    { action: 'show', laneId: lane.laneId, state: lane.head, path: 'a.txt' },
    { action: 'show', state: 'main', path: 'a.txt' },
    { action: 'show', channel: 'main', state: lane.head, path: 'a.txt' },
    { action: 'show', channel: 'main', laneId: lane.laneId, path: 'a.txt' },
    ...['../outside', '/absolute', 'nested/../a.txt', 'nested\\a.txt'].map(path => ({
      action: 'show',
      state: lane.head,
      path,
    })),
  ])
    await assert.rejects(f.agent.dispatch(input), code('BAD_ARGUMENT'));
  const missing = '00000000-0000-4000-8000-000000000000';
  await assert.rejects(f.act('diff', { laneId: missing }), code('NOT_FOUND'));
  await assert.rejects(f.act('show', { laneId: missing, path: 'a.txt' }), code('NOT_FOUND'));
  await assert.rejects(
    f.act('show', { state: '0'.repeat(64), path: 'a.txt' }),
    code('INVALID_NATIVE_SOURCE'),
  );
});

test('diff and show action help works without opening an owner', () => {
  for (const action of ['diff', 'show']) {
    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'agent', '/unavailable/owner', action, '--help'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /laneId/);
    assert.match(result.stdout, action === 'show' ? /path, force\?/ : /byteBudget/);
  }
});
