// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readHostedMetricPages } from '../dist/self-metrics-hosted-pages.js';
import { metricsSurface } from '../dist/self-metrics-surface.js';
import { formatMetrics, formatMetricReport } from '../dist/self-metrics-format.js';
import { runFlakes } from '../dist/self-metrics-flakes.js';
import { nameFlakeIssues, flakeIssueLookups } from '../dist/self-metrics-flake-issues.js';
import { fixture, period, at } from './self-metrics-hosted-fixture.mjs';

const attempts = [
  { durationMs: 1200, failed: true },
  { durationMs: 900, failed: false },
];
const flakyReport = { failed: false, flaky: true, attempts, firstError: 'ERR_ASSERTION false !== true' };
const realFailure = { failed: true, flaky: true, attempts, firstError: 'always broken' };

test('runFlakes lists recovered files only; a failed file is never a flake; caps keep the true total', () => {
  assert.equal(runFlakes({ contractReports: { 'tests/ok.test.mjs': { failed: false } } }), undefined);
  const one = runFlakes({
    executionId: 'exec-1',
    contractReports: { 'tests/a.test.mjs': flakyReport, 'tests/b.test.mjs': realFailure },
  });
  assert.deepEqual(
    one.files.map(f => f.file),
    ['tests/a.test.mjs'],
  );
  assert.equal(one.total, 1);
  assert.equal(one.executionId, 'exec-1');
  assert.deepEqual(one.files[0].attempts, attempts);
  const many = Object.fromEntries(
    Array.from({ length: 11 }, (_, i) => [
      `tests/f${String(i).padStart(2, '0')}.test.mjs`,
      { failed: false, flaky: true, firstError: 'x'.repeat(2000) },
    ]),
  );
  const capped = runFlakes({ contractReports: many });
  assert.equal(capped.total, 11);
  assert.equal(capped.files.length, 8);
  assert.equal(capped.files[0].file, 'tests/f00.test.mjs');
  assert.equal(capped.files[0].firstError.length, 512);
  // The compact testFiles summary (no first error) is the fallback.
  const compact = runFlakes({
    testFiles: { flaky: [{ file: 'tests/c.test.mjs', report: { failed: false, flaky: true } }] },
  });
  assert.deepEqual(compact.files, [{ file: 'tests/c.test.mjs' }]);
});

test('weekly flaky list comes from the existing runs page: no extra call, failures and clean runs excluded', async () => {
  const f = fixture();
  f.run('run-clean', at(10), at(14), 600, { contractReports: { 'tests/x.test.mjs': { failed: false } } });
  f.run('run-1', at(20), at(24), 600, {
    executionId: 'exec-1',
    contractReports: { 'tests/a.test.mjs': flakyReport, 'tests/b.test.mjs': realFailure },
  });
  f.run('run-2', at(30), at(34), 600, {
    executionId: 'exec-2',
    testFiles: {
      counts: { total: 3, failed: 0, flaky: 2 },
      failed: [],
      flaky: [
        { file: 'tests/a.test.mjs', report: { failed: false, flaky: true, attempts } },
        { file: 'tests/z.test.mjs', report: { failed: false, flaky: true } },
      ],
    },
  });
  const before = f.meter.calls;
  const { records } = await readHostedMetricPages(f.query, period);
  assert.equal(f.meter.calls - before, 10, 'same eight streams, bill page and placement page as before');
  assert.equal(records.flakesUnprojected, undefined);
  const result = metricsSurface(records, period);
  const flakes = result.totals.flakes;
  assert.equal(flakes.flakyRuns, 2);
  assert.equal(flakes.filesTotal, 2);
  assert.deepEqual(
    flakes.files.map(row => [row.file, row.runs]),
    [
      ['tests/a.test.mjs', 2],
      ['tests/z.test.mjs', 1],
    ],
  );
  const a = flakes.files[0];
  assert.deepEqual(a.runIds, ['run-1', 'run-2']);
  assert.equal(a.search, 'a.test.mjs');
  assert.equal(a.lastExecutionId, 'exec-2');
  assert.equal(
    a.lastError,
    'ERR_ASSERTION false !== true',
    'a later run without an error keeps the earlier one',
  );
  assert.equal(flakes.partial, false);
  const text = formatMetrics(result);
  assert.match(text, /Flaky files \(recovered on retry, never a clean pass\): 2 files in 2 runs/);
  assert.match(text, /tests\/a\.test\.mjs ×2/);
  assert.match(text, /"search":"a\.test\.mjs"[^\n]*else file an Issue today/);
  assert.doesNotMatch(text, /tests\/b\.test\.mjs/, 'a real failure is not listed as a flake');
  assert.match(formatMetricReport(result), /tests\/a\.test\.mjs ×2/);
  // The run window decides membership.
  const later = metricsSurface(records, { from: '2026-11-03T00:00:00.000Z', to: period.to });
  assert.equal(later.totals.flakes.files.length, 0);
  assert.match(formatMetrics(later), /Flaky files \(recovered on retry\): none in window/);
});

test('a deployment without the flaky projection reports a partial list, not an empty clean one', async () => {
  const f = fixture();
  f.run('run-1', at(20), at(24), 600, { contractReports: { 'tests/a.test.mjs': flakyReport } });
  const old = async (name, args) => {
    const raw = JSON.parse(await f.query(name, args));
    if (name === 'projectSelfMetrics:page' && args.stream === 'runs')
      for (const row of raw.page) delete row.flaky;
    return JSON.stringify(raw);
  };
  const { records } = await readHostedMetricPages(old, period);
  assert.equal(records.flakesUnprojected, true);
  const flakes = metricsSurface(records, period).totals.flakes;
  assert.equal(flakes.partial, true);
  assert.match(flakes.gaps[0], /deploy projectSelfMetrics/);
  assert.match(formatMetrics(metricsSurface(records, period)), /none in window · partial/);
});

test('--flake-issues names the existing Issue, flags look-alikes, or says to file; bounded lookups', async () => {
  const rows = ['a', 'b', 'c'].map(name => ({
    file: `tests/${name}.test.mjs`,
    runs: 1,
    runIds: ['r'],
    firstAt: 't',
    lastAt: 't',
    search: `${name}.test.mjs`,
  }));
  const seen = [];
  const query = async (name, args) => {
    assert.equal(name, 'projectHostedPlanningSearch:search');
    seen.push(args);
    const item = (id, title, status, body) => ({ id, title, status, body });
    if (args.text.startsWith('a '))
      return JSON.stringify({
        items: [
          item('closed-1111', 'old', 'closed', 'a.test.mjs flaked'),
          item('open-22222', 'flake a', 'open', 'file a.test.mjs'),
        ],
      });
    if (args.text.startsWith('b '))
      return JSON.stringify({ items: [item('near-33333', 'other', 'open', 'unrelated')] });
    return JSON.stringify({ items: [] });
  };
  assert.equal(await nameFlakeIssues(query, rows), 3);
  assert.deepEqual(
    rows[0].issue,
    { id: 'open-22222', title: 'flake a', status: 'open' },
    'active Issue wins over closed',
  );
  assert.deepEqual(rows[1].issue, { possible: [{ id: 'near-33333', title: 'other' }] });
  assert.equal(rows[2].issue, null);
  assert.ok(seen.every(args => args.kind === 'issue' && args.status === 'all' && args.limit === 5));
  const many = Array.from({ length: 25 }, (_, i) => ({
    ...rows[2],
    file: `tests/m${i}.test.mjs`,
    search: `m${i}.test.mjs`,
    issue: undefined,
  }));
  assert.equal(await nameFlakeIssues(async () => JSON.stringify({ items: [] }), many), flakeIssueLookups);
  const text = formatMetrics({
    ...metricsSurface({ moves: [], submissions: [], runs: [], receipts: [], gaps: [] }, period),
    totals: {
      ...metricsSurface({ moves: [], submissions: [], runs: [], receipts: [], gaps: [] }, period).totals,
      flakes: { files: rows, filesTotal: 3, flakyRuns: 1, omittedPerRun: 0, partial: false, gaps: [] },
    },
  });
  assert.match(text, /Issue open-222 \(open\): comment these run ids/);
  assert.match(text, /check before filing: near-333 other/);
  assert.match(text, /no Issue found: file one today/);
});
