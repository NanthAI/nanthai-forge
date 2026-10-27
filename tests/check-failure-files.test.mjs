// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { failedTestFiles } from '../dist/check-failure-files.js';

test('failure files come from named failures and structured failed results', () => {
  assert.deepEqual(
    failedTestFiles(
      [
        '2026-10-25T12:00:00Z # Failed test file: tests/a.test.mjs',
        '[test] Failed test file: tests/a.test.mjs',
        '__FORGE_TEST_FAILURE__{"file":"tests/b.test.mjs"}',
        '__FORGE_TESTS__{"file":"tests/c.test.mjs","results":[{"passed":false}]}',
        '__FORGE_TESTS__{"file":"tests/green.test.mjs","results":[{"passed":true}]}',
        '__FORGE_TESTS__{truncated',
      ].join('\n'),
    ),
    ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/c.test.mjs'],
  );
});
