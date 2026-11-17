// SPDX-License-Identifier: Apache-2.0
// Item 2c420916: the failure log and on-demand health report. A failed landing appends exactly one bounded,
// scrubbed row in the mutation that settles it (a replayed settle adds none); a landing that passes writes
// nothing; the report counts by code in one bounded read; rows expire after 30 days.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finishFixture, desired } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { synthetic } from './hosted-revert-fixture.mjs';

const log = await import(moduleUrl('../convex/projectFailureLog.ts'));
const health = await import(moduleUrl('../convex/projectFailureReport.ts'));

const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function checking(t) {
  const f = await finishFixture(t);
  const command = {
    operationId: randomUUID(),
    authorityEpoch: 1,
    composeOperationId: f.selection.request.operationId,
    after: null,
    check: f.request().check,
  };
  await f.tx('desiredSubmit', desired.submit, { projectId: f.projectId, request: JSON.stringify(command) });
  for (let n = 0; !f.tables.projectHostedCheckRuns.size; n++) {
    assert(n < 30);
    await f.execute();
  }
  const [row] = f.tables.projectHostedCheckRuns.values();
  return { f, active: await f.rawChecks.activate(JSON.parse(row.value).id), command };
}
const rows = f => [...f.tables.projectFailures.values()];

test('a failed landing writes one scrubbed failure row; the health report counts it by code', async t => {
  const { f, active, command } = await checking(t);
  for (let i = 0; i < active.plan.shardCount; i++)
    await f.rawChecks.callback(f.rawChecks.shard(active, i, i === 0 ? 'failed' : 'passed'));
  await f.rawChecks.callback(f.rawChecks.complete(active, 'failed'));
  await f.drain();
  const [row, ...extra] = rows(f);
  assert(row, 'the failed landing is in the log');
  assert.equal(extra.length, 0, 'one row per failed landing, however many settles replay');
  assert.equal(row.operationId, command.operationId);
  const record = JSON.parse(row.value);
  assert.equal(record.kind, 'landing');
  assert.equal(record.code, 'CHECK_FAILED');
  assert(record.message.length <= log.FAILURE_MESSAGE_MAX);
  assert(Number.isInteger(record.elapsedMs) && record.elapsedMs >= 0);
  assert(Buffer.byteLength(JSON.stringify(row)) < 600, 'a failure row stays small');

  // The fixture's creation times count from its own clock: a window around the row's creation time.
  const from = new Date(row._creationTime - 86_400_000).toISOString(),
    to = new Date(row._creationTime + 60_000).toISOString();
  const report = JSON.parse(await f.tx('failureReport', health.report, { projectId: f.projectId, from, to }));
  assert.equal(report.failures, 1);
  assert.equal(report.complete, true);
  assert.deepEqual(
    report.codes.map(({ code, kind, count }) => ({ code, kind, count })),
    [{ code: 'CHECK_FAILED', kind: 'landing', count: 1 }],
  );
  assert.equal(report.codes[0].last.operationId, command.operationId);
  assert.equal(report.days.length, 1);
  await assert.rejects(
    f.tx('failureReportOther', health.report, { projectId: f.projectId, from, to }, 'stranger'),
    'only the owner or a maintainer reads the report',
  );
});

test('a landing that passes writes nothing to the failure log', async t => {
  const { f, active } = await checking(t);
  await f.rawChecks.pass(active);
  await f.drain();
  assert.equal(rows(f).length, 0);
});

test('failure messages keep no URL query, token or home folder name', () => {
  const text = log.sanitizeFailureMessage(
    // forge-path-fixture: synthetic
    'Upload to https://r2.example/b/k?X-Amz-Signature=abc&X-Amz-Credential=x failed\n  for /Users/someone/work with ghp_abcdefghijklmnop1234 and Bearer eyJabcdefgh.ijklmnop.qrst',
  );
  assert(!/X-Amz|ghp_|eyJ|someone|\n/.test(text), text);
  assert.match(text, /https:\/\/r2\.example\/b\/k failed for ~\/work/);
  assert.equal(log.sanitizeFailureMessage('x'.repeat(1000)).length, log.FAILURE_MESSAGE_MAX);
});

test('the report groups by kind and code, newest message last, and says when the window held more', () => {
  const row = (at, code, elapsedMs, operationId = randomUUID(), kind = 'operation') => ({
    _creationTime: Date.parse(at),
    operationId,
    value: JSON.stringify({ schema: 1, kind, code, message: `${code} at ${at}`, elapsedMs }),
  });
  const report = health.failureReport(
    [
      row('2026-11-02T10:00:00Z', 'SOURCE_RETRY_EXHAUSTED', 9000, 'newest'),
      row('2026-11-01T10:00:00Z', 'SOURCE_RETRY_EXHAUSTED', 1000),
      row('2026-11-01T09:00:00Z', 'SOURCE_RETRY_EXHAUSTED', null),
      row('2026-11-01T08:00:00Z', 'CHECK_FAILED', 4000, 'landing', 'landing'),
    ],
    { from: '2026-11-01T00:00:00.000Z', to: '2026-11-03T00:00:00.000Z' },
    false,
  );
  assert.equal(report.complete, false);
  assert.equal(report.failures, 4);
  const [source, check] = report.codes;
  assert.deepEqual(
    [source.code, source.count, source.medianElapsedMs, source.firstAt, source.last.operationId],
    ['SOURCE_RETRY_EXHAUSTED', 3, 5000, '2026-11-01T09:00:00.000Z', 'newest'],
  );
  assert.deepEqual([check.kind, check.count], ['landing', 1]);
  assert.deepEqual(report.days, [
    { day: '2026-11-01', count: 3 },
    { day: '2026-11-02', count: 1 },
  ]);
  assert.equal(health.FAILURE_REPORT_ROWS, 500);
});
