// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
  const [landing] = f.tables.projectHostedLandingRequests.values();
  const attempt = [...f.tables.projectHostedLandingAttempts.values()].find(
    row => row.attemptId === landing.attemptId,
  );
  assert.equal(record.retryCount, attempt.number, 'the failure retains its final attempt ordinal');
  assert(record.message.length <= log.FAILURE_MESSAGE_MAX);
  assert(Number.isInteger(record.elapsedMs) && record.elapsedMs >= 0);
  assert(Buffer.byteLength(JSON.stringify(row)) < 600, 'a failure row stays small');

  // The fixture's creation times count from its own clock: a window around the row's creation time.
  const from = new Date(row._creationTime - 86_400_000).toISOString(),
    to = new Date(row._creationTime + 60_000).toISOString();
  const report = JSON.parse(await f.tx('failureReport', health.report, { projectId: f.projectId, from, to }));
  assert.equal(report.failures, 1);
  assert.equal(report.complete, true);
  assert.deepEqual(report.failedLandings, { count: 1, retryCountReported: 1, retries: attempt.number });
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
  const [receipt] = f.tables.projectHostedAcceptances.values();
  const attempt = [...f.tables.projectHostedLandingAttempts.values()].find(
    row => row.attemptId === receipt.attemptId,
  );
  const { retryCount, checkReused } = receipt;
  assert.equal(retryCount, attempt.number);
  assert.equal(checkReused, false, 'a fresh check is recorded separately from missing evidence');
  assert(Buffer.byteLength(JSON.stringify({ retryCount, checkReused })) <= 128);
  const from = new Date(receipt._creationTime - 1).toISOString();
  const to = new Date(receipt._creationTime + 60_000).toISOString();
  const report = JSON.parse(await f.tx('failureReport', health.report, { projectId: f.projectId, from, to }));
  assert.deepEqual(report.acceptedLandings, {
    count: 1,
    complete: true,
    retryCountReported: 1,
    retries: attempt.number,
    checkReuseReported: 1,
    checksReused: 0,
  });
});

test('the health report keeps older accepted receipts and counts missing evidence separately', async t => {
  const { f } = await checking(t);
  const at = Date.parse('2026-11-21T00:00:00Z');
  for (const [index, fields] of [{}, { retryCount: 0 }, { retryCount: 3, checkReused: true }].entries()) {
    const id = `projectHostedAcceptances-${index}`;
    f.tables.projectHostedAcceptances.set(id, {
      _id: id,
      _creationTime: at + index,
      projectId: f.projectId,
      receiptId: randomUUID(),
      submissionId: randomUUID(),
      attemptId: randomUUID(),
      sequence: index,
      value: '{}',
      ...fields,
    });
  }
  const from = new Date(at).toISOString(),
    to = new Date(at + 3).toISOString();
  const report = JSON.parse(await f.tx('failureReport', health.report, { projectId: f.projectId, from, to }));
  assert.deepEqual(report.acceptedLandings, {
    count: 3,
    complete: true,
    retryCountReported: 2,
    retries: 3,
    checkReuseReported: 1,
    checksReused: 1,
  });
});

test('the health report bounds accepted receipt reads by bytes and keeps the failed-check view failure-only', async t => {
  const { f } = await checking(t);
  const at = Date.parse('2026-11-21T00:00:00Z');
  for (let i = 0; i < 600; i++) {
    const id = `projectHostedAcceptances-${i}`;
    f.tables.projectHostedAcceptances.set(id, {
      _id: id,
      _creationTime: at + i,
      projectId: f.projectId,
      receiptId: randomUUID(),
      submissionId: randomUUID(),
      attemptId: randomUUID(),
      sequence: i,
      value: JSON.stringify({ message: 'a'.repeat(1_500) }),
      retryCount: 1,
      checkReused: false,
    });
  }
  const input = {
    projectId: f.projectId,
    from: new Date(at).toISOString(),
    to: new Date(at + 600).toISOString(),
  };
  const out = JSON.parse(await f.tx('failureReport', health.report, input));
  assert.equal(out.complete, true, 'the failure stream had nothing more');
  assert.equal(out.acceptedLandings.complete, false, 'the acceptance stream reached its byte cap');
  assert(out.acceptedLandings.count > 0 && out.acceptedLandings.count < 500);
  const read = f.counts.at(-1);
  assert.equal(read.readRangesByTable.projectHostedAcceptances, 1);
  assert(read.readBytesByTable.projectHostedAcceptances <= 512 * 1024);
  await f.tx('failedChecks', health.report, { ...input, checks: { limit: 20 } });
  assert.equal(f.counts.at(-1).readRangesByTable.projectHostedAcceptances, undefined);

  f.extendContext(ctx => {
    const query = ctx.db.query.bind(ctx.db);
    ctx.db.query = table => {
      const result = query(table);
      if (table !== 'projectHostedAcceptances') return result;
      const paginate = result.paginate.bind(result);
      result.paginate = async options => ({
        ...(await paginate(options)),
        isDone: true,
        pageStatus: 'SplitRequired',
      });
      return result;
    };
  });
  const split = JSON.parse(await f.tx('healthReportSplit', health.report, input));
  assert.equal(
    split.acceptedLandings.complete,
    false,
    'a provider-required split still leaves unread receipts',
  );
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

// Item 44f2b109: one read lists failed checks with their causes (friction 3185b8bd: 82 audits took 82 reads).
const noise = await import(moduleUrl('../src/failure-noise.ts'));
const { checkFailureDetail, CHECK_FAILED_NEXT } = await import(moduleUrl('../src/check-failure-detail.ts'));

test('a failed check keeps its failing files, first error and step, not just the clipped message', () => {
  const report = error => ({ failed: true, ...(error ? { firstError: error } : {}) });
  const detail = log.failureDetail({
    testFiles: {
      counts: { failed: 8 },
      failed: ['a', 'b', 'c', 'd', 'e', 'f'].map((name, i) => ({
        file: `tests/${name}.test.mjs`,
        report: report(i === 0 ? 'cliAgentLandCpuMs 410 over   budget 300\nstack' : undefined),
      })),
    },
    error: { code: 'CHECK_FAILED', message: 'x' },
  });
  assert.deepEqual(
    detail.files,
    ['a', 'b', 'c', 'd', 'e'].map(name => `tests/${name}.test.mjs`),
  );
  assert.equal(detail.more, 3, 'six listed or counted files, eight failed: five kept, three more');
  assert.equal(detail.error, 'cliAgentLandCpuMs 410 over budget 300 stack');
  assert(Buffer.byteLength(JSON.stringify(detail)) < 600, 'the added detail stays a few hundred bytes');
  const step = log.failureDetail({
    error: {
      code: 'CHECK_FAILED',
      message: `The original exact check settled as failed. ${checkFailureDetail({}, { job: 'static', excerpt: 'error TS2322 in src/x.ts' })} ${CHECK_FAILED_NEXT}`,
    },
  });
  assert.deepEqual(step, { step: 'static', error: 'error TS2322 in src/x.ts' });
  assert.deepEqual(
    log.failureDetail({ error: { code: 'SOURCE_RETRY_EXHAUSTED', message: 'Failing: a.ts' } }),
    {},
  );
});

test('the message reader returns what the formatter wrote: files, first error and step (old rows)', () => {
  const sentence = checkFailureDetail(
    {
      testFiles: {
        counts: { failed: 3 },
        failed: [
          { file: 'tests/a.test.mjs', report: { failed: true, firstError: 'boom: 1 !== 2' } },
          { file: 'tests/b.test.mjs', report: { failed: true } },
        ],
      },
    },
    null,
    2,
  );
  assert.deepEqual(
    noise.messageDetail(`The original exact check settled as failed. ${sentence} Fix it in this Lane`),
    {
      files: ['tests/a.test.mjs', 'tests/b.test.mjs'],
      error: 'boom: 1 !== 2',
    },
  );
  assert.deepEqual(
    noise.messageDetail(
      `The exact check settled as failed. ${checkFailureDetail({}, { job: 'static', excerpt: 'lint: no-unused' })} Fix it in this Lane, save`,
    ),
    { step: 'static', error: 'lint: no-unused' },
  );
  // The settled message names one file: what follows is the next step or a flaky note, never a second file.
  const next = 'Fix it in this Lane, save, then run land --save again';
  const one = checkFailureDetail({
    testFiles: {
      counts: { failed: 1 },
      failed: [{ file: 'tests/a.test.mjs', report: { failed: true, firstError: 'boom' } }],
    },
  });
  assert.deepEqual(noise.messageDetail(`The exact check settled as failed. ${one} ${next}`), {
    files: ['tests/a.test.mjs'],
    error: 'boom',
  });
  assert.deepEqual(
    noise.messageDetail(
      `settled as failed. ${checkFailureDetail({ testFiles: { counts: { failed: 1 }, failed: [{ file: 'tests/a.test.mjs', report: { failed: true } }] } })} ${next}`,
    ),
    { files: ['tests/a.test.mjs'] },
    'a file with no first error is still listed, not dropped',
  );
  const flaky = noise.messageDetail(
    `settled as failed. Failing: tests/a.test.mjs (expected 1, got 2). Flaky, passed on retry: tests/b.test.mjs (page.goto: Timeout 30000ms exceeded). ${next}`,
  );
  assert.deepEqual(flaky, { files: ['tests/a.test.mjs'], error: 'expected 1, got 2' });
  assert.equal(
    noise.failureNoise({ code: 'CHECK_FAILED', ...flaky }),
    'real',
    'a flaky file that passed is not the cause',
  );
  // A static step that fails while a file passed on retry: the flaky note follows the step line with no period.
  const stepAndFlaky = noise.messageDetail(
    `settled as failed. ${checkFailureDetail(
      {
        testFiles: {
          counts: { failed: 0 },
          failed: [],
          flaky: [{ file: 'tests/b.test.mjs', report: { flaky: true, firstError: 'Test timed out' } }],
        },
      },
      { job: 'test (ubuntu-latest)', excerpt: 'Error: lint failed in src/a.ts' },
    )} ${next}`,
  );
  assert.deepEqual(stepAndFlaky, { step: 'test (ubuntu-latest)', error: 'Error: lint failed in src/a.ts' });
  assert.equal(noise.failureNoise({ code: 'CHECK_FAILED', ...stepAndFlaky }), 'real');
  assert.deepEqual(noise.messageDetail('The admission check settled; nothing named.'), {});
});

test('noise tags: runner, budget, flake, real, and unknown when nothing names a cause', () => {
  const tag = (code, detail) => noise.failureNoise({ code, ...detail });
  assert.equal(tag('CHECK_NOT_PASSED', {}), 'runner');
  assert.equal(tag('CONTRACT_OVER_BUDGET', {}), 'budget');
  assert.equal(
    tag('CHECK_FAILED', { files: ['tests/smoke-package.test.mjs'], error: 'cliAgentLandCpuMs 410 > 300' }),
    'budget',
    'the 11-19 smoke:package CPU budget failures',
  );
  assert.equal(
    tag('CHECK_FAILED', {
      files: ['tests/app-id-palette-browser.test.mjs'],
      error: 'page.goto: Timeout 30000ms exceeded',
    }),
    'flake',
    'the app-id-palette-browser flakes',
  );
  assert.equal(tag('CHECK_FAILED', { step: 'static', error: 'ENOSPC: no space left on device' }), 'runner');
  // 44f2b109 line 4: agent-weight CPU and perf-harness timing bars are budgets, not real failures.
  assert.equal(
    tag('CHECK_FAILED', {
      step: 'job 11 (static): smoke:package',
      error: 'cliAgentLandCpuMs: 612, ceiling 500',
    }),
    'budget',
  );
  assert.equal(
    tag('CHECK_FAILED', {
      files: ['tests/hosted-landing-overtake.test.mjs'],
      error: 'incident replay 70a9bd2f: global-risk A/C overtake meets the unchanged 1.5x solo timing bar',
    }),
    'budget',
  );
  assert.equal(
    tag('CHECK_FAILED', { step: 'job 11 (static): lint (oxlint)', error: 'Found 0 warnings and 1 error.' }),
    'real',
    'a lint error stays real',
  );
  assert.equal(tag('CHECK_FAILED', { files: ['tests/x.test.mjs'], error: 'expected 1, got 2' }), 'real');
  assert.equal(tag('CHECK_FAILED', {}), 'unknown');
});

test('a static step keeps its name and first error line, not the reproduce command (the empty smoke:package rows)', () => {
  const excerpt = (name, command, lines) =>
    `Failing job 11 (static): ${name} (reproduce: ${command}): ${lines.join(' ; ')}`;
  const message = lines =>
    `The original exact check settled as failed. ${excerpt('smoke:package', 'npm run smoke:package (node scripts/package-smoke.mjs)', lines)} Fix it in this Lane, save`;
  const ours = log.failureDetail({
    error: {
      code: 'CHECK_FAILED',
      message: message(['AssertionError: cliAgentLandCpuMs: 612, ceiling 500', 'at stack frame']),
    },
  });
  assert.deepEqual(ours, {
    step: 'job 11 (static): smoke:package',
    error: 'AssertionError: cliAgentLandCpuMs: 612, ceiling 500',
  });
  assert.equal(noise.failureNoise({ code: 'CHECK_FAILED', ...ours }), 'budget');
  // Colored output and a second failed step: neither the escapes nor the also-failed list reach the row.
  const colored = noise.messageDetail(
    `settled as failed. Failing job 3 (static): lint (oxlint) (reproduce: node scripts/oxc.mjs lint) (also failed: check): \u001b[38;2;225;80;80;1m×\u001b[0m no-unused-vars ; Found 1 error. Fix it in this Lane`,
  );
  assert.deepEqual(colored, { step: 'job 3 (static): lint (oxlint)', error: '× no-unused-vars' });
  // A step with no digest (one printed line) is its own error; a reproduce line clipped at the budget names no cause.
  assert.deepEqual(noise.stepDetail('job 2', 'llms-full.txt is 409868 bytes; the budget is 409600'), {
    step: 'job 2',
    error: 'llms-full.txt is 409868 bytes; the budget is 409600',
  });
  assert.deepEqual(noise.stepDetail('job 2', 'smoke:package (reproduce: npm run smoke:package (node scr'), {
    step: 'job 2: smoke:package',
  });
  assert(Buffer.byteLength(JSON.stringify(noise.stepDetail('job 11 (static)', 'x'.repeat(5000)))) < 400);
});

test('a smoke:package row stored without its error is re-read from its message, so the 11-17.. read splits right', () => {
  const stored = {
    schema: 1,
    kind: 'landing',
    code: 'CHECK_FAILED',
    message:
      'The original exact check settled as failed. Failing job 11 (static): smoke:package (reproduce: npm run smoke:package (node scripts/package-smoke.mjs)): AssertionError: cliAgentLandCpuMs: 612, ceiling 500 ; npm…',
    elapsedMs: 5,
    step: 'job 11 (static): smoke:package (reproduce: npm run smoke:package (node scripts/package-smoke.mjs)): ',
  };
  const out = health.failedChecks([{ _creationTime: 1, operationId: 'old', value: JSON.stringify(stored) }], {
    limit: 5,
    more: false,
  });
  assert.equal(out.checks[0].step, 'job 11 (static): smoke:package');
  assert.equal(out.checks[0].error, 'AssertionError: cliAgentLandCpuMs: 612, ceiling 500');
  assert.equal(out.checks[0].noise, 'budget');
});

test('failed checks page newest first with a cursor that loses and repeats nothing, and filter by tag', () => {
  const row = (minute, code, value, kind = 'landing') => ({
    _creationTime: Date.parse('2026-11-19T10:00:00Z') + minute * 60_000,
    operationId: `op${minute}`,
    value: JSON.stringify({ schema: 1, kind, code, message: 'm', elapsedMs: 1000, ...value }),
  });
  const rows = [
    row(9, 'CHECK_FAILED', { files: ['tests/a.test.mjs'], error: 'expected 1, got 2', retryCount: 0 }),
    row(8, 'SOURCE_RETRY_EXHAUSTED', {}, 'operation'),
    row(7, 'CHECK_FAILED', { files: ['tests/a.test.mjs', 'tests/b.test.mjs'], more: 2, error: 'timed out' }),
    row(6, 'LANDING_BATCH_LEAKED', {}),
    row(5, 'CHECK_NOT_PASSED', {}),
    row(4, 'CHECK_FAILED', { step: 'static: lint' }),
  ];
  const first = health.failedChecks(rows, { limit: 2, more: false });
  assert.deepEqual(
    first.checks.map(c => [c.operationId, c.noise]),
    [
      ['op9', 'real'],
      ['op7', 'flake'],
    ],
    'operations and other landing codes are not checks',
  );
  assert.equal(first.checks[1].more, 2);
  assert.equal(first.checks[0].retryCount, 0);
  assert.equal(first.checks[1].retryCount, undefined);
  assert.deepEqual(first.repeatedFiles, [{ file: 'tests/a.test.mjs', count: 2 }]);
  assert.deepEqual(first.noise, { runner: 0, budget: 0, flake: 1, real: 1, unknown: 0 });
  const rest = rows.filter(r => r._creationTime < Number(first.nextCursor));
  const second = health.failedChecks(rest, { limit: 2, more: false });
  assert.deepEqual(
    second.checks.map(c => c.operationId),
    ['op5', 'op4'],
  );
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    health.failedChecks(rows, { limit: 5, noise: 'runner', more: false }).checks.map(c => c.operationId),
    ['op5'],
  );
  assert.equal(
    health.failedChecks(rows.slice(0, 2), { limit: 5, more: true }).nextCursor,
    String(rows[1]._creationTime),
    'a scan that ended before the window did continues after its last row',
  );
});

test('the failed-checks read refuses a bad limit, cursor or tag and keeps the owner-only rule', async t => {
  const { f } = await checking(t);
  const at = Date.now(),
    window = { from: new Date(at - 86_400_000).toISOString(), to: new Date(at + 60_000).toISOString() };
  for (const checks of [
    { limit: 0 },
    { limit: 101 },
    { limit: 5, noise: 'bogus' },
    { limit: 5, cursor: 'x' },
  ])
    await assert.rejects(
      f.tx('badChecks', health.report, { projectId: f.projectId, ...window, checks }),
      /BAD_ARGUMENT/,
    );
  await assert.rejects(
    f.tx(
      'checksOther',
      health.report,
      { projectId: f.projectId, ...window, checks: { limit: 5 } },
      'stranger',
    ),
  );
});
