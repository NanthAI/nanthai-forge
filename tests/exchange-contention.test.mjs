// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConvexError } from 'convex/values';
import { getFunctionName } from 'convex/server';
import { ConvexExchange } from '../dist/exchange-client.js';
import { retryExchange } from '../dist/exchange-retry.js';
import { ForgeError } from '../dist/errors.js';
import { hostedActionError } from '../dist/hosted-action-error.js';
import { moduleUrl } from './convex-module.mjs';
import { fixture, checkpoint, modules } from './project-exchange-fixture.mjs';
const { report } = await import(moduleUrl('../convex/errors.ts'));

for (const method of ['publish', 'published', 'returnSource', 'journal'])
  test(`${method} retries an unknown hosted reply with identical operation and payload`, async t => {
    const exchange = new ConvexExchange(
        'https://fixture.invalid',
        'synthetic',
        'project',
        randomUUID(),
        null,
      ),
      calls = [];
    let committed = 0;
    t.mock.method(exchange.client, 'action', async (ref, input) => {
      calls.push({ name: getFunctionName(ref), input: structuredClone(input) });
      if (calls.length === 1) {
        committed++;
        throw Error('[Request ID: abc123] INTERNAL_ERROR synthetic-private-payload');
      }
      assert.equal(committed, 1);
      return method === 'journal' ? 'journal' : method === 'returnSource' ? { id: 'receipt' } : 'backup';
    });
    const result =
      method === 'returnSource'
        ? await exchange.returnSource('candidate', 'base', 12, randomUUID())
        : method === 'journal'
          ? await exchange.journal()
          : await exchange[method]({ sha256: 'a'.repeat(64), size: 4 });
    assert.ok(result);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(committed, 1);
  });

test('source return resumes committed continuations without inventing operation IDs', async t => {
  const exchange = new ConvexExchange('https://fixture.invalid', 'synthetic', 'project', randomUUID(), null),
    inputs = [];
  t.mock.method(exchange.client, 'action', async (_ref, input) => {
    inputs.push(input);
    if (inputs.length === 2)
      throw new ConvexError({ code: 'HOSTED_CONFLICT', message: 'Concurrent hosted transaction.' });
    return inputs.length < 4 ? { pending: true } : { id: 'once' };
  });
  assert.deepEqual(await exchange.returnSource('candidate', 'base', 1, randomUUID()), { id: 'once' });
  assert.equal(inputs.length, 4);
  for (const input of inputs) assert.deepEqual(input, inputs[0]);
});

test('push retries local Work races with the same operation then fails typed after its bounded budget', async () => {
  const operationId = randomUUID(),
    ids = [];
  await assert.rejects(
    retryExchange(
      'snapshot',
      operationId,
      async () => {
        ids.push(operationId);
        throw new ForgeError('WORK_STALE', 'Work moved before preparation.');
      },
      { localSnapshot: true, delayMs: 0 },
    ),
    error =>
      error.code === 'WORK_CHANGED_DURING_PUSH' &&
      error.message.includes(operationId) &&
      error.message.includes('4 attempts'),
  );
  assert.deepEqual(ids, Array(4).fill(operationId));
});

test('stable authorization and input failures are typed and never retried', async () => {
  for (const code of [
    'AUTH_REQUIRED',
    'PROJECT_UNAVAILABLE',
    'WORK_OPERATION_CHANGED',
    'INVALID_WORK_BACKUP',
  ]) {
    let calls = 0;
    await assert.rejects(
      retryExchange(
        'publication',
        randomUUID(),
        async () => {
          calls++;
          throw new ConvexError({ code, message: 'Synthetic rejection.' });
        },
        { delayMs: 0 },
      ),
      error => error.code === code,
    );
    assert.equal(calls, 1);
  }
});

test('opaque internal errors remain typed, redact private messages and exhaust bounded retries', async () => {
  let calls = 0;
  await assert.rejects(
    retryExchange(
      'publication',
      randomUUID(),
      async () => {
        calls++;
        throw new ConvexError({ code: 'INTERNAL_ERROR', message: 'synthetic-private-payload' });
      },
      { delayMs: 0 },
    ),
    error => error.code === 'HOSTED_ACTION_FAILED' && !error.message.includes('synthetic-private-payload'),
  );
  assert.equal(calls, 4);
  assert.equal(hostedActionError(Error('INTERNAL_ERROR'), 'publication').code, 'HOSTED_ACTION_FAILED');
});

test('Convex contention becomes a typed conflict without copying document details', () => {
  assert.throws(
    () => report(Error('Documents read from or written to the table changed private-source')),
    error => error.data.code === 'HOSTED_CONFLICT' && !error.data.message.includes('private-source'),
  );
});

test('publication lost reply reconciles one real backend receipt while local Work advances', async t => {
  const s = fixture(),
    prepared = await checkpoint(t, s),
    input = prepared.input;
  let calls = 0;
  const receipt = await retryExchange(
    'publication',
    input.operationId,
    async () => {
      calls++;
      const id = await modules.projectExchangeActions.publish._handler(s.ctx, input);
      if (calls === 1) {
        prepared.store.locked(() => {
          const tx = prepared.store.records();
          tx.append('intents', {
            id: randomUUID(),
            outcome: 'Concurrent synthetic writer',
            constraints: '',
            base: tx.data().nativeHead,
            status: 'active',
            createdAt: 'now',
            notes: [],
          });
          prepared.store.commitRecords(tx);
        });
        throw Error('INTERNAL_ERROR after commit');
      }
      return id;
    },
    { delayMs: 0 },
  );
  assert.equal(calls, 2);
  assert.equal(s.tables.projectBackups.size, 1);
  assert.equal(s.tables.hostedProjects.get('project').currentBackup, receipt);
  assert.equal(await modules.projectExchangeActions.publish._handler(s.ctx, input), receipt);
});

test('Convex opaque internal errors are mapped without copying private messages', () => {
  assert.throws(
    () => report(new ConvexError({ code: 'INTERNAL_ERROR', message: 'private-source' })),
    error => error.data.code === 'HOSTED_ACTION_FAILED' && !error.data.message.includes('private-source'),
  );
});

test('hosted journal reads detect a moving head and retry to a consistent snapshot', async t => {
  const s = fixture(),
    prepared = await checkpoint(t, s);
  const backupId = await modules.projectExchangeActions.publish._handler(s.ctx, prepared.input);
  await modules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId,
    operationId: randomUUID(),
  });
  const query = s.ctx.runQuery;
  let reads = 0,
    moved = false;
  t.mock.method(s.ctx, 'runQuery', async (ref, input) => {
    const result = await query(ref, input);
    if (getFunctionName(ref) === 'projectWork:get' && ++reads === 2) {
      moved = true;
      // Mutate the head after replay, without corrupting retained history. The
      // observer must reject this mixed-time snapshot rather than return it.
      return { ...result, work: { ...result.work, revision: result.work.revision + 1 } };
    }
    return result;
  });
  const operationId = randomUUID();
  const json = await retryExchange(
    'Work journal read',
    operationId,
    () => modules.projectWorkActions.exportJournal._handler(s.ctx, { projectId: 'project' }),
    { delayMs: 0 },
  );
  assert.equal(moved, true);
  assert.equal(JSON.parse(json).source.backupId, backupId);
  assert.ok(reads >= 4);
});

test('source-return continuation retries retain their exact payloads', async t => {
  const exchange = new ConvexExchange('https://fixture.invalid', 'synthetic', 'project', randomUUID(), null),
    calls = [],
    events = [],
    operationId = randomUUID(),
    progress = { phase: 'views', step: 3, done: 1, total: 2, elapsedMs: 100, etaSeconds: 1 },
    receipt = { id: 'receipt' };
  exchange.onReturnProgress = event => events.push(event);
  t.mock.method(exchange.client, 'action', async (_ref, input) => {
    calls.push(structuredClone(input));
    if (calls.length === 1) throw Error('INTERNAL_ERROR after return attempt');
    if (calls.length === 2) return { pending: true, resumed: true, progress: JSON.stringify(progress) };
    if (calls.length === 3)
      throw new ConvexError({ code: 'HOSTED_CONFLICT', message: 'Concurrent transaction.' });
    return receipt;
  });
  assert.equal(await exchange.returnSource('candidate', 'base', 12, operationId), receipt);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[1], calls[0]);
  assert.deepEqual(calls[3], calls[2]);
  assert.equal(calls[0].statusOnly, undefined);
  assert.equal(calls[2].statusOnly, undefined);
  assert(calls.every(input => input.operationId === operationId && input.revision === 12));
  assert.deepEqual(events[0], { ...progress, resumed: true });
  assert.equal(events.at(-1).phase, 'complete');
});
