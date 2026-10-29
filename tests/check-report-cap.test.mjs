// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { capCheckReports, checkReportExcerptBytes } from '../dist/check-report-cap.js';
import { checkFileSummary } from '../dist/check-file-summary.js';
import { semanticReportsSchema } from '../dist/intent-semantic-conflict.js';
import { hostedCheckRunSchema } from '../dist/hosted-check.js';
import { checksFixture } from './hosted-checks-fixture.mjs';

const failures = (count, error = 'x'.repeat(2048)) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `tests/synthetic-${String(i).padStart(4, '0')}.test.mjs`,
      { durationMs: 10, failed: true, firstError: error },
    ]),
  );
test('1,000 failed file identities survive a deterministic, idempotent UTF-8 excerpt cap', t => {
  const input = failures(1000, '🙂'.repeat(1024));
  const before = process.memoryUsage().heapUsed,
    started = performance.now();
  const capped = capCheckReports(input);
  assert.equal(Object.keys(capped.reports).length, 1000);
  assert.deepEqual(capped, capCheckReports(Object.fromEntries(Object.entries(input).reverse())));
  assert.deepEqual(capCheckReports(capped.reports), capped);
  semanticReportsSchema.parse(capped.reports);
  const excerpts = Object.values(capped.reports).flatMap(r => (r.firstError ? [r.firstError] : []));
  assert.equal(excerpts.length, 32);
  assert.equal(capped.truncated, 1000);
  const excerptBytes = excerpts.reduce((n, s) => n + Buffer.byteLength(s), 0);
  assert(excerptBytes <= checkReportExcerptBytes);
  for (const text of excerpts) {
    assert(!text.includes('\ufffd'));
    assert.match(text, /\[excerpt truncated\]$/);
  }
  const summary = checkFileSummary(capped.reports);
  assert.equal(summary.failed.length, 1000);
  assert.equal(summary.truncated, 1000);
  assert(summary.failed.every(({ report }) => !('firstError' in report)));
  assert(input[Object.keys(input)[0]].firstError.length === 2048, 'input unchanged');
  const heapGrowthBytes = process.memoryUsage().heapUsed - before;
  assert(heapGrowthBytes < 32 * 1024 * 1024);
  t.diagnostic(
    JSON.stringify({
      excerptBytes,
      heapGrowthBytes,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      elapsedMs: performance.now() - started,
      additionalConvexCalls: 0,
      additionalDocumentsRead: 0,
      additionalDocumentsWritten: 0,
    }),
  );
});
test('small reports keep original excerpts and verdicts, including flaky passes', () => {
  const input = {
    ...failures(2, 'assertion failed'),
    'tests/flaky.test.mjs': { failed: false, flaky: true, firstError: 'first attempt' },
  };
  assert.deepEqual(capCheckReports(input), { reports: input, truncated: 0 });
  assert.deepEqual(checkFileSummary(input).counts, { total: 3, failed: 2, flaky: 1 });
});
test('a complete valid hosted run document stays within 256 KiB for 1,000 failures', async t => {
  const s = await checksFixture();
  const run = await s.activate((await s.enqueue(s.selection())).id, 1);
  const reports = failures(1000);
  const capped = capCheckReports(reports).reports;
  const terminal = { ...run, contractReports: capped, testFiles: checkFileSummary(capped) };
  hostedCheckRunSchema.parse(terminal);
  const row = [...s.tables.projectHostedCheckRuns.values()].find(row => row.runId === run.id);
  // Fake database validates the full real Convex document, not a partial fixture.
  await s.transaction(
    'report-cap-scale',
    { _handler: ctx => ctx.db.patch(row._id, { value: JSON.stringify(terminal) }) },
    {},
  );
  const saved = s.tables.projectHostedCheckRuns.get(row._id);
  const documentBytes = Buffer.byteLength(JSON.stringify(saved));
  const beforeBytes = Buffer.byteLength(
    JSON.stringify({
      ...row,
      value: JSON.stringify({ ...run, contractReports: reports, testFiles: checkFileSummary(reports) }),
    }),
  );
  assert(documentBytes <= 256 * 1024, `${documentBytes} byte run document`);
  for (const error of ['"'.repeat(2048), '\u0000'.repeat(2048)]) {
    const escaped = capCheckReports(failures(1000, error)).reports;
    const escapedRun = hostedCheckRunSchema.parse({
      ...run,
      contractReports: escaped,
      testFiles: checkFileSummary(escaped),
    });
    await s.transaction(
      'report-cap-escaped',
      { _handler: ctx => ctx.db.patch(row._id, { value: JSON.stringify(escapedRun) }) },
      {},
    );
    assert(Buffer.byteLength(JSON.stringify(s.tables.projectHostedCheckRuns.get(row._id))) <= 256 * 1024);
  }
  const meter = s.counts.at(-1);
  assert.equal(meter.documents, 0);
  assert.equal(meter.writes, 1);
  t.diagnostic(
    JSON.stringify({
      failedFiles: 1000,
      beforeBytes,
      documentBytes,
      calls: 1,
      documentsRead: meter.documents,
      documentsWritten: meter.writes,
    }),
  );
});

test('JSON escaping cannot amplify retained excerpts beyond 64 KiB', () => {
  const capped = capCheckReports(failures(1000, '\u0000'.repeat(2048)));
  const serializedBytes = Object.values(capped.reports).reduce(
    (n, r) => n + (r.firstError ? Buffer.byteLength(JSON.stringify(r.firstError)) - 2 : 0),
    0,
  );
  assert(serializedBytes <= checkReportExcerptBytes);
  assert.equal(capped.truncated, 1000);
});

test('signed callback completion caps excerpts and retains every failure name', async () => {
  const s = await checksFixture();
  const run = await s.activate((await s.enqueue(s.selection())).id, 1);
  await s.callback(s.shard(run, 0, 'failed'));
  const reports = failures(100),
    callback = s.complete(run, 'failed', { contractReports: reports });
  // A raw transaction exercises the real validators without the helper's stricter
  // 128 KiB total-write assertion (the original signed callback is also retained).
  const { receiveHostedCheckCallback } = await import(
    (await import('./convex-module.mjs')).moduleUrl('../convex/projectHostedCheckCallbacks.ts')
  );
  const result = await s.transaction(
    'capped-callback',
    {
      _handler: ctx =>
        receiveHostedCheckCallback(
          ctx,
          { projectId: s.projectId, callback, signature: s.sign(callback) },
          () => 'synthetic-check-collector-only',
        ),
    },
    {},
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.testFiles.failed.length, 100);
  assert.equal(result.testFiles.truncated, 68);
  assert.equal(Object.values(result.contractReports).filter(r => r.firstError).length, 32);
});

test('the first 32 failed files keep excerpts ahead of recovered flakes', () => {
  const input = {
    'tests/a-flaky.test.mjs': { failed: false, flaky: true, firstError: 'flaky assertion' },
    ...failures(32, 'failed assertion'),
  };
  const capped = capCheckReports(input);
  assert(
    Object.values(capped.reports)
      .filter(report => report.failed)
      .every(report => report.firstError === 'failed assertion'),
  );
  assert.equal(capped.reports['tests/a-flaky.test.mjs'].firstError, undefined);
  assert.equal(capped.truncated, 1);
});
