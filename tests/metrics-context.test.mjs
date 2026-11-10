// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readHostedMetricPages } from '../dist/self-metrics-hosted-pages.js';
import { metricsSurface } from '../dist/self-metrics-surface.js';
import { metricsDeadline } from '../dist/hosted-agent-metrics.js';
import { speedBudgets } from '../dist/speed-budgets.js';
import { judgeCosts } from '../dist/cost-budgets.js';
import { fixture, seam } from './self-metrics-hosted-fixture.mjs';

// Issue e32cb0e7: a short window must not read a fixed 30-day horizon of every stream.
const DAY = 86_400_000;
const hour = 3_600_000;
const now = Date.parse(seam) + 14 * DAY;
const iso = ms => new Date(ms).toISOString();
/** 14 days of 48 landings a day and 12 runs a day, ending at `now`. */
function busyProject() {
  const f = fixture();
  for (let i = 0; i < 14 * 48; i++) {
    const submitted = now - (14 * 48 - i) * 0.5 * hour;
    f.landing(`landing-${i}`, iso(submitted), iso(submitted + 120_000));
  }
  for (let i = 0; i < 14 * 12; i++)
    f.run(`run-${i}`, iso(now - i * 2 * hour), iso(now - i * 2 * hour + 60_000));
  return f;
}
const fiveHours = { from: iso(now - 5 * hour), to: iso(now) };
const counted = (f, query = f.query) => {
  const stats = { inFlight: 0, maxInFlight: 0, args: [] };
  return {
    stats,
    query: async (name, args) => {
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      stats.args.push({ name, ...args });
      try {
        return await query(name, args);
      } finally {
        stats.inFlight--;
      }
    },
  };
};

test('a 5 h window reads a bounded horizon, not 30 days, and the streams are read side by side', async () => {
  const f = busyProject();
  const wide = counted(f);
  await readHostedMetricPages(wide.query, fiveHours, false, false, 30);
  const wideCalls = f.meter.calls;
  const narrow = counted(f);
  const before = f.meter.calls;
  const { records } = await readHostedMetricPages(narrow.query, fiveHours);
  const calls = f.meter.calls - before;
  assert(calls * 2 <= wideCalls, `default horizon ${calls} calls against ${wideCalls} for 30 days`);
  assert(
    narrow.stats.args
      .filter(call => call.name === 'projectSelfMetrics:page')
      .every(call => call.contextDays === (call.stream === 'receipts' ? 0 : 2)),
    'only history-dependent streams use the default two-day horizon',
  );
  assert(narrow.stats.maxInFlight >= 4, `streams were read one at a time (${narrow.stats.maxInFlight})`);
  assert.equal(
    metricsSurface(records, fiveHours).totals['5.1'].landings,
    10,
    'ten landings in the 5 h window, whole despite the shorter horizon',
  );
  assert(records.landingCoverageGaps.some(gap => /reads 2 days of pre-window context/.test(gap)));
  assert.equal(records.billHistoryFrom, iso(Date.parse(fiveHours.from) - 2 * DAY));
});

test('contextDays accepts zero and fractional days without imposing a whole-day read', async () => {
  const f = busyProject();
  const horizon = async contextDays => {
    const raw = await f.query('projectSelfMetrics:page', {
      stream: 'acceptances',
      ...fiveHours,
      cursor: null,
      ...(contextDays === undefined ? {} : { contextDays }),
    });
    return (Date.parse(fiveHours.from) - Date.parse(JSON.parse(raw).contextFrom)) / DAY;
  };
  assert.equal(await horizon(undefined), 30, 'an older client keeps the 30-day horizon');
  assert.equal(await horizon(1), 1);
  assert.equal(await horizon(3), 3);
  assert.equal(await horizon(7.9), 7.9);
  assert.equal(await horizon(0), 0);
  assert.equal(await horizon(0.0625), 0.0625);
  assert.equal(await horizon(400), 30);
  const { records } = await readHostedMetricPages(f.query, fiveHours, false, false, 5);
  assert(records.landingCoverageGaps.some(gap => /reads 5 days of pre-window context/.test(gap)));
});

test('a deploy that ignores contextDays is reported by the horizon it actually read', async () => {
  const f = busyProject();
  const old = (name, args) => f.query(name, { ...args, contextDays: undefined });
  const { records } = await readHostedMetricPages(old, fiveHours);
  assert(records.landingCoverageGaps.some(gap => /reads 30 days of pre-window context/.test(gap)));
});

test('METRICS_TIMEOUT never suggests a window larger than the one that failed', async () => {
  const window = { from: iso(now - 2 * hour), to: iso(now) };
  await assert.rejects(
    metricsDeadline(window, () => new Promise(() => {}), 30),
    error => {
      assert.equal(error.code, 'METRICS_TIMEOUT');
      const next = JSON.parse(/metrics '(\{.*\})'/.exec(error.message)[1]);
      assert.equal(next.to, window.to);
      assert.equal(next.from, iso(now - hour), 'the later half of a 2 h window');
      assert.equal(next.contextDays, 1);
      return true;
    },
  );
  const short = { from: iso(now - 30 * 60_000), to: iso(now) };
  await assert.rejects(
    metricsDeadline(short, () => new Promise(() => {}), 30),
    error => {
      assert.equal(JSON.parse(/metrics '(\{.*\})'/.exec(error.message)[1]).from, short.from);
      return true;
    },
  );
});

// The incident read 38 MB for 90 minutes: full check contracts dominated byte-limited pages.
// Synthetic current scale, no live deployment: 150 landings and 300 90-KB runs/day, nine days.
test('metrics window cost: compact reads preserve the whole report and scale with 90 min, 1 day and 7 days', async t => {
  const f = fixture();
  for (let i = 0; i < 9 * 150; i++) {
    const at = now - ((9 * 150 - i) * DAY) / 150;
    f.landing(`landing-${i}`, iso(at), iso(at + 60_000));
  }
  for (let i = 0; i < 9 * 300; i++) {
    const at = now - ((9 * 300 - i) * DAY) / 300;
    f.run(`run-${i}`, iso(at), iso(at + 60_000), 60, {
      retainedPlanAndConfiguration: 'x'.repeat(90 * 1024),
      gate: { mode: i % 3 === 0 ? 'audit' : 'full', effective: 'full' },
      execution: { seconds: 60 },
    });
    f.put(
      'projectSelfMetricReceipts',
      {
        projectId: 'project',
        key: `mutation:${i}`,
        kind: 'mutation',
        actor: 'owner',
        at: iso(at),
        value: JSON.stringify({ action: 'prioritize', operationId: `op-${i}` }),
      },
      iso(at),
    );
  }
  const windows = [
    ['90m', 90 * 60_000],
    ['1d', DAY],
    ['7d', 7 * DAY],
  ];
  const before = new Map();
  const read = async (query, window) => {
    const start = { ...f.meter };
    const result = await readHostedMetricPages(query, window, false, false, 1);
    return {
      report: metricsSurface(result.records, window),
      bytes: f.meter.bytes - start.bytes,
      pages: f.meter.calls - start.calls,
    };
  };
  // Old protocol: canonical run rows and pre-window receipt rows, no compact capability.
  const legacy = async (name, args) => {
    if (name !== 'projectSelfMetrics:page') return f.query(name, args);
    const raw = await f.query(name, { ...args, compactRuns: undefined, contextDays: 1 });
    const page = JSON.parse(raw);
    delete page.runProjectionVersion;
    return JSON.stringify(page);
  };
  for (const [label, duration] of windows) {
    const window = { from: iso(now - duration), to: iso(now) };
    before.set(label, await read(legacy, window));
  }
  f.projectRuns();
  let previousBytes = 0;
  const measured = {};
  for (const [label, duration] of windows) {
    const window = { from: iso(now - duration), to: iso(now) };
    const after = await read(f.query, window),
      old = before.get(label);
    assert.deepEqual(
      after.report,
      old.report,
      `${label}: every public metric, coverage gap and billing field`,
    );
    assert(after.bytes < old.bytes / 10, `${label}: full check contracts must not be read`);
    assert(after.pages < old.pages, `${label}: byte-limited run pages must fall`);
    assert(
      after.bytes > previousBytes,
      'read bytes follow the requested window plus explicit one-day context',
    );
    previousBytes = after.bytes;
    measured[`${label}Bytes`] = after.bytes;
    measured[`${label}Pages`] = after.pages;
    t.diagnostic(
      JSON.stringify({
        window: label,
        before: { bytes: old.bytes, pages: old.pages },
        after: { bytes: after.bytes, pages: after.pages },
      }),
    );
  }
  assert.equal(f.meter.writes, 0, 'metrics never migrates or writes on read');
  const verdicts = judgeCosts(speedBudgets.costs, speedBudgets.costGuard, 'metrics-fixture', measured);
  assert.equal(verdicts.length, 6, 'bytes and pages are guarded for all three windows');
  for (const verdict of verdicts) if (verdict.message) t.diagnostic(verdict.message);
  assert.deepEqual(
    verdicts.filter(v => v.status === 'fail'),
    [],
    'metrics read cost exceeded the ledger',
  );
});

test('partial migration keeps one complete canonical stream even when ordinary writes project rows between pages', async () => {
  const f = fixture();
  for (let i = 0; i < 130; i++) f.run(`run-${i}`, iso(now - (i + 1) * 60_000), iso(now - i * 60_000));
  f.projectRuns(row => Number(row.runId.slice(4)) % 2 === 0);
  const window = { from: iso(now - DAY), to: iso(now) };
  const runsOnly = await readHostedMetricPages(f.query, window, false, true, 0);
  assert.equal(
    runsOnly.records.runs.length,
    130,
    'flake-only reads keep their first-page protocol across every page',
  );
  const args = { stream: 'runs', ...window, contextDays: 0, compactRuns: true, cursor: null };
  const first = JSON.parse(await f.query('projectSelfMetrics:page', args));
  assert.equal(first.isDone, false);
  assert.match(first.continueCursor, /legacy/);
  f.projectRuns();
  const second = JSON.parse(
    await f.query('projectSelfMetrics:page', { ...args, cursor: first.continueCursor }),
  );
  assert.equal(new Set([...first.page, ...second.page].map(row => row.id)).size, 130);
  const compact = JSON.parse(await f.query('projectSelfMetrics:page', args));
  assert.match(compact.continueCursor, /compact/);
  await assert.rejects(
    f.query('projectSelfMetrics:page', {
      ...args,
      from: iso(now - 2 * DAY),
      cursor: compact.continueCursor,
    }),
    error => error.code === 'EVIDENCE_CHANGED' || error.data?.code === 'EVIDENCE_CHANGED',
  );
});
