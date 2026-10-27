// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConvexError } from 'convex/values';
import { moduleUrl } from './convex-module.mjs';
import { ForgeError } from '../dist/errors.js';
const { indexReadContext, indexTransient } = await import(moduleUrl('../convex/projectWorkIndexRetry.ts'));

test('index read retries recover in place and never retry permanent errors', async () => {
  let calls = 0;
  const ctx = indexReadContext({
    storage: {
      getUrl: async () => {
        if (++calls < 3) throw new Error('Transient error while running storage get url');
        return 'available';
      },
    },
  });
  assert.equal(await ctx.storage.getUrl('storage'), 'available');
  assert.equal(calls, 3);
  for (const error of [
    new ForgeError('INVALID_WORK_BACKUP', 'Transient error text in invalid source'),
    new ForgeError('PROJECT_UNAVAILABLE', 'Source access revoked'),
    new ConvexError({ code: 'BAD_ARGUMENT', message: 'Transient error' }),
    new ConvexError('Transient error in application validation'),
    new Error('ArgumentValidationError: invalid digest'),
    new Error('Action execution time limit exceeded'),
  ]) {
    assert.equal(indexTransient(error), false);
    let calls = 0;
    const ctx = indexReadContext({
      storage: {
        getUrl: async () => {
          calls++;
          throw error;
        },
      },
    });
    await assert.rejects(ctx.storage.getUrl('storage'), actual => actual === error);
    assert.equal(calls, 1);
  }
});

test('exhausted timeouts carry a retryable signal without multiplying child attempts', async () => {
  let calls = 0;
  const child = indexReadContext({
    storage: {
      get: async () => {
        calls++;
        throw new ForgeError('EXCHANGE_REQUEST_TIMEOUT', 'storage request timed out');
      },
    },
  });
  const parent = indexReadContext({ runAction: () => child.storage.get('storage'), storage: {} });
  await assert.rejects(parent.runAction('read', {}), error => {
    assert.equal(error.data.code, 'WORK_INDEX_RETRY');
    return indexTransient(error);
  });
  assert.equal(calls, 3);
});
