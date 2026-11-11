// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { summarizeCheckRun, CHECK_SUMMARY_BYTES } from '../dist/hosted-check-summary.js';

const hash = 'a'.repeat(64);
function run(extra = {}) {
  return {
    id: randomUUID(),
    at: '2026-11-06T10:00:00.000Z',
    endedAt: '2026-11-06T10:08:30.000Z',
    status: 'failed',
    request: { candidateId: randomUUID(), expectedHead: hash },
    counts: { completed: 900, passed: 897, failed: 3 },
    gate: { mode: 'scoped', effective: 'full', tests: ['tests/a.test.mjs', 'tests/b.test.mjs'] },
    execution: { seconds: 1234.56, shards: 12 },
    plan: { shardCount: 12 },
    exitCode: 1,
    cost: { status: 'unknown' },
    ...extra,
  };
}
const reports = count =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `tests/file-${String(i).padStart(4, '0')}.test.mjs`,
      {
        failed: i % 100 === 0,
        flaky: i % 100 === 7,
        durationMs: 100 + i,
        firstError: `boom ${i} ${'x'.repeat(2000)}`,
      },
    ]),
  );

test('check summary: counts, failed and flaky names, timings and scope from the run row alone', () => {
  const summary = summarizeCheckRun(run({ contractReports: reports(900) }));
  assert.equal(summary.status, 'failed');
  assert.deepEqual(summary.counts, { completed: 900, passed: 897, failed: 3 });
  assert.deepEqual(summary.files, { total: 900, failed: 9, flaky: 9 });
  assert.equal(summary.failed.length, 9);
  assert.equal(summary.failed[0].file, 'tests/file-0000.test.mjs');
  assert(summary.failed[0].firstError.length <= 161, 'error clipped');
  assert.equal(summary.flaky[0], 'tests/file-0007.test.mjs');
  assert.equal(summary.timings.wallSeconds, 510);
  assert.equal(summary.timings.executionSeconds, 1234.6);
  assert.equal(summary.timings.shards, 12);
  assert.deepEqual(summary.timings.slowest[0], { file: 'tests/file-0899.test.mjs', durationMs: 999 });
  assert.equal(summary.selection.mode, 'scoped');
  assert.equal(summary.selection.effective, 'full');
  assert.equal(summary.selection.requestedTests, 2);
  assert.equal(summary.selection.reportedFiles, 900);
  assert.equal(summary.more, undefined);
});

// Issue 7cb61db1: a run that fell back to the whole command carries the code and the reason text.
test('check summary: a run that ran in full names the fallback code and its reason', () => {
  const reason = 'Command scope: package graph: gradle: …; declare packages.commands in forge.json; full run';
  const full = summarizeCheckRun(run({ fallback: 'graph-full', fallbackReason: reason }));
  assert.deepEqual(full.selection.ranInFull, { code: 'graph-full', reason });
  assert.equal(summarizeCheckRun(run()).selection.ranInFull, undefined);
});

test('check summary: stays under 8 KB with hundreds of failed and flaky files, and says what it left out', () => {
  const many = Object.fromEntries(
    Array.from({ length: 600 }, (_, i) => [
      `tests/some/deeply/nested/directory/with/a/long/path/file-${i}.test.mjs`,
      { failed: i % 2 === 0, flaky: i % 2 === 1, durationMs: 50 + i, firstError: 'e'.repeat(2048) },
    ]),
  );
  const summary = summarizeCheckRun(run({ contractReports: many }));
  assert(JSON.stringify(summary).length <= CHECK_SUMMARY_BYTES, `${JSON.stringify(summary).length}`);
  assert.deepEqual(summary.files, { total: 600, failed: 300, flaky: 300 });
  assert(summary.more.failed > 0 && summary.more.flaky > 0);
  assert.equal(summary.failed.length + summary.more.failed, 300);
});

test('check summary: a landed run without reports uses the compact testFiles summary; an empty run is valid', () => {
  const summary = summarizeCheckRun(
    run({
      status: 'passed',
      testFiles: {
        counts: { total: 900, failed: 1, flaky: 1 },
        failed: [{ file: 'tests/x.test.mjs', report: { failed: true, firstError: 'bad\n  thing' } }],
        flaky: [{ file: 'tests/y.test.mjs', report: { failed: false, flaky: true } }],
      },
    }),
  );
  assert.deepEqual(summary.files, { total: 900, failed: 1, flaky: 1 });
  assert.deepEqual(summary.failed, [{ file: 'tests/x.test.mjs', firstError: 'bad thing' }]);
  assert.deepEqual(summary.flaky, ['tests/y.test.mjs']);
  const empty = summarizeCheckRun(
    run({ status: 'running', endedAt: null, gate: undefined, execution: undefined }),
  );
  assert.equal(empty.timings.wallSeconds, null);
  assert.equal(empty.selection.mode, null);
  assert.deepEqual(empty.failed, []);
});

test('header-only summaries retain slowest files and exact omitted failure counts', () => {
  const value = run({
    testFiles: {
      counts: { total: 20000, failed: 20000, flaky: 0 },
      failed: [{ file: 'tests/a.test.mjs', report: { failed: true } }],
      flaky: [],
      omitted: { failed: 19999, flaky: 0 },
    },
    reportSummary: { slowest: [{ file: 'tests/slow.test.mjs', durationMs: 900 }], semantic: {} },
  });
  const summary = summarizeCheckRun(value);
  assert.equal(summary.files.failed, 20000);
  assert.equal(summary.more.failed, 19999);
  assert.equal(summary.selection.reportedFiles, 20000);
  assert.deepEqual(summary.timings.slowest, value.reportSummary.slowest);
});
