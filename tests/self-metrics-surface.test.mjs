// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { metricPeriod, metricsSurface } from '../dist/self-metrics-surface.js';
import { formatMetricReport, metricsHeadline, formatMetricsHeadline } from '../dist/self-metrics-format.js';
import { weeklyMetricBytes, previousMetricWeek, snapshotMetricWeek } from '../dist/self-metrics-weekly.js';
import { nativeSelfMetricsReader } from '../dist/self-metrics-native.js';
import { recordOwnerMutation } from '../dist/self-metrics-journal.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { readPendingStatus } from '../dist/pending-status-read.js';
import { formatPendingStatus } from '../dist/pending-status-format.js';
import { cleanupOwner, waitForOwnerChildren } from './owner-cleanup.mjs';
const from = '2026-10-19T00:00:00.000Z',
  to = '2026-10-26T00:00:00.000Z';
const input = { laneId: 'lane', head: 'head', intentId: 'intent', savedAt: from };
function fixture() {
  return {
    moves: [{ id: 'move', at: '2026-10-20T12:00:00.000Z', head: 'head', inputs: [input], kind: 'landing' }],
    submissions: [
      {
        id: 'submission',
        entryId: 'entry',
        at: '2026-10-20T11:00:00.000Z',
        inputs: [input],
        status: 'landed',
        progressAt: [],
        runIds: ['run'],
      },
    ],
    runs: [
      {
        id: 'run',
        head: 'head',
        at: '2026-10-20T11:00:00.000Z',
        endedAt: '2026-10-20T11:02:00.000Z',
        status: 'passed',
        inputs: [input],
        runnerMinutes: 4,
        wallMinutes: 2,
        reuseKey: 'key',
        fullSuite: true,
      },
    ],
    receipts: [
      {
        schema: 1,
        kind: 'lifecycle',
        action: 'finish',
        operationId: 'finish',
        at: '2026-10-20T11:03:00.000Z',
        actor: { kind: 'agent', name: 'builder' },
        origin: 'command',
      },
      {
        schema: 1,
        kind: 'mutation',
        action: 'cancel',
        operationId: 'cancel',
        at: '2026-10-21T11:03:00.000Z',
        actor: { kind: 'person', name: 'operator' },
        origin: 'command',
      },
    ],
    gaps: [],
    coverage: {
      lifecycle: from,
      mutations: from,
      deliveries: from,
      checkRequests: from,
      fullResults: from,
      mirrorResults: from,
    },
  };
}
test('JSON includes all metrics every UTC day, window totals, source counts and named gaps', () => {
  const result = metricsSurface(fixture(), metricPeriod(from, to));
  assert.equal(result.days.length, 7);
  assert.equal(result.days[0].metrics['5.1'].landings, 0);
  for (const key of ['5.1', '5.2', '5.3', '5.4', '5.5', '5.6', '5.7', '5.8', 'R']) {
    assert.equal(typeof result.totals[key].sourceRecords, 'number');
    assert.equal(typeof result.totals[key].partial, 'boolean');
  }
  assert.equal(result.totals['5.1'].landings, 1);
  assert.equal(result.totals['5.1'].firstTryShare, 1);
  assert.equal(result.totals['5.5'].perLanding, 1);
  assert.equal(result.totals['5.6'].runnerMinutesPerLanding, 4);
  assert.equal(result.totals['5.8'].partial, true);
  assert.ok(result.totals['5.8'].gaps.length);
  assert.equal(result.totals.R.sources[0].minutes, 0);
});
test('calendar validation rejects invalid and reversed windows', () => {
  for (const values of [
    ['2026-02-30', to],
    [to, from],
    ['junk', to],
  ])
    assert.throws(
      () => metricPeriod(...values),
      e => e.code === 'BAD_ARGUMENT',
    );
});
test('report exports all metrics and comparison columns; compact status keeps headline numbers', () => {
  const result = metricsSurface(fixture(), metricPeriod(from, to));
  const report = formatMetricReport(result, result);
  assert.match(report, /Before \| After/);
  assert.match(report, /Source records \(before \/ after\)/);
  for (const id of ['5.1', '5.2', '5.3', '5.4', '5.5', '5.6', '5.7', '5.8', 'R'])
    assert.ok(report.includes(`| ${id} `));
  const lines = formatMetricsHeadline(metricsHeadline(result.totals));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /1 landings.*100%/);
  assert.match(lines[1], /Checks\/landing 4 min/);
});
test('weekly JSON reproduces byte-for-byte and excludes later observations and source revisions', () => {
  const records = fixture(),
    period = metricPeriod(from, to),
    bytes = weeklyMetricBytes(records, period);
  const later = structuredClone(records);
  later.source = { kind: 'native', revision: 999 };
  later.moves.push({
    id: 'later',
    at: '2026-10-27T00:00:00.000Z',
    head: 'later',
    inputs: [input],
    kind: 'landing',
  });
  later.receipts.push({ ...records.receipts[0], at: '2026-10-27T00:00:00.000Z', operationId: 'later' });
  later.observations = [
    {
      type: 'surface',
      id: 'future',
      at: '2026-10-27T00:00:00.000Z',
      surface: 'web',
      entity: 'lane',
      authority: 'done',
      displayed: 'working',
    },
  ];
  assert.equal(weeklyMetricBytes(later, period), bytes);
  assert.deepEqual(previousMetricWeek('2027-01-04T00:00:00.000Z'), {
    name: 'weekly-2026-W53.json',
    period: {
      from: '2026-12-28T00:00:00.000Z',
      to: '2027-01-04T00:00:00.000Z',
      asOf: '2027-01-04T00:00:00.000Z',
    },
  });
});
test('CLI JSON/report, registered agent action, owner status, write-triggered weekly snapshot', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-m3-'));
  writeFileSync(join(root, 'a.txt'), 'fixture\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    directory = join(root, '.forge/work');
  try {
    const result = await agent.dispatch({ action: 'metrics', from, to });
    assert.equal(result.result.schema, 1);
    const report = join(root, 'report.md');
    const cli = spawnSync(
      process.execPath,
      [
        'dist/cli.js',
        'metrics',
        root,
        '--from',
        from,
        '--to',
        to,
        '--json',
        '--report',
        report,
        '--compare',
        `${from}..${to}`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).days.length, 7);
    assert.match(readFileSync(report, 'utf8'), /Before \| After/);
    const before = statSync(join(directory, 'work.json')).mtimeMs;
    const status = readPendingStatus(agent.work.store, undefined, to);
    assert.ok(status.metrics);
    assert.match(formatPendingStatus(status), /Metrics · last 7 days/);
    assert.equal(statSync(join(directory, 'work.json')).mtimeMs, before);
    const week = previousMetricWeek('2026-11-02T00:00:00.000Z');
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T00:00:00.000Z') });
    recordOwnerMutation(directory);
    await waitForOwnerChildren(root);
    const path = join(directory, 'metrics', week.name);
    const snapshot = readFileSync(path, 'utf8');
    const records = await nativeSelfMetricsReader(root).read();
    assert.equal(snapshot, weeklyMetricBytes(records, week.period));
    snapshotMetricWeek(directory, '2026-11-02T10:00:00.000Z');
    assert.equal(readFileSync(path, 'utf8'), snapshot);
    recordOwnerMutation(directory);
    assert.ok(readdirSync(directory).includes('metrics'));
  } finally {
    t.mock.timers.reset();
    await cleanupOwner(root);
  }
});
