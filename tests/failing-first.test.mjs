// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayPlan } from '../scripts/failing-first.mjs';

test('failing-first puts main back over changed sources only, never over tests (friction ccf1d4b0)', () => {
  const plan = overlayPlan(
    [
      { path: 'src/a.ts', change: 'modified' },
      { path: 'src/new.ts', change: 'added' },
      { path: 'tests/a.test.mjs', change: 'modified' },
      { path: 'tests/helper.mjs', change: 'added' },
      { path: 'docs/x.md', change: 'modified' },
    ],
    ['./tests/a.test.mjs'],
  );
  assert.deepEqual(plan, [
    { path: 'src/a.ts', action: 'restore' },
    { path: 'src/new.ts', action: 'remove' },
    { path: 'docs/x.md', action: 'restore' },
  ]);
});
