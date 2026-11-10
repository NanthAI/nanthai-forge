// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ForgeError } from '../dist/errors.js';
function readRunWhileStarting(store) {
  try {
    return store.load().runs[0];
  } catch (error) {
    if (error instanceof ForgeError && error.code === 'SOURCE_CHANGED') return undefined;
    throw error;
  }
}
test('runner readiness poll retries only genuine SOURCE_CHANGED observations', () => {
  const ready = { status: 'running', childPid: 1 };
  let reads = 0;
  const store = {
    load() {
      if (reads++ === 0) throw new ForgeError('SOURCE_CHANGED', 'Concurrent atomic Work save');
      return { runs: [ready] };
    },
  };
  assert.equal(readRunWhileStarting(store), undefined);
  assert.equal(readRunWhileStarting(store), ready);
  assert.equal(reads, 2);
  for (const error of [
    new ForgeError('INVALID_WORK_STORE', 'Invalid metadata'),
    new Error('Unexpected read failure'),
    Object.assign(new Error('Untrusted error code'), { code: 'SOURCE_CHANGED' }),
  ])
    assert.throws(
      () =>
        readRunWhileStarting({
          load() {
            throw error;
          },
        }),
      caught => caught === error,
    );
});
