// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { commandQueue } from '../scripts/verify-queue.mjs';

for (const limit of ['1', '2', undefined]) {
  test(`verification command queue respects concurrency ${limit ?? 'unbounded'}`, async () => {
    const queue = commandQueue(limit);
    let active = 0,
      peak = 0;
    const completed = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        queue(async () => {
          peak = Math.max(peak, ++active);
          await new Promise(resolve => setImmediate(resolve));
          active--;
          return index;
        }),
      ),
    );
    assert.deepEqual(completed, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(peak, limit === undefined ? 8 : Number(limit));
  });
}

test('verification queue releases slots after rejection and permits build-dependent work', async () => {
  const queue = commandQueue('1');
  const failure = queue(() => {
    throw Error('synthetic');
  });
  const build = queue(() => 'built');
  const dependent = build.then(() => queue(() => 'tested'));
  await assert.rejects(failure, /synthetic/);
  assert.equal(await dependent, 'tested');
});

test('verification queue rejects invalid concurrency configuration', () => {
  for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', ''])
    assert.throws(() => commandQueue(value), /positive integer/);
});
