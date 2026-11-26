// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Stats All time, the self-trend and covered days (Item a61d3c91, Done-when 22:05Z): All time adds up stored month
// rollups (one row a month) and gives the figures its days give; a rollup keeps each distribution as at most 400
// quantiles, so its medians stay within a sample's share; the self-trend sets a range beside the same number of days
// just before it; a day left not measured is not a closed day in the covered-days words.
import test from 'node:test';
import { distMedian, STATS_DIST_SAMPLES } from '../dist/stats-distribution.js';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const est = await import(moduleUrl('../src/stats-estimate.ts'));
const period = await import(moduleUrl('../src/stats-period.ts'));
const { classifyRuns } = await import(moduleUrl('../src/stats-runs.ts'));
const model = await import(moduleUrl('../web/src/app/stats/model.ts'));

const MIN = 60_000;
/** A closed day of `n` landings with their runs: each landing's solo run, a failed recheck for every 7th after a pass
 * (a queue ejection), a failed change for every 5th. */
function day(name, n, carry = est.NO_CARRY) {
  const start = Date.parse(`${name}T08:00:00.000Z`);
  const landings = [],
    runs = [],
    attempts = [],
    landed = new Set();
  for (let i = 0; i < n; i++) {
    const at = start + i * 3 * MIN;
    const id = `${name}-${i}`;
    landings.push({
      id,
      attribution: ['agent:codex:gpt-6.2-sol', 'agent:claude-code:sonnet', 'person:example'][i % 3],
      submittedAt: at,
      landedAt: at + (5 + (i % 4)) * MIN,
      checkStartedAt: at + 30_000,
      checkEndedAt: at + 30_000 + (240 + (i % 9) * 10) * 1000,
      runnerSeconds: 200 + (i % 5) * 20,
      discardedRunnerSeconds: i % 6 === 0 ? 120 : 0,
      attempts: i % 6 === 0 ? 2 : 1,
      ranInFull: true,
    });
    runs.push({
      id: `r${id}`,
      at: at + 30_000,
      endedAt: at + 300_000,
      status: 'passed',
      runnerSeconds: 240 + (i % 3) * 30,
      fullSuite: true,
      scopedRecheck: false,
      audit: false,
    });
    attempts.push({
      id: `a${id}`,
      submissionId: `s${id}`,
      parentAttemptId: null,
      runId: `r${id}`,
      member: false,
    });
    landed.add(`a${id}`);
    if (i % 5 === 0) {
      runs.push({
        id: `f${id}`,
        at,
        endedAt: at + 100_000,
        status: 'failed',
        runnerSeconds: 90,
        fullSuite: true,
        scopedRecheck: false,
        audit: false,
      });
      attempts.push({
        id: `fa${id}`,
        submissionId: `fs${id}`,
        parentAttemptId: null,
        runId: `f${id}`,
        member: false,
      });
    }
  }
  return est.statsDay(
    name,
    landings,
    classifyRuns({
      runs,
      attempts,
      landedAttemptIds: landed,
      pendingSubmissionIds: new Set(),
      partial: false,
    }),
    carry,
  );
}
/** Days in order, each handed the previous one's carry. */
function days(spec) {
  let carry = est.NO_CARRY;
  return spec.map(([name, n]) => {
    const d = day(name, n, carry);
    carry = est.statsCarry(d);
    return d;
  });
}
/** Numbers equal to 1e-9 of their size, recursively: sums of month sums add in another order than day by day. */
function near(a, b, path = '') {
  if (typeof a === 'number' && typeof b === 'number')
    return assert(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)), `${path}: ${a} vs ${b}`);
  if (a && typeof a === 'object' && b && typeof b === 'object') {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), path);
    for (const k of Object.keys(a)) near(a[k], b[k], `${path}.${k}`);
    return;
  }
  assert.equal(a, b, path);
}

test('All time from month rollups gives the figures its days give', () => {
  const sep = days(
    Array.from({ length: 30 }, (_, i) => [`2026-09-${String(i + 1).padStart(2, '0')}`, 3 + (i % 4)]),
  );
  const oct = days([
    ['2026-10-02', 12],
    ['2026-10-15', 9],
    ['2026-10-31', 14],
  ]);
  const nov = days([
    ['2026-11-01', 8],
    ['2026-11-02', 6],
  ]);
  const months = [period.statsMonth('2026-09', sep), period.statsMonth('2026-10', oct)];
  for (const m of months) period.statsMonthSchema.parse(JSON.parse(JSON.stringify(m)));
  const all = period.statsAllReply(months, nov);
  const every = [...sep, ...oct, ...nov];
  const { measured, ...window } = est.statsWindow(every);
  const { stops, ...headline } = measured;
  assert(window.comparison, 'enough landings to compare');
  near(all.window, { ...window, measured: headline });
  assert.equal(all.kind, 'all');
  assert.deepEqual(all.cover, { first: '2026-09-01', last: '2026-11-02', closed: 35, notMeasured: 0 });
  assert.deepEqual(all.perMonth, [
    ['2026-09', sep.reduce((s, d) => s + d.landings, 0)],
    ['2026-10', 35],
    ['2026-11', 14],
  ]);
  near(period.statsAllReply(months, nov, 'waited').stops, stops);
  const agents = period.statsAllReply(months, nov, 'agents');
  assert.equal(agents.agentRows.length, 3);
  assert.equal(
    agents.agentRows.reduce((n, row) => n + row.landings, 0),
    agents.landings,
  );
  const byMonth = period.statsAllReply(months, nov, 'months').months;
  assert.deepEqual(
    byMonth.map(m => [m.month, m.landings]),
    [
      ['2026-09', all.perMonth[0][1]],
      ['2026-10', 35],
      ['2026-11', 14],
    ],
  );
  near(byMonth[1].savedVsQueue, est.statsWindow(oct).comparison?.mergeQueue.savedMinutes ?? null);
});

test('a month rollup keeps at most 400 samples a distribution, its median within one sample’s share', () => {
  // About 30 days of 60 landings: 1,800 times to main, past what a rollup keeps.
  const month = days(Array.from({ length: 30 }, (_, i) => [`2026-10-${String(i + 1).padStart(2, '0')}`, 60]));
  const rolled = period.statsMonth('2026-10', month);
  assert.equal(rolled.totals.toMain[0].v.length, STATS_DIST_SAMPLES);
  assert.equal(rolled.totals.toMain[0].n, 1_800);
  assert(JSON.stringify(rolled).length < 40_000, `rollup size: ${JSON.stringify(rolled).length}`);
  const exact = est.statsWindow(month).measured.toMainSeconds;
  const sampled = est.statsFigures(rolled.totals).measured.toMainSeconds;
  const sorted = month.flatMap(d => d.toMain).sort((a, b) => a - b);
  const share = Math.ceil(sorted.length / STATS_DIST_SAMPLES);
  const mid = sorted.length >> 1;
  assert(
    sampled >= sorted[mid - share] && sampled <= sorted[mid + share],
    `${sampled} vs ${exact}: within one sample's share of the middle`,
  );
  // Unit weights give the plain median, even counts their middle mean.
  assert.equal(distMedian([{ n: 4, v: [1, 2, 3, 10] }]), 2.5);
  assert.equal(
    distMedian([
      { n: 3, v: [1, 2, 3] },
      { n: 1, v: [9] },
    ]),
    2.5,
  );
  // A sample standing for many values outweighs single values.
  assert.equal(
    distMedian([
      { n: 100, v: [50] },
      { n: 3, v: [1, 2, 3] },
    ]),
    50,
  );
});

test('the self-trend sets a range beside the same number of days just before it', () => {
  assert.deepEqual(period.previousRange({ from: '2026-11-13', to: '2026-11-19' }), {
    from: '2026-11-06',
    to: '2026-11-12',
  });
  assert.deepEqual(period.previousRange({ from: '2026-11-01', to: '2026-11-30' }), {
    from: '2026-10-02',
    to: '2026-10-31',
  });
  const before = days([
    ['2026-11-07', 6],
    ['2026-11-09', 4],
  ]);
  const now = days([
    ['2026-11-14', 9],
    ['2026-11-15', 12],
    ['2026-11-16', 3],
  ]);
  const failed = est.statsFailedDay('2026-11-17', est.NO_CARRY, 3);
  const r = period.statsRangeReply(
    [...now, failed],
    { from: '2026-11-13', to: '2026-11-19' },
    'trend',
    before,
  );
  assert.equal(r.current.landingsPerDay, 8, '24 landings over 3 closed days; the not-measured day is none');
  assert.equal(r.previous.landingsPerDay, 5);
  assert.deepEqual([r.previous.from, r.previous.to], ['2026-11-06', '2026-11-12']);
  assert.equal(r.current.firstTryRate, est.statsWindow(now).measured.firstTryRate);
  assert.equal(r.previous.toMainSeconds, est.statsWindow(before).measured.toMainSeconds);
  assert.equal(r.current.ciMinutesPerLanding, est.statsWindow(now).measured.ciMinutesPerLanding);
  assert.equal('window' in r, false, 'the fold returns its own figures only');
});

test('a day left not measured is not a closed day in the covered-days words', () => {
  const week = { kind: '7', from: '2026-11-13', to: '2026-11-19', label: 'the last 7 days' };
  const measured = days(Array.from({ length: 6 }, (_, i) => [`2026-11-${13 + i}`, 3]));
  const rows = [...measured, est.statsFailedDay('2026-11-19', est.NO_CARRY, 3)];
  const head = period.statsRangeReply(rows, week);
  assert.deepEqual(head.cover, { first: '2026-11-13', last: '2026-11-18', closed: 6, notMeasured: 1 });
  assert.equal(model.coverWords(week, head.cover), 'over 13–18 Nov 2026 (6 closed days)');
  // One in the middle: the span is whole, yet the period has not wholly closed and the count leaves it out.
  const middle = [
    ...measured.filter(d => d.day < '2026-11-16'),
    est.statsFailedDay('2026-11-16', est.NO_CARRY, 3),
    ...measured.filter(d => d.day > '2026-11-16'),
  ];
  const last = days([['2026-11-19', 2]]);
  const cover = period.coverOf([...middle, ...last]);
  assert.equal(model.coverWords(week, cover), 'over 13–19 Nov 2026 (6 closed days)');
  assert.equal(model.coverWords(week, period.coverOf([...measured, ...last])), 'in the last 7 days');
  // All time always names the days it covers.
  assert.equal(
    model.coverWords({ kind: 'all', from: '', to: '', label: 'all time' }, cover),
    'over 13–19 Nov 2026 (6 closed days)',
  );
});

test('how far a provisional row counts: its day and UTC time, and nothing for a reply without the field', () => {
  // Review of Item 580b1a1a: a reply from a backend before the field had no todayUpTo; the line must not throw.
  assert.equal(model.soFarOf(undefined), null);
  assert.equal(model.soFarOf(null), null);
  assert.deepEqual(model.soFarOf(Date.UTC(2026, 10, 21, 9, 5)), { day: '2026-11-21', time: '09:05' });
  assert.equal(model.weekdayName('2026-11-21'), 'Sat 21 Nov');
});
