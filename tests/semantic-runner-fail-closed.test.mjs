// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { semanticCheckCommand } from '../dist/semantic-check-command.js';

const intent = '44444444-4444-4444-8444-444444444444';
const plan = {
  primaryIntentId: intent,
  members: [intent, '55555555-5555-4555-8555-555555555555'].map(intentId => ({
    intentId,
    outcome: 'x',
    version: 1,
    tests: [{ path: 'src/a.spec.ts', durationMs: 5 }],
  })),
};
const run = command => spawnSync(command[0], command.slice(1), { encoding: 'utf8' });

test('a selected test with no runner command fails closed with a named reason, never a crash', () => {
  const command = semanticCheckCommand([process.execPath, '-e', ''], plan, process.execPath, [], {
    status: 'available',
    runner: {
      layout: 'generic',
      command: ['unused'],
      parts: [{ globs: ['src/*.spec.ts'], command: [process.execPath, '-e', 'process.exit(0)', '{files}'] }],
    },
  });
  // The per-file commands the run was planned with.
  const payload = JSON.parse(command.at(-1));
  assert.deepEqual(Object.keys(payload.runner), ['src/a.spec.ts']);
  const planned = run(command);
  assert.equal(planned.status, 0, planned.stderr);
  // The plan and the runner map drift apart: the test has no command.
  payload.runner = {};
  const missing = run([...command.slice(0, -1), JSON.stringify(payload)]);
  assert.equal(missing.status, 2);
  assert.match(
    missing.stderr,
    /SEMANTIC_TESTS_UNAVAILABLE: src\/a\.spec\.ts: no runner command for this test/,
  );
  assert.doesNotMatch(missing.stderr, /TypeError|UnhandledPromiseRejection|at async/);
  const report = JSON.parse(missing.stdout.split('__FORGE_TESTS__')[1]);
  assert.deepEqual([report.file, report.results[0].passed], ['src/a.spec.ts', false]);
});
