// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractTimingReader } from '../dist/contract-test-timings.js';
import { checkFileSummary } from '../dist/check-file-summary.js';
import { compactCheckText } from '../dist/check-compact-output.js';
import { summarizeCheckLines } from '../dist/check-report-summary.js';
import { semanticReportsSchema } from '../dist/intent-semantic-conflict.js';
import { runReceipt } from '../dist/agent-receipts.js';
import { testReports } from '../dist/check-test-report.js';
import { testExecutionVerdicts } from '../dist/check-test-verdicts.js';

const marker = report => '__FORGE_TESTS__' + JSON.stringify(report) + '\n';
function fixture(t, kinds) {
  const root = mkdtempSync(join(tmpdir(), 'forge-file-flakes-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const files = kinds.map((kind, index) => {
    const path = join(root, `${kind}-${index}.mjs`);
    writeFileSync(
      path,
      `
      import test from 'node:test';
      import assert from 'node:assert/strict';
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      const countPath = ${JSON.stringify(path + '.count')};
      const count = existsSync(countPath) ? Number(readFileSync(countPath)) + 1 : 1;
      writeFileSync(countPath, String(count));
      ${kind === 'timeout' ? 'if (count === 1) while (true) {}' : ''}
      test('result', () => assert.ok(${kind === 'always' ? 'false' : kind === 'flake' ? 'count > 1' : 'true'}, 'first assertion ' + '🙂'.repeat(3000)));
    `,
    );
    return path;
  });
  return { files, counts: () => files.map(file => Number(readFileSync(file + '.count'))) };
}
async function run(files, maxRetries = 3, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      FORGE_TEST_EVENTS: '1',
      FORGE_TEST_WORKERS: '2',
      FORGE_TEST_MAX_RETRIES: String(maxRetries),
      FORGE_TEST_FILE_TIMEOUT_MS: String(timeout),
    };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['scripts/test-files.mjs', ...files], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', chunk => {
        text += chunk;
      });
    child.on('error', reject);
    child.on('close', code =>
      resolve({
        code,
        text,
        reports: [...text.matchAll(/^__FORGE_TESTS__(.+)$/gm)].map(match => JSON.parse(match[1])),
      }),
    );
  });
}

test('fail once passes the check, reports flakiness and both attempt timings, even after compaction', async t => {
  const f = fixture(t, ['flake', 'clean']);
  const result = await run(f.files);
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(f.counts(), [2, 1]);
  assert.match(result.text, /Flaky test file:/);
  assert.match(result.text, /# fail 0/);
  const report = result.reports.find(report => report.flaky);
  assert.ok(report.durationMs > 0 && report.retry.durationMs > 0);
  assert.match(report.retry.firstError, /first assertion/);
  assert.ok(Buffer.byteLength(report.retry.firstError) <= 2048);
  const retained = summarizeCheckLines(compactCheckText(result.text).split('\n'));
  const reader = new ContractTimingReader();
  reader.accept(summarizeCheckLines(compactCheckText(retained).split('\n')));
  const summary = checkFileSummary(reader.reports);
  assert.equal(summary.counts.flaky, 1);
  assert.equal(summary.counts.failed, 0);
  assert.equal(summary.flaky[0].report.attempts.length, 2);
  const reports = testReports(retained.split('\n'));
  const verdicts = testExecutionVerdicts(
    {
      kind: 'result',
      executions: [
        { executionId: 'same-source', index: 0, attempt: 0, exitCode: 0, tests: reports },
        { executionId: 'static', index: 1, attempt: 0, exitCode: 0 },
      ],
    },
    [f.files],
  );
  assert.equal(verdicts.unknownFailure, false);
  assert.ok(verdicts.verdicts.some(item => item.verdict === 'flake'));
});

test('persistent failures run twice, while four failures exceed the default budget and run only once', async t => {
  const persistent = fixture(t, ['always']);
  const result = await run(persistent.files);
  assert.equal(result.code, 1);
  assert.deepEqual(persistent.counts(), [2]);
  assert.equal(result.reports[0].flaky, false);
  const over = fixture(t, ['flake', 'flake', 'flake', 'flake']);
  const blocked = await run(over.files);
  assert.equal(blocked.code, 1);
  assert.deepEqual(over.counts(), [1, 1, 1, 1]);
  assert.match(blocked.text, /4 failed files; limit 3; no retries/);
  assert.ok(blocked.reports.every(report => !report.retry));
});

test('timeouts retain the ceiling on both attempts, retry only within budget, and retain file-level flake evidence', async t => {
  const f = fixture(t, ['timeout']);
  const result = await run(f.files, 1, 3000);
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(f.counts(), [2]);
  assert.equal(result.reports[0].retry.complete, false);
  assert.match(result.reports[0].retry.firstError, /timeout/);
  const verdicts = testExecutionVerdicts(
    {
      kind: 'result',
      executions: [
        {
          executionId: 'same-source',
          index: 0,
          attempt: 0,
          exitCode: 0,
          tests: Object.fromEntries(result.reports.map(report => [report.file, report])),
        },
        { executionId: 'static', index: 1, attempt: 0, exitCode: 0 },
      ],
    },
    [f.files],
  );
  assert.equal(verdicts.unknownFailure, false);
  assert.ok(
    verdicts.verdicts.some(item => item.test.endsWith('[file execution]') && item.verdict === 'flake'),
  );
  const noRetry = fixture(t, ['timeout']);
  assert.equal((await run(noRetry.files, 0, 3000)).code, 1);
  assert.deepEqual(noRetry.counts(), [1]);
});

test('every failed file survives missing/incomplete reports and summarized empty results; file counts differ from shard counts', () => {
  const reader = new ContractTimingReader();
  const text =
    ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/c.test.mjs', 'tests/d.test.mjs']
      .map(file => `# Failed test file: ${file}\n`)
      .join('') +
    marker({
      file: 'tests/a.test.mjs',
      complete: true,
      durationMs: 10,
      results: [{ name: 'assertion', passed: false }],
      firstError: 'first error',
    }) +
    marker({
      file: 'tests/b.test.mjs',
      complete: false,
      durationMs: 20,
      results: [],
      firstError: 'timeout',
    }) +
    marker({
      file: 'tests/pass.test.mjs',
      complete: true,
      durationMs: 30,
      results: [],
      counts: { total: 12, failed: 0 },
    });
  for (let i = 0; i < text.length; i += 19) reader.accept(text.slice(i, i + 19));
  assert.equal(checkFileSummary(reader.reports).counts.failed, 4);
  assert.equal(
    reader.timings['tests/b.test.mjs'],
    undefined,
    'incomplete files never supply contract timings',
  );
  assert.equal(reader.reports['tests/a.test.mjs'].firstError, 'first error');
  assert.equal(reader.reports['tests/b.test.mjs'].firstError, 'timeout');
  assert.equal(reader.reports['tests/pass.test.mjs'].failed, false);
  assert.deepEqual(semanticReportsSchema.parse(reader.reports), reader.reports);
});

test('dogfood-sized reports and CLI receipts need no Convex calls or log reads', t => {
  const reader = new ContractTimingReader();
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  for (let i = 0; i < 600; i++)
    reader.accept(
      marker({
        file: `tests/synthetic-${i}.test.mjs`,
        complete: true,
        durationMs: 10,
        results: [{ name: 'contract', passed: i >= 4 }],
        ...(i < 4 ? { firstError: 'synthetic assertion' } : {}),
      }),
    );
  const summary = checkFileSummary(reader.reports);
  assert.deepEqual(summary.counts, { total: 600, failed: 4, flaky: 0 });
  const heapGrowth = process.memoryUsage().heapUsed - before;
  assert.ok(heapGrowth < 32 * 1024 * 1024);
  t.diagnostic(
    JSON.stringify({
      files: 600,
      failed: 4,
      additionalConvexCalls: 0,
      additionalDocumentsRead: 0,
      additionalDocumentsWritten: 0,
      reportBytes: Buffer.byteLength(JSON.stringify(reader.reports)),
      heapGrowthBytes: heapGrowth,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      elapsedMs: performance.now() - started,
    }),
  );
  const receipt = runReceipt({
    id: 'synthetic',
    backend: { fileReports: reader.reports },
    check: { env: [], credentials: [] },
    environment: {},
    status: 'failed',
    details: 'failed',
  });
  assert.deepEqual(receipt.testFiles, summary);
  // Pure synchronous readers/receipts have no transport or persistence dependency.
  assert.equal(Buffer.byteLength(JSON.stringify(reader.reports)) < 128 * 1024, true);
});

test('first errors use the output redactor before being included in hosted results', () => {
  const reader = new ContractTimingReader({
    secrets: ['synthetic-sensitive-value'],
    paths: ['/private/synthetic'],
  });
  reader.accept(
    marker({
      file: 'tests/redaction.test.mjs',
      complete: true,
      durationMs: 10,
      failed: true,
      results: [],
      firstError:
        'synthetic-sensitive-value at /private/synthetic/file; Bearer synthetic-credential; ' +
        '🙂'.repeat(3000),
    }),
  );
  const error = reader.reports['tests/redaction.test.mjs'].firstError;
  assert.ok(Buffer.byteLength(error) <= 2048);
  assert.ok(!error.includes('synthetic-sensitive-value'));
  assert.ok(!error.includes('/private/synthetic'));
  assert.ok(!error.includes('synthetic-credential'));
});
