// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSlots, workerBudget } from './worker-budget.mjs';

test('default test budget leaves two cores free and divides them across check slots', () => {
  for (const [cpus, expected] of [
    [1, 1],
    [2, 1],
    [3, 1],
    [4, 2],
    [8, 3],
    [10, 4],
    [16, 3],
    [64, 3],
  ])
    assert.equal(workerBudget({}, cpus), expected);
});

test('configured check slots set the divisor; malformed slot settings use the queue default', () => {
  assert.equal(checkSlots({ FORGE_MAX_CONCURRENT_CHECKS: '1' }, 10), 1);
  assert.equal(workerBudget({ FORGE_MAX_CONCURRENT_CHECKS: '1' }, 10), 8);
  assert.equal(workerBudget({ FORGE_MAX_CONCURRENT_CHECKS: '4' }, 10), 2);
  assert.equal(workerBudget({ FORGE_MAX_CONCURRENT_CHECKS: '0' }, 10), 4);
  assert.equal(workerBudget({ FORGE_MAX_CONCURRENT_CHECKS: '1', FORGE_TEST_WORKERS: '6' }, 10), 6);
});

test('explicit worker budget is configurable and malformed settings are diagnosed', () => {
  assert.equal(workerBudget({ FORGE_TEST_WORKERS: '2' }, 10), 2);
  assert.equal(workerBudget({ FORGE_TEST_WORKERS: '8' }, 10), 8);
  for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992'])
    assert.throws(() => workerBudget({ FORGE_TEST_WORKERS: value }, 10), /FORGE_TEST_WORKERS/);
});
