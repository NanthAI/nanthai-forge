// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readHostedMetricPages } from '../dist/self-metrics-hosted-pages.js';
import { metricsSurface } from '../dist/self-metrics-surface.js';
import { metricsDeadline } from '../dist/hosted-agent-metrics.js';
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
      .every(call => call.contextDays === 2),
    'the default horizon is two days',
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

test('contextDays widens or narrows the horizon; the server clamps it to whole days from 1 to 30', async () => {
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
  assert.equal(await horizon(7.9), 7);
  assert.equal(await horizon(0), 1);
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
