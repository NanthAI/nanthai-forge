// SPDX-License-Identifier: Apache-2.0
import { testStem } from './hosted-landing-suspect.js';
import { safeRelative } from './safe-relative.js';

/** A decided-by-name test file for any ecosystem (`x.test.ts`, `test_x.py`, `x_test.go`, `XTest.java`,
 * `XTests.cs`, `x_spec.rb`): a plain relative path with no hidden folder whose file name has a test shape.
 * Used where no project runner is at hand (a landing result, a retained shard plan) to decide whether a
 * reported name may be stored or retried. Where the runner is known, its globs decide instead. */
export function plausibleTestFile(file: unknown): file is string {
  return (
    typeof file === 'string' &&
    file.length <= 1024 &&
    /^[\w.@+\-/]+$/.test(file) &&
    safeRelative(file) &&
    !file.split('/').some(part => part.startsWith('.')) &&
    testStem(file) !== undefined
  );
}
