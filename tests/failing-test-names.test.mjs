// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { failingTests } = await import(moduleUrl('../web/src/lane/landing-output.ts'));

test('failing test names come from ✖ lines without the summary header or timings', () => {
  const summary = [
    '✖ discount › SAVE10 takes 10% off (12.5ms)',
    '  AssertionError: expected 9, got 8.5',
    '✖ failing tests:',
    '✖ discount › SAVE10 takes 10% off (12.5ms)',
  ].join('\n');
  assert.deepEqual(failingTests(summary), ['discount › SAVE10 takes 10% off']);
});

test('streamed TAP failures retain their names', () => {
  assert.deepEqual(failingTests('[test] not ok 12 - source regression\nnot ok 12 - source regression'), [
    'source regression',
  ]);
});
