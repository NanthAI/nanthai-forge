// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The side-by-side diff (Item 8e847a17): a replaced line sits across from its replacement, a pure addition or removal
// across from an empty cell, and every line keeps its own number on each side.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { splitRows } = await import(moduleUrl('../web/src/diff-split.ts'));
const line = (kind, text) => ({ kind, text });

test('removed and added runs pair line to line, a longer run leaves empty cells, context sits on both sides', () => {
  const rows = splitRows(
    {
      beforeStart: 10,
      afterStart: 12,
      lines: [
        line('context', 'keep'),
        line('removed', 'old 1'),
        line('removed', 'old 2'),
        line('removed', 'old 3'),
        line('added', 'new 1'),
        line('context', 'tail'),
        line('added', 'only added'),
      ],
    },
    0,
  );
  const show = cell => (cell ? `${cell.n}:${cell.text}` : '-');
  assert.deepEqual(
    rows.map(row => [show(row.left), show(row.right)]),
    [
      ['10:keep', '12:keep'],
      ['11:old 1', '13:new 1'],
      ['12:old 2', '-'],
      ['13:old 3', '-'],
      ['14:tail', '14:tail'],
      ['-', '15:only added'],
    ],
  );
  assert.deepEqual(rows[1].left.key, '0:1');
  assert.deepEqual(rows[1].right.key, '0:4');
});
