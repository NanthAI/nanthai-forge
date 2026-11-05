// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { bootstrapInterval, pairDifferences } from '../scripts/bootstrap-interval.mjs';

const script = new URL('../scripts/bootstrap-interval.mjs', import.meta.url).pathname;

test('a consistent improvement across 11 pairs excludes zero, deterministically per seed', () => {
  const differences = [-3, -2, -4, -3.5, -2.5, -3, -1.5, -4, -2, -3, -3.2];
  const a = bootstrapInterval(differences, { seed: 7 });
  assert.deepEqual(bootstrapInterval(differences, { seed: 7 }), a);
  assert.equal(a.n, 11);
  assert.equal(a.medianDifference, -3);
  assert.equal(a.excludesZero, true);
  assert.ok(a.ci95[0] <= a.medianDifference && a.medianDifference <= a.ci95[1] && a.ci95[1] < 0);
  assert.equal(a.smallSample, false);
});

test('mixed-sign pairs include zero and small N is labelled', () => {
  const r = bootstrapInterval([-2, 3, -1, 2, 0.5, -0.5], { seed: 1 });
  assert.equal(r.excludesZero, false);
  assert.ok(r.ci95[0] < 0 && r.ci95[1] > 0);
  assert.equal(r.smallSample, true);
});

test('N=2 has a degenerate interval from the two observed differences', () => {
  const r = bootstrapInterval([1, 3], { seed: 1 });
  assert.equal(r.medianDifference, 2);
  assert.deepEqual(r.ci95, [1, 3]);
  assert.equal(r.excludesZero, true);
  assert.equal(r.smallSample, true);
});

test('pairs are accepted as differences, [a, b] arrays, {a, b} objects or {pairs}', () => {
  assert.deepEqual(pairDifferences([2, -1]), [2, -1]);
  assert.deepEqual(
    pairDifferences([
      [10, 7],
      [4, 5],
    ]),
    [-3, 1],
  );
  assert.deepEqual(pairDifferences({ pairs: [{ a: 10, b: 7 }] }), [-3]);
});

test('bad input is rejected', () => {
  assert.throws(() => bootstrapInterval([]), /at least one pair/);
  assert.throws(() => bootstrapInterval([1, 'x']), /finite number/);
  assert.throws(() => bootstrapInterval([[1, 2, 3]]), /\[a, b\]/);
  assert.throws(() => bootstrapInterval([1, 2], { resamples: 10 }), /resamples/);
});

test('CLI reads stdin and honours --seed', () => {
  const input = JSON.stringify([-3, -2, -4, -3.5, -2.5]);
  const run = () =>
    JSON.parse(execFileSync(process.execPath, [script, '--seed', '5'], { input, encoding: 'utf8' }));
  const out = run();
  assert.deepEqual(out, run());
  assert.deepEqual(out, bootstrapInterval(JSON.parse(input), { seed: 5 }));
});
