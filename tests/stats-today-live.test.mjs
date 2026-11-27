// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Landings today agree on every surface (Item 6bd1cf57). The owner saw Needs me at 57 landed today beside Stats at 51:
// Stats counted today from a provisional close the server runs at most hourly (up to 10:00 UTC), the top bar from the
// live feed. Stats now takes today's landings from the live feed it already has and keeps the close for the derived
// figures only, marked "as of". Every "today" is the UTC project day, whatever the reader's time zone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'vite';
import { moduleUrl } from './convex-module.mjs';

const flowDay = await import(moduleUrl('../src/flow-day.ts'));
const period = await import(moduleUrl('../src/stats-period.ts'));
const { statsDay } = await import(moduleUrl('../src/stats-estimate.ts'));
const stats = await import(moduleUrl('../web/src/app/stats/model.ts'));
const { flowFigures } = await import(moduleUrl('../web/src/app/flow/model.ts'));
const lanes = await import(moduleUrl('../web/src/app/lanes/model.ts'));
const words = await import(moduleUrl('../web/src/app/code/code-words.ts'));

const at = iso => Date.parse(iso);
/** The line feed's Flow day after one landing at each time. */
const feedOf = (...times) => {
  let flow = { hours: [], took: [] };
  for (const time of times) flow = flowDay.stepFlow(flow, time, { landed: 1 });
  return flow;
};
/** `n` landings spread over the hours from `start` (ms) on, one a minute. */
const landingsFrom = (start, n) => Array.from({ length: n }, (_, i) => start + i * 60_000);
const landing = (time, i) => ({
  id: `l${time}-${i}`,
  who: 'amber-fox',
  submittedAt: time,
  landedAt: time + 300_000,
  checkStartedAt: time + 30_000,
  checkEndedAt: time + 280_000,
  runnerSeconds: 200,
});
const dayRow = (iso, n, provisional) => {
  const start = at(`${iso}T01:00:00Z`);
  const row = statsDay(iso, landingsFrom(start, n).map(landing));
  return provisional === undefined ? row : { ...row, provisional };
};
const monthPeriod = now => stats.periodOf(new URLSearchParams(''), now);

// Compile the screen and its CSS imports as Vite does, without a server or a browser.
const { output } = await build({
  configFile: false,
  logLevel: 'silent',
  oxc: { jsx: { runtime: 'automatic' } },
  build: {
    ssr: 'web/src/app/stats/Stats.tsx',
    write: false,
    rolldownOptions: { output: { codeSplitting: false, paths: id => import.meta.resolve(id) } },
  },
});
const screen = output.find(item => item.type === 'chunk' && item.isEntry);
const { StatsView } = await import(
  `data:text/javascript;base64,${Buffer.from(screen.code).toString('base64')}`
);

test('Stats renders the live first landing while the first hourly summary is still pending', () => {
  const now = at('2026-11-23T04:15:00Z');
  const selected = monthPeriod(now);
  const live = flowDay.mainToday(feedOf(at('2026-11-23T04:05:00Z')), now).landed;
  const data = period.statsRangeReply([], selected);
  const shown = stats.withLiveToday(data, live, selected, now);
  assert.equal(shown.data.window.landings, 1);
  assert.deepEqual(shown.data.perDay, [['2026-11-23', 1]]);

  const html = renderToStaticMarkup(
    createElement(StatsView, { data, period: selected, now, liveLanded: live, usePart: assert.fail }),
  );
  assert.match(html, /<b>1 landing today\.<\/b>/);
  assert.match(html, /first hourly summary/);
  assert.match(html, /midnight UTC/);
  assert.match(html, /same number of days before it/);
});

test('Stats describes a historical period with no summary without claiming it had no landings', () => {
  const now = at('2026-11-23T04:15:00Z');
  const selected = stats.periodOf(new URLSearchParams('period=last'), now);
  const data = period.statsRangeReply([], selected);
  const html = renderToStaticMarkup(
    createElement(StatsView, { data, period: selected, now, liveLanded: 1, usePart: assert.fail }),
  );
  assert.match(html, /<b>No landing figures in October 2026\.<\/b>/);
  assert.match(html, /Try a longer period\./);
});

test('Stats distinguishes a reported zero from a day with no summary or live count', () => {
  const now = at('2026-11-23T04:15:00Z');
  const selected = stats.periodOf(new URLSearchParams('from=2026-11-23&to=2026-11-23'), now);
  const data = period.statsRangeReply([], selected);
  const props = { data, period: selected, now, usePart: assert.fail };
  assert.match(
    renderToStaticMarkup(createElement(StatsView, { ...props, liveLanded: 0 })),
    /<b>No landings reported today\.<\/b>/,
  );
  assert.match(renderToStaticMarkup(createElement(StatsView, props)), /<b>No landing figures from/);
});

test('Stats reads the newly selected period before calling it empty', () => {
  const now = at('2026-11-23T04:15:00Z');
  const data = period.statsRangeReply([], stats.periodOf(new URLSearchParams('period=last'), now));
  const html = renderToStaticMarkup(
    createElement(StatsView, { data, period: monthPeriod(now), now, busy: true, usePart: assert.fail }),
  );
  assert.match(html, /aria-busy="true">Reading this project’s landing figures/);
  assert.doesNotMatch(html, /No landing figures/);
});

test('All time shows first-day landings and explains the summary without promising a range trend', () => {
  const now = at('2026-11-23T04:15:00Z');
  const selected = stats.periodOf(new URLSearchParams('period=all'), now);
  const data = period.statsAllReply([], []);
  const html = renderToStaticMarkup(
    createElement(StatsView, { data, period: selected, now, liveLanded: 3, usePart: assert.fail }),
  );
  assert.match(html, /<b>3 landings today\.<\/b>/);
  assert.match(html, /first hourly summary/);
  assert.doesNotMatch(html, /same number of days|Try a longer period/);
});

test('closed up to 10:00 UTC plus 6 later landings: Stats, the top bar, Needs me, History and the sentence all say 57', () => {
  const now = at('2026-11-23T10:52:00Z');
  // 51 landings before 10:00 UTC, 6 after, and 3 the evening before (not today's).
  const feed = feedOf(
    ...landingsFrom(at('2026-11-22T22:00:00Z'), 3),
    ...landingsFrom(at('2026-11-23T00:05:00Z'), 51),
    ...landingsFrom(at('2026-11-23T10:05:00Z'), 6),
  );
  const closedAt = at('2026-11-23T10:00:00Z');
  const rows = [dayRow('2026-11-22', 3), dayRow('2026-11-23', 51, closedAt)];
  const read = period.statsRangeReply(rows, monthPeriod(now));
  assert.equal(read.todayLanded, 51, 'the close counted 51 landings of today');
  assert.equal(read.window.landings, 54, 'the closed read alone: 3 + 51');

  const top = flowDay.mainToday(feed, now).landed;
  assert.equal(top, 57);
  assert.equal(flowFigures({ flow: feed }, now).landed, 57, 'Needs me');
  assert.equal(words.landedTodaySentence([], false, feed, now).n, 57, 'the History sentence');

  const shown = stats.withLiveToday(read, top, monthPeriod(now), now);
  assert.equal(shown.live, true);
  assert.equal(shown.data.perDay.find(([day]) => day === '2026-11-23')[1], 57, 'the bar for today');
  assert.equal(shown.data.window.landings, 3 + 57, 'the page count follows today');
  assert.equal(shown.data.landings, 3 + 57);
  assert.deepEqual(shown.data.window.measured, read.window.measured, 'derived figures stay the close’s');
  assert.deepEqual(shown.data.window.comparison, read.window.comparison);
  assert.equal(stats.derivedAsOf(shown.data, monthPeriod(now), now, shown.live, top), 'as of 10:00 UTC');
  assert.equal(stats.hintAsOf('median', 'as of 10:00 UTC'), 'median · as of 10:00 UTC');
});

test('today has no close yet: its landings still show, and the derived figures say they stop at the last closed day', () => {
  const now = at('2026-11-23T04:00:00Z');
  const read = period.statsRangeReply([dayRow('2026-11-22', 3)], monthPeriod(now));
  assert.equal(read.todayLanded, null);
  const shown = stats.withLiveToday(read, 4, monthPeriod(now), now);
  assert.deepEqual(shown.data.perDay.at(-1), ['2026-11-23', 4]);
  assert.equal(shown.data.window.landings, 7);
  assert.equal(stats.derivedAsOf(shown.data, monthPeriod(now), now, true, 4), 'through Sun 22 Nov');
  // No landing yet today: nothing to add, nothing to mark.
  const none = stats.withLiveToday(read, 0, monthPeriod(now), now);
  assert.equal(none.data.window.landings, 3);
  assert.equal(stats.derivedAsOf(none.data, monthPeriod(now), now, true, 0), null);
});

test('All time takes today into its month bar; a period without today, a missing feed and an older reply stay as read', () => {
  const now = at('2026-11-23T10:52:00Z');
  const closedAt = at('2026-11-23T10:00:00Z');
  const all = period.statsAllReply([], [dayRow('2026-11-22', 3), dayRow('2026-11-23', 51, closedAt)]);
  const shown = stats.withLiveToday(all, 57, { kind: 'all', from: '', to: '', label: 'all time' }, now);
  assert.deepEqual(shown.data.perMonth, [['2026-11', 60]]);
  assert.equal(shown.data.window.landings, 60);

  const last = stats.periodOf(new URLSearchParams('period=last'), now);
  const read = period.statsRangeReply([dayRow('2026-10-30', 5)], last);
  assert.equal(stats.withLiveToday(read, 57, last, now).data, read, 'last month does not hold today');
  assert.equal(stats.withLiveToday(read, null, monthPeriod(now), now).live, false, 'no feed');

  const { todayLanded: _gone, ...older } = all;
  assert.equal(
    stats.withLiveToday(older, 57, { kind: 'all', from: '', to: '', label: 'all time' }, now).data,
    older,
    'an older server names no figure for All time',
  );
});

test('the UTC midnight boundary: a landing at 23:59:30 counts yesterday, one at 00:00:30 today, on every surface', () => {
  const feed = feedOf(at('2026-11-22T23:59:30Z'), at('2026-11-23T00:00:30Z'));
  const before = at('2026-11-22T23:59:45Z');
  const after = at('2026-11-23T00:00:45Z');
  for (const [now, expected] of [
    [before, 1],
    [after, 1],
  ]) {
    assert.equal(flowDay.mainToday(feed, now).landed, expected, 'top bar');
    assert.equal(flowFigures({ flow: feed }, now).landed, expected, 'Needs me');
    assert.equal(words.landedTodaySentence([], false, feed, now).n, expected, 'History sentence');
  }
  // The same two landings as listed rows: the bands follow the same UTC day.
  const rows = [{ at: '2026-11-23T00:00:30Z' }, { at: '2026-11-22T23:59:30Z' }];
  assert.deepEqual(
    lanes.groupByDay(rows, after).map(g => [g.title, g.rows.length]),
    [
      ['Today', 1],
      ['Sunday 22 November', 1],
    ],
  );
  // A moment before midnight, the later row is not yet "today" and the earlier one is.
  assert.deepEqual(
    lanes.groupByDay(rows, before).map(g => [g.title, g.rows.length]),
    [
      ['Monday 23 November', 1],
      ['Today', 1],
    ],
  );
});

test('a reader far from UTC sees the same Today band: the day is the UTC project day, not the local one', () => {
  const was = process.env.TZ;
  process.env.TZ = 'Pacific/Auckland'; // UTC+13 in November: 20:00 UTC is already the next local day
  try {
    const now = at('2026-11-22T21:00:00Z');
    const rows = [{ at: '2026-11-22T20:00:00Z' }, { at: '2026-11-22T01:00:00Z' }];
    assert.deepEqual(
      lanes.groupByDay(rows, now).map(g => [g.title, g.rows.length]),
      [['Today', 2]],
      'both landings are on the UTC day of now',
    );
    assert.deepEqual(words.landedTodaySentence(rows, false, undefined, now), { n: 2, atLeast: false });
    assert.deepEqual(words.landedTodaySentence(rows, true, undefined, now), { n: 2, atLeast: true });
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
});
