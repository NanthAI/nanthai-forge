// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readHostedMetricPages } from '../dist/self-metrics-hosted-pages.js';
import { metricsSurface } from '../dist/self-metrics-surface.js';
import { parseRecordBill } from '../dist/metrics-bill-cli.js';
import { formatMetrics } from '../dist/self-metrics-format.js';
import { fixture, period, seam, at } from './self-metrics-hosted-fixture.mjs';

const convexArgs = [
  'root',
  '--provider',
  'convex',
  '--from',
  '2026-10-27',
  '--to',
  '2026-10-30T10:35:00Z',
  '--billed-usd',
  '40',
  '--usage',
  'egress-gb=200,db-io-gb=20',
  '--rate',
  'egress-gb=0.1,db-io-gb=0.5',
];
const bill = args => parseRecordBill(args).bill;
const code = expected => error =>
  (error.code ?? (typeof error.data === 'string' ? JSON.parse(error.data) : error.data)?.code) === expected;

test('record-bill parses owner input deterministically and refuses malformed amounts', () => {
  const first = bill(convexArgs);
  assert.equal(first.operationId, bill(convexArgs).operationId, 'identical input reconciles');
  assert.equal(first.periodFrom, '2026-10-27T00:00:00.000Z');
  assert.deepEqual(first.usage, { 'egress-gb': 200, 'db-io-gb': 20 });
  assert.equal(first.listUsd, null);
  assert.notEqual(first.operationId, bill(convexArgs.with(8, '41')).operationId);
  const actions = bill([
    'root',
    '--provider',
    'actions',
    '--from',
    '2026-10-01',
    '--to',
    '2026-11-01',
    '--billed-usd',
    '0',
  ]);
  assert.equal(actions.provider, 'github-actions');
  for (const bad of [
    convexArgs.with(8, '-1'),
    convexArgs.with(8, ''),
    convexArgs.with(2, 'aws'),
    convexArgs.with(10, 'egress-gb=1,egress-gb=2'),
    convexArgs.with(10, 'Egress=1'),
    [...convexArgs, '--surprise', 'x'],
    convexArgs.with(6, '2026-10-26'),
    convexArgs.slice(0, 7),
  ])
    assert.throws(
      () => bill(bad),
      error => code('BAD_ARGUMENT')(error) || error.name === 'ZodError',
    );
});

test('owner bills are idempotent, owner-only, paged in one call, and give per-period $/landing and estimator error', async () => {
  const f = fixture();
  f.put(
    'projectContributors',
    { projectId: 'project', contributor: 'maintainer', agentGuidanceMaintainer: true },
    seam,
  );
  // Two landings inside the Convex period; one after it.
  f.landing('a', at(60), at(62));
  f.landing('b', at(120), at(122));
  f.landing('late', at(4000), at(4002));
  f.run('run-1', at(10), at(14), 600);
  f.run('run-2', at(20), at(22), 300);
  const convex = bill(convexArgs);
  const actions = bill([
    'root',
    '--provider',
    'github-actions',
    '--from',
    '2026-10-01',
    '--to',
    '2026-11-01',
    '--billed-usd',
    '0',
    '--rate',
    'runner-minute=0.008',
  ]);
  const recorded = await f.recordBill(convex);
  assert.equal(recorded.replayed, false);
  assert.equal(f.meter.writes, 1);
  assert.equal((await f.recordBill(convex)).replayed, true);
  assert.equal(f.meter.writes, 1, 'replay writes nothing');
  await assert.rejects(f.recordBill({ ...convex, billedUsd: 41 }), code('WORK_OPERATION_CHANGED'));
  f.actor('maintainer');
  await assert.rejects(f.recordBill(actions), code('PROJECT_UNAVAILABLE'));
  f.actor('stranger');
  await assert.rejects(
    f.query('projectSelfMetricBills:page', { ...period, cursor: null }),
    code('PROJECT_UNAVAILABLE'),
  );
  f.actor('owner');
  await f.recordBill(actions);
  assert.equal(f.meter.writes, 2);

  const writes = f.meter.writes,
    calls = f.meter.calls;
  const { records } = await readHostedMetricPages(f.query, period);
  assert.equal(
    f.meter.calls - calls,
    10,
    'eight metric streams, one bill page and one bytes-by-location page',
  );
  assert.equal(f.meter.writes, writes, 'reading metrics writes nothing');
  const result = metricsSurface(records, period);
  const periods = result.totals['5.8'].periods;
  const convexRow = periods.find(row => row.provider === 'convex');
  assert.equal(convexRow.landings, 2);
  assert.equal(convexRow.billedUsdPerLanding, 20);
  assert.equal(convexRow.estimateUsd, 30);
  assert.equal(convexRow.estimateSource, 'owner-usage');
  assert.equal(convexRow.estimatorError, -0.25);
  const actionsRow = periods.find(row => row.provider === 'github-actions');
  assert.equal(actionsRow.estimateSource, 'forge-counter');
  assert.equal(actionsRow.usage['runner-minute'], 15);
  assert.equal(actionsRow.estimateUsd, 15 * 0.008);
  assert.equal(actionsRow.estimatorError, null, 'zero bill: error undefined, not zero');
  assert.equal(actionsRow.estimatorErrorBasis, 'Undefined: recorded bill is zero.');
  assert.match(formatMetrics(result), /convex 2026-10-27\.\.2026-10-30: \$40 billed, \$20\/landing/);

  // A correction for the same provider and period start replaces the earlier figure.
  f.put(
    'projectSelfMetricBills',
    {
      projectId: 'project',
      operationId: 'c'.repeat(64),
      provider: 'convex',
      periodFrom: convex.periodFrom,
      actor: 'owner',
      at: '2099-01-01T00:00:00.000Z',
      digest: 'd',
      value: JSON.stringify({ ...convex, operationId: 'c'.repeat(64), billedUsd: 60 }),
    },
    seam,
  );
  const corrected = metricsSurface((await readHostedMetricPages(f.query, period)).records, period);
  const rows = corrected.totals['5.8'].periods.filter(row => row.provider === 'convex');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].billedUsd, 60);
});

test('old servers without the bill module report a gap, never a zero bill', async () => {
  const f = fixture();
  f.landing('a', at(60), at(62));
  const { records } = await readHostedMetricPages(async (name, args) => {
    if (name === 'projectSelfMetricBills:page')
      throw new Error("Could not find public function for 'projectSelfMetricBills:page'");
    return f.query(name, args);
  }, period);
  const result = metricsSurface(records, period);
  assert.deepEqual(result.totals['5.8'].periods, []);
  assert(
    result.totals['5.8'].gaps.some(gap => gap.includes('projectSelfMetricBills')) ||
      records.gaps.some(gap => gap.includes('projectSelfMetricBills')),
  );
  await assert.rejects(
    readHostedMetricPages(async (name, args) => {
      if (name === 'projectSelfMetricBills:page') throw new Error('network down');
      return f.query(name, args);
    }, period),
    error => error.code === 'HOSTED_ACTION_FAILED',
  );
});

test('hosted reuse keys make reuse rate real and count fresh runs that repeated a passing key', async () => {
  const f = fixture();
  f.landing('a', at(60), at(62));
  const plan = head => ({
    head,
    definition: 'd'.repeat(64),
    runtime: 'r'.repeat(64),
    environmentFingerprint: 'e'.repeat(64),
    lockfile: 'l'.repeat(64),
    selection: { sha256: 's'.repeat(64), size: 1 },
    manifest: { sha256: 'm'.repeat(64), size: 1 },
    shardCount: 2,
  });
  const run = (id, start, head, seconds) => {
    const row = f.run(id, at(start), at(start + 2), seconds);
    const value = JSON.parse(row.value);
    row.value = JSON.stringify({ ...value, plan: plan(head) });
  };
  run('first', 10, 'a'.repeat(64), 120);
  run('repeat', 30, 'a'.repeat(64), 60);
  run('other', 50, 'b'.repeat(64), 60);
  const { records } = await readHostedMetricPages(f.query, period);
  const metric = metricsSurface(records, period).totals['5.6'];
  assert.equal(metric.reuseRate, 0, 'hosted landing adopts no earlier evidence');
  assert.equal(metric.reused, 0);
  assert.equal(metric.fullChecksStarted, 3);
  assert.deepEqual(
    { runs: metric.missedReuse.runs, minutes: metric.missedReuse.runnerMinutes },
    { runs: 1, minutes: 1 },
  );
  assert(!metric.gaps.some(gap => gap.includes('reuse key')));
});
