// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPhases } from '../scripts/check-phases.mjs';

test('phases report wall time and CPU share on one line, even when a phase throws', () => {
  const lines = [];
  const phases = checkPhases(line => lines.push(line));
  assert.equal(
    phases.time('install', () => 7),
    7,
  );
  assert.throws(() => phases.time('tests', () => assert.fail('synthetic')), /synthetic/);
  phases.report();
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /^Check phases on \d+ CPUs(?: \([^)]+\))?, \d+ GiB: install \d+\.\ds \(cpu \d+%\); tests \d+\.\ds \(cpu \d+%\)$/,
  );
});
