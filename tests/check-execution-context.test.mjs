// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { detachedChecksRequired, withDetachedChecks } from '../dist/check-execution-context.js';
import { withLandingWorker } from '../dist/landing-worker-context.js';
import { checkPhases } from '../scripts/check-phases.mjs';

test('CLI owner hosts local checks while explicit provider and transport checks stay detached', async t => {
  t.mock.property(process, 'argv', [process.execPath, '/synthetic/dist/cli.js']);
  assert.equal(detachedChecksRequired(), true, 'finite CLI requests outlive their transport');
  await withLandingWorker(new AbortController().signal, async () => {
    await yieldTurn();
    assert.equal(detachedChecksRequired(), false, 'owner scope overrides the CLI default');
    await withDetachedChecks(async () => {
      await yieldTurn();
      assert.equal(detachedChecksRequired(), true, 'GitHub admission can still detach');
    });
    assert.equal(detachedChecksRequired(), false, 'provider scope does not escape admission');
  });
  assert.equal(detachedChecksRequired(), true, 'owner scope does not escape to CLI requests');
});

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
