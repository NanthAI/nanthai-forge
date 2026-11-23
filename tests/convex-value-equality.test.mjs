// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareValues } from 'convex/values';
import { equalConvexValue } from './convex-value-equality.mjs';

test('fixture index equality agrees with Convex for primitive, binary and compound keys', () => {
  const values = [
    undefined,
    null,
    false,
    true,
    0,
    -0,
    NaN,
    Infinity,
    -Infinity,
    1,
    1n,
    '',
    'project',
    'other',
    Uint8Array.from([1, 2]).buffer,
    Uint8Array.from([1, 2]).buffer,
    Uint8Array.from([2, 1]).buffer,
    [1, 'project'],
    [1, 'project'],
    { a: 1, b: 2 },
    { b: 2, a: 1 },
  ];
  for (const [i, a] of values.entries())
    for (const [j, b] of values.entries())
      assert.equal(equalConvexValue(a, b), compareValues(a, b) === 0, `key pair ${i}/${j}`);
});
