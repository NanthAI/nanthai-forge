// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { shellQuote } from '../dist/agent-brief-render.js';
import { withSourceRecovery } from '../dist/hosted-agent-source-recovery.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('native heavy preserves whitespace, quotes and multiline arguments without shell splitting', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-heavy-argv-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const args = ['two words', "it's quoted", 'first\nsecond', '$(literal)', '*'];
  const result = spawnSync(
    process.execPath,
    [
      'dist/cli-entry.js',
      'heavy',
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      ...args,
    ],
    { encoding: 'utf8', env: { ...process.env, FORGE_HEAVY_DIR: directory } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('native save distinguishes completed receipts from pending exact-operation replay without extra calls', async () => {
  const operationId = 'a8526d55-dada-4c33-a1a4-c00f9b25ef70';
  const command = {
    laneId: '84a29ed7-aead-4c58-96cd-3d58d807947b',
    message: "It's a saved\nmessage",
    operationId,
  };
  const session = {
    root: '/synthetic',
    address: { url: 'https://fixture.invalid', projectId: 'synthetic' },
    journal: { operationId, id: () => assert.fail('No new operation for pending or completed save') },
  };
  const completed = { outcome: { status: 'completed', result: { head: 'a'.repeat(64) } } };
  assert.equal(await withSourceRecovery(session, 'save', command, completed), completed);
  assert.equal(completed.status, undefined, 'completed save is never labelled submitted');
  const pending = { jobId: 'job', status: 'submitted' };
  const reply = await withSourceRecovery(session, 'save', command, pending);
  assert.equal(reply.replay.operationId, operationId);
  assert.equal(reply.next.operationId, operationId);
  assert.equal(reply.replay.message, command.message);
  assert.equal(reply.replay.command, reply.command);
  assert(reply.command.includes(operationId));
  const capture = `${shellQuote(process.execPath)} -e ${shellQuote('process.stdout.write(JSON.stringify(process.argv.slice(1)))')} -- `;
  const replay = spawnSync('/bin/sh', ['-c', reply.command.replace(/^nforge /, capture)], {
    encoding: 'utf8',
  });
  assert.equal(replay.status, 0, replay.stderr);
  const args = JSON.parse(replay.stdout);
  assert.deepEqual(args.slice(0, 3), ['agent', '/synthetic', 'save']);
  assert.deepEqual(JSON.parse(args[3]), { action: 'save', ...session.address, ...command });
  assert.deepEqual(await withSourceRecovery(session, 'save', command, pending), reply);
});
