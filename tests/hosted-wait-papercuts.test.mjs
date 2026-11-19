// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { followLocalOperation } from '../dist/hosted-agent-wait-local.js';
import { ForgeError } from '../dist/errors.js';
import { interruptedWait } from '../dist/agent-operation-wait.js';
import { wakeContinuation } from '../dist/agent-wake.js';

/** A project folder that holds no local record of the save (the save ran in a Lane folder). */
function projectFolder(t) {
  const parent = mkdtempSync(join(tmpdir(), 'forge-wait-save-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'project');
  mkdirSync(root);
  return root;
}
const notFound = new ForgeError('NOT_FOUND', 'Select one hosted landing operation.');
const transport = progress => {
  const queries = [];
  return {
    queries,
    address: { url: 'https://fixture.invalid', projectId: 'synthetic' },
    advertisedFeatures: [],
    query: async (name, args) => {
      queries.push({ name, args });
      return progress(args);
    },
  };
};

test('frictions 7ad45fe5 and ecf43f8d: wait on a save operation id from a folder without its local record follows the save', async t => {
  const root = projectFolder(t),
    operationId = randomUUID(),
    head = 'a'.repeat(64);
  // The server's progress reply always carries the save's own state (convex/projectHostedSaves.ts).
  const server = transport(() => ({
    state: { status: 'completed' },
    terminal: { outcome: { status: 'completed', result: { head, sourceVersion: 3 } } },
  }));
  const reply = await followLocalOperation(
    server,
    root,
    { operationIds: [operationId], timeoutSeconds: 1 },
    notFound,
  );
  assert.equal(reply?.result.status, 'terminal');
  assert.equal(reply.result.successful, true);
  assert.equal(reply.result.phase, 'save');
  assert.equal(reply.result.head, head);
  assert.deepEqual(
    server.queries.map(query => query.name),
    ['projectHostedSaves:progress'],
    'one save read, only after the landing read found nothing',
  );
});

test('an operation id that is neither a landing nor a save keeps the original NOT_FOUND', async t => {
  const root = projectFolder(t);
  const server = transport(() => {
    throw new ForgeError('NOT_FOUND', 'Prepare this original hosted save first.');
  });
  const reply = await followLocalOperation(
    server,
    root,
    { operationIds: [randomUUID()], timeoutSeconds: 1 },
    notFound,
  );
  assert.equal(reply, undefined, 'the caller rethrows the landing NOT_FOUND');
  assert.equal(server.queries.length, 1);
});

test('2026-11-18 lead: a wake wait stopped at the harness background limit (SIGTERM) resumes like a budget return', () => {
  const stopped = interruptedWait('SIGTERM');
  assert.equal(stopped.exitCode, 3, 'exit 3: repeat the same command, the work goes on');
  assert.equal(stopped.reason, 'stopped');
  assert.match(stopped.note, /background time limit/);
  assert.match(stopped.note, /same command/);
  assert.deepEqual(
    interruptedWait('SIGINT'),
    { exitCode: 130, reason: 'cancelled' },
    'a person interrupting still cancels',
  );
  const wake = wakeContinuation('/synthetic', { action: 'wait', operationIds: [randomUUID()] });
  assert.match(
    wake.instruction,
    /default 1800000 ms stops it early/,
    'the wake names the default limit up front',
  );
});
