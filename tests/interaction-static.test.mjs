// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { runDocumentationChecks } from '../scripts/check-documentation.mjs';

test('interaction docs execution includes every merged static check and no behavior suites', () => {
  const calls = [];
  runDocumentationChecks({
    npm: (...args) => calls.push(args),
    node: path => calls.push([path]),
    interaction: true,
  });
  assert.deepEqual(calls, [
    ['run', 'check'],
    ['run', 'typecheck'],
    ['run', 'lint'],
    ['run', 'format:check'],
    ['scripts/check-documents.mjs'],
  ]);
});
test('ordinary docs execution preserves its established commands', () => {
  const calls = [];
  runDocumentationChecks({ npm: (...args) => calls.push(args), node: path => calls.push([path]) });
  assert.deepEqual(calls, [['run', 'check'], ['run', 'format:check'], ['scripts/check-documents.mjs']]);
});
test('interaction static failure propagates rather than reporting a passing docs check', () => {
  const calls = [];
  assert.throws(
    () =>
      runDocumentationChecks({
        npm: (...args) => {
          calls.push(args);
          if (args[1] === 'typecheck') throw new Error('typecheck failed');
        },
        node: path => calls.push([path]),
        interaction: true,
      }),
    /typecheck failed/,
  );
  assert.deepEqual(calls, [
    ['run', 'check'],
    ['run', 'typecheck'],
  ]);
});
