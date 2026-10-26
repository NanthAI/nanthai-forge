// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ForgeError } from '../dist/errors.js';
import { withWorkLockOptions } from '../dist/work-lock.js';
import { retryWorkPhase } from '../dist/work-retry.js';

test('a phase survives more than seven concurrent metadata turns with its original operation', async () => {
  const operationId = randomUUID(),
    ids = [];
  const result = await withWorkLockOptions({ waitMs: 30000 }, () =>
    retryWorkPhase(operationId, () => {
      ids.push(operationId);
      if (ids.length <= 9) throw new ForgeError('WORK_STALE', 'Another FIFO writer committed.');
      return { operationId, receipt: 'original' };
    }),
  );
  assert.equal(result.operationId, operationId);
  assert.deepEqual(ids, Array(10).fill(operationId));
});

test('persistent revision contention stops at configured patience with typed reconciliation instructions', async () => {
  const operationId = randomUUID();
  let calls = 0;
  await assert.rejects(
    withWorkLockOptions({ waitMs: 40 }, () =>
      retryWorkPhase(operationId, () => {
        calls++;
        throw new ForgeError('WORK_STALE', 'Another FIFO writer committed.');
      }),
    ),
    error => error.code === 'WORK_STALE' && error.message.includes(operationId),
  );
  assert.ok(calls >= 1 && calls <= 5);
});

test('phase input and authority failures do not wait or retry', async () => {
  let calls = 0;
  await assert.rejects(
    retryWorkPhase(randomUUID(), () => {
      calls++;
      throw new ForgeError('WORK_OPERATION_CHANGED', 'Original payload changed.');
    }),
    error => error.code === 'WORK_OPERATION_CHANGED',
  );
  assert.equal(calls, 1);
});

test('a slow initial phase still gets its contention reconciliation window', async () => {
  const operationId = randomUUID();
  let calls = 0;
  const result = await withWorkLockOptions({ waitMs: 10 }, () =>
    retryWorkPhase(operationId, async () => {
      if (++calls === 1) {
        await new Promise(resolve => setTimeout(resolve, 25));
        throw new ForgeError('WORK_STALE', 'Work moved during the phase.');
      }
      return operationId;
    }),
  );
  assert.equal(result, operationId);
  assert.equal(calls, 2);
});
