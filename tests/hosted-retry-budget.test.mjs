// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostedCheckRunSchema } from '../dist/hosted-check.js';
import { applyCheckRetryBudget } from '../dist/check-report-cap.js';
import { actionsCommandForCapabilities } from '../dist/hosted-actions-capabilities.js';
import { checksFixture, code } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const results = await import(moduleUrl('../convex/projectHostedActionsResults.ts'));

async function fixture(t, shardCount) {
  const prior = {
    CONVEX_SITE_URL: process.env.CONVEX_SITE_URL,
    FORGE_HOSTED_CHECK_KEY_SYNTHETIC: process.env.FORGE_HOSTED_CHECK_KEY_SYNTHETIC,
  };
  process.env.CONVEX_SITE_URL = 'https://forge.example';
  process.env.FORGE_HOSTED_CHECK_KEY_SYNTHETIC = 'synthetic-check-key';
  t.after(() => {
    for (const [key, value] of Object.entries(prior))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const s = await checksFixture();
  s.decorateContext(ctx => {
    ctx.scheduler = { runAfter: async () => 'synthetic-schedule', cancel: async () => {} };
  });
  const runner = {
    provider: 'github-actions',
    repository: 'synthetic/project',
    runsOn: 'ubuntu-latest',
    runtime: s.runner.runtime,
    environmentFingerprint: s.runner.environmentFingerprint,
  };
  await s.bindRepository(s.projectId, { repository: runner.repository, repoId: 123 });
  const config = await s.configure({ kind: 'runner', configuration: runner }, s.configuration.digest);
  const run = await s.activate(
    (await s.enqueue(s.selection({ expectedConfiguration: config.digest }))).id,
    shardCount,
  );
  run.executionId = '123';
  run.actions = {
    reservedAt: Date.now(),
    fence: run.fence,
    watchdog: null,
    outcome: 'accepted',
    workflowSha: 'a'.repeat(40),
  };
  hostedCheckRunSchema.parse(run);
  const row = [...s.tables.projectHostedCheckRuns.values()].find(row => row.runId === run.id);
  await s.transaction(
    'seed-actions',
    { _handler: ctx => ctx.db.patch(row._id, { value: JSON.stringify(run) }) },
    {},
  );
  const claims = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: 'https://forge.example',
    exp: Date.now() / 1000 + 300,
    nbf: Date.now() / 1000 - 30,
    iat: Date.now() / 1000 - 30,
    repository: runner.repository,
    workflow_ref: `${runner.repository}/.github/workflows/forge-check.yml@refs/heads/main`,
    workflow_sha: run.actions.workflowSha,
    ref: 'refs/heads/main',
    event_name: 'workflow_dispatch',
    run_id: run.executionId,
    run_attempt: '1',
    runner_environment: 'github-hosted',
  };
  const send = result =>
    s.transaction('retry-budget-result', results.result, {
      projectId: s.projectId,
      runId: run.id,
      claims: JSON.stringify(claims),
      result: JSON.stringify(result),
    });
  return { ...s, run, send };
}
const flaky = {
  durationMs: 1,
  failed: false,
  flaky: true,
  firstError: 'first failed',
  attempts: [
    { durationMs: 1, failed: true },
    { durationMs: 1, failed: false },
  ],
};

test('27 shards requesting flaky passes honour three per run with no extra calls or scans', async t => {
  const s = await fixture(t, 27),
    before = s.counts.length;
  const started = performance.now(),
    heap = process.memoryUsage().heapUsed;
  let terminal;
  for (let index = 0; index < 27; index++) {
    const result = { index, exitCode: 0, contractReports: { [`tests/shard-${index}.test.mjs`]: flaky } };
    terminal = await s.send(result);
    if (!index) {
      const replay = await s.send(result);
      assert.deepEqual(replay, terminal);
      await assert.rejects(s.send({ ...result, exitCode: 1 }), code('WORK_OPERATION_CHANGED'));
    }
  }
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.exitCode, 1);
  assert.deepEqual(terminal.testFiles.counts, { total: 27, failed: 24, flaky: 3 });
  const failed = Object.values(terminal.contractReports).filter(report => report.failed);
  assert.equal(failed.length, 24);
  assert(failed.every(report => report.firstError.includes('RETRY_BUDGET_EXCEEDED')));
  const meters = s.counts.slice(before).filter(m => m.name === 'retry-budget-result');
  assert.equal(meters.length, 29, '27 results, one replay, one changed-input refusal; no retry claim call');
  assert(meters.every(m => !m.touched.includes('projectHostedActionsResults') || m.documents < 40));
  const documentsRead = meters.reduce((n, m) => n + m.documents, 0),
    documentsWritten = meters.reduce((n, m) => n + m.writes, 0);
  assert(documentsRead <= 29 * 40);
  assert(documentsWritten <= 27 * 16);
  t.diagnostic(
    JSON.stringify({
      shards: 27,
      honours: 3,
      calls: meters.length,
      documentsRead,
      documentsWritten,
      maxRead: Math.max(...meters.map(m => m.documents)),
      maxWrites: Math.max(...meters.map(m => m.writes)),
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      heapGrowthBytes: process.memoryUsage().heapUsed - heap,
      elapsedMs: performance.now() - started,
      idleConvexCalls: 0,
    }),
  );
});
test('fail-twice stays failed and a retry pass within budget stays flaky', () => {
  const persistent = {
    ...flaky,
    failed: true,
    flaky: false,
    attempts: [
      { durationMs: 1, failed: true },
      { durationMs: 1, failed: true },
    ],
  };
  const reports = applyCheckRetryBudget({
    'tests/persistent.test.mjs': persistent,
    'tests/flake.test.mjs': flaky,
  });
  assert.equal(reports['tests/persistent.test.mjs'].failed, true);
  assert.equal(reports['tests/flake.test.mjs'].flaky, true);
  assert.equal(reports['tests/flake.test.mjs'].failed, false);
});
test('new runner omits truncation metadata for old servers, including servers with the old summary capability', () => {
  const command = {
    kind: 'result',
    result: {
      index: 0,
      exitCode: 1,
      testFiles: {
        counts: { total: 1000, failed: 1000, flaky: 0 },
        failed: [],
        flaky: [],
        truncated: 968,
      },
    },
  };
  assert(!('testFiles' in actionsCommandForCapabilities(command, []).result));
  const old = actionsCommandForCapabilities(command, ['results.testFiles']);
  assert(!('truncated' in old.result.testFiles));
  assert.equal(
    actionsCommandForCapabilities(command, ['results.testFiles', 'results.testFiles.truncated']).result
      .testFiles.truncated,
    968,
  );
});

test('1,000 failures across 27 old-runner shards retain every name within the run document budget', async t => {
  const s = await fixture(t, 27),
    before = s.counts.length;
  const reports = Object.fromEntries(
    Array.from({ length: 1000 }, (_, i) => [
      `tests/synthetic-${String(i).padStart(4, '0')}.test.mjs`,
      { durationMs: 10, failed: true, firstError: 'x'.repeat(2048) },
    ]),
  );
  const entries = Object.entries(reports);
  let run;
  for (let index = 0; index < 27; index++)
    run = await s.send({
      index,
      exitCode: 1,
      contractReports: Object.fromEntries(entries.slice(index * 38, (index + 1) * 38)),
    });
  assert.equal(run.status, 'failed');
  assert.deepEqual(Object.keys(run.contractReports).sort(), Object.keys(reports).sort());
  assert.equal(run.testFiles.failed.length, 1000);
  assert.equal(run.testFiles.truncated, 968);
  const row = [...s.tables.projectHostedCheckRuns.values()].find(row => row.runId === run.id);
  const documentBytes = Buffer.byteLength(JSON.stringify(row));
  assert(documentBytes <= 256 * 1024, `${documentBytes} bytes`);
  const meters = s.counts.slice(before);
  assert.equal(meters.length, 27);
  t.diagnostic(
    JSON.stringify({
      failedFiles: 1000,
      documentBytes,
      calls: meters.length,
      documentsRead: meters.reduce((n, m) => n + m.documents, 0),
      documentsWritten: meters.reduce((n, m) => n + m.writes, 0),
      maxRead: Math.max(...meters.map(m => m.documents)),
      maxWrites: Math.max(...meters.map(m => m.writes)),
    }),
  );
});
