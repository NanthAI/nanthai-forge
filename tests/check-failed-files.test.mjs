// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFileSummary, failedErrorChars, failedErrors } from '../dist/check-file-summary.js';
import { checkFailureDetail, CHECK_FAILED_NEXT } from '../dist/check-failure-detail.js';
import { landSummary } from '../dist/hosted-land-summary.js';
import { slimReceipt } from '../dist/receipt-slim.js';

// Issue 58236de6 (absorbed b083afb6): a failed check lists every failed test file with its first error.
const fixture = count =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `tests/file-${String(i).padStart(3, '0')}.test.mjs`,
      {
        failed: true,
        firstError: `case ${i}: expected ${i} but got token=abcdef123456\n  at line ${i}`,
      },
    ]),
  );
// The run the executor reports: contractReports for the message, the compact summary for the list.
const landing = count => {
  const reports = fixture(count);
  const testFiles = checkFileSummary(reports);
  const detail = checkFailureDetail({ contractReports: reports, testFiles });
  const message = `The original exact check settled as failed. ${detail} ${CHECK_FAILED_NEXT}`;
  return {
    detail,
    testFiles,
    response: {
      operationId: 'op-1',
      result: {
        phase: 'finish',
        submission: {
          phase: 'terminal-failed',
          error: { code: 'CHECK_FAILED', message },
          testFiles,
        },
      },
    },
  };
};

test('three failed files: the message names the first, the output lists the other two with errors', () => {
  const { detail, response } = landing(3);
  assert.match(
    detail,
    /^Failing: tests\/file-000\.test\.mjs \(case 0: expected 0 but got token=\[redacted\] at line 0\); \+2 more failed files\.$/,
  );
  const lines = landSummary(response);
  assert.match(lines[0], /^FAILED CHECK_FAILED: .*file-000\.test\.mjs.*land --save again/);
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(
    lines[1],
    /^ {2}tests\/file-001\.test\.mjs :: case 1: expected 1 but got token=\[redacted\] at line 1$/,
  );
  assert.match(lines[2], /^ {2}tests\/file-002\.test\.mjs :: case 2: /);
  assert.doesNotMatch(lines.join('\n'), /abcdef123456/);
});

test('many failed files: capped list, an N more line with the full-list command, bounded size', () => {
  const { testFiles, response } = landing(120);
  assert.equal(testFiles.counts.failed, 120);
  const withError = testFiles.failed.filter(item => item.report.firstError);
  assert.equal(withError.length, failedErrors, 'only the capped files keep an error');
  assert.ok(withError.every(item => item.report.firstError.length <= failedErrorChars));
  const lines = landSummary(response);
  // The message names 1 file; the list adds failedErrors - 1 more, each with its error, then the overflow line.
  const listed = lines.filter(line => line.startsWith('  tests/'));
  assert.equal(listed.length, failedErrors - 1, lines.join('\n'));
  assert.ok(listed.every(line => / :: /.test(line)));
  const more = lines.at(-1);
  assert.match(
    more,
    /^ {2}\.\.\. 100 more failing files; all names: nforge agent ROOT status '\{"operationId":"op-1"\}' --detail$/,
  );
  assert.ok(Buffer.byteLength(lines.join('\n')) < 8 * 1024, 'the printed failure stays under 8 KiB');
  // The compact summary adds at most failedErrors x failedErrorChars of error text per run.
  const errorBytes = Buffer.byteLength(withError.map(item => item.report.firstError).join(''));
  assert.ok(errorBytes <= failedErrors * failedErrorChars);
});

test('files past the capped list still count, names only, in the compact summary', () => {
  const { testFiles } = landing(25);
  assert.equal(testFiles.failed.length, 25);
  assert.equal(testFiles.failed[24].report.firstError, undefined);
  const lines = landSummary(landing(25).response);
  assert.match(lines.at(-1), /^ {2}\.\.\. 5 more failing files/);
});

test('the default failed-land receipt stays unchanged by slimming (full receipt is not slimmed away)', () => {
  const { response } = landing(3);
  const slim = slimReceipt({
    ...response,
    transport: 'hosted',
    action: 'finish',
  });
  assert.equal(slim.result.submission.testFiles.failed.length, 3);
});
