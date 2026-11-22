// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  followLocalOperation,
  observeHostedSave,
  observeOperations,
} from '../dist/hosted-agent-wait-local.js';
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
      return progress(args, name);
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

const missingSource = (_args, name) => {
  const kind = name === 'projectHostedSync:progress' ? 'sync' : 'save';
  throw new ForgeError('NOT_FOUND', `Prepare this original hosted ${kind} first.`);
};

test('an operation id outside the supported waits keeps the original NOT_FOUND', async t => {
  const root = projectFolder(t);
  const server = transport(missingSource);
  const reply = await followLocalOperation(
    server,
    root,
    { operationIds: [randomUUID()], timeoutSeconds: 1 },
    notFound,
  );
  assert.equal(reply, undefined, 'the caller rethrows the landing NOT_FOUND');
  assert.deepEqual(
    server.queries.map(query => query.name),
    ['projectHostedSaves:progress', 'projectHostedSync:progress'],
  );
});

test('ad80e037: an unknown wait id says which project folder it looked in', async t => {
  const root = projectFolder(t);
  const server = {
    ...transport(missingSource),
    dispatch: async () => ({ result: { actor: 'owner', features: [] } }),
  };
  await assert.rejects(
    observeOperations(server, root, { operationIds: [randomUUID()], timeoutSeconds: 1 }),
    error =>
      error.code === 'NOT_FOUND' &&
      error.message.includes(`This wait looked in the project of ${root}`) &&
      /run it from the Lane or project folder that started the operation/.test(error.message),
  );
});

for (const stop of ['timeout', 'cancelled', 'access refused'])
  test(`a live background save wait closes its subscription on ${stop}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const operationId = randomUUID();
    const controller = new AbortController();
    const server = transport(() => assert.fail('a live background wait uses the subscription only'));
    let unread = false;
    let closed = false;
    const refused = new ForgeError('PROJECT_UNAVAILABLE', 'Project access ended.');
    const waiting = observeHostedSave(
      server,
      operationId,
      2,
      controller.signal,
      () => ({
        onUpdate(_ref, args, update, fail) {
          assert.equal(args.operationId, operationId);
          update({ state: { status: 'submitted' }, terminal: null });
          if (stop === 'access refused') fail(refused);
          return () => {
            unread = true;
          };
        },
        async close() {
          closed = true;
        },
      }),
      undefined,
      'background',
    );
    if (stop === 'timeout') t.mock.timers.tick(2_000);
    if (stop === 'cancelled') controller.abort();
    if (stop === 'access refused') await assert.rejects(waiting, refused);
    else {
      const reply = await waiting;
      assert.equal(reply.result.status, stop);
      assert.equal(reply.result.inProgress, true);
      assert.equal(reply.operationId, operationId);
    }
    assert(unread && closed);
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
