// SPDX-License-Identifier: Apache-2.0
// Item a1e3d771: each line of a combined result is attributed from the three exact retained inputs (main, the Lane
// ahead's save, this Lane's result). Lines the Lane ahead added that the result drops are listed as left out, and
// nothing claims which of this Lane's saves wrote a line, because that is not retained.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { lineOrigin } = await import(moduleUrl('../web/src/app/lane/line-origin.ts'));
const bytes = lines => new TextEncoder().encode(lines.join('\n'));

test('main, the Lane ahead and this Lane each get their own lines, and dropped lines are left out', () => {
  const main = bytes(['a', 'b', 'c', 'd']);
  const ahead = bytes(['a', 'B1', 'B2', 'c', 'd']);
  const result = bytes(['a', 'B1', 'mine', 'c', 'e']);
  const origin = lineOrigin(main, ahead, result);
  assert.deepEqual(
    origin.lines.map(line => [line.text, line.from, line.gone ?? false]),
    [
      ['a', 'main', false],
      ['b', 'ahead', true],
      ['B1', 'ahead', false],
      ['mine', 'lane', false],
      ['c', 'main', false],
      ['d', 'lane', true],
      ['e', 'lane', false],
    ],
  );
  assert.deepEqual(origin.leftOut, ['B2']);
  assert.deepEqual(origin.tally, { main: 2, ahead: 1, lane: 2, leftOut: 1 });
  // Shown lines are numbered as the result's lines; removed lines have no number.
  assert.deepEqual(
    origin.lines.filter(line => !line.gone).map(line => line.n),
    [1, 2, 3, 4, 5],
  );
});

test('an unchanged file is all main, and a binary side has no origin to show', () => {
  const same = bytes(['x', 'y']);
  assert.deepEqual(lineOrigin(same, same, same).tally, { main: 2, ahead: 0, lane: 0, leftOut: 0 });
  assert.equal(lineOrigin(same, new Uint8Array([0, 1, 2, 0]), same), null);
});
