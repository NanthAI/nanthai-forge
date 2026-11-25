// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 8947a779: Explore ranks by "time to main", so the directory source must supply it. The figure is the median
// save-to-main time of this week's landings, kept in the main summary's existing day buckets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { fixture, NOW } from './public-discovery-fixture.mjs';
import { fakeR2Config, startFakeR2 } from './fake-r2.mjs';
import { directoryMeter } from './public-directory-meter.mjs';

const { landingToMainSeconds, recordDay, weekHistograms, histogramMedian, TIME_BINS } = await import(
  moduleUrl('../src/public-time-to-main.ts')
);
const { readDirectoryInput } = await import(moduleUrl('../convex/publicDirectoryInput.ts'));
const { readSlice } = await import(moduleUrl('../convex/publicDirectorySource.ts'));
const { buildPublicDirectory } = await import(moduleUrl('../convex/publicDirectoryProjection.ts'));
const line = await import(moduleUrl('../convex/projectLiveLineStore.ts'));
const DAY = 86_400_000;
const today = Math.floor(NOW / DAY);
const head = n => String(n).repeat(64).slice(0, 64);
const iso = ms => new Date(ms).toISOString();

test('a landing’s time is its submission to its receipt in whole seconds, and unknown when unusable', () => {
  const at = iso(NOW);
  assert.equal(
    landingToMainSeconds(at, { at: iso(NOW - 1000), timing: { submittedAt: iso(NOW - 90_400) } }),
    90,
  );
  assert.equal(
    landingToMainSeconds(at, { at: iso(NOW - 12_000) }),
    12,
    'the row time stands in for a missing timing',
  );
  assert.equal(landingToMainSeconds(at, null), null);
  assert.equal(
    landingToMainSeconds(at, { at: iso(NOW + 1000) }),
    null,
    'a landing cannot precede its submission',
  );
});

const median = (days, at = today) => histogramMedian(weekHistograms(days, at));

test('the week’s median covers every timed landing of a busy day, not a recent sample of it (incident: nine-sample ring)', () => {
  // 11 one-minute landings, then 9 ten-minute ones, all on one day: the median is one minute, not ten.
  const days = [];
  for (let n = 0; n < 11; n++) recordDay(days, today, 1, [60]);
  for (let n = 0; n < 9; n++) recordDay(days, today, 1, [600]);
  assert.equal(days[0].count, 20, 'every landing is counted');
  assert.equal(days[0].hist.length, TIME_BINS, 'a day is a fixed histogram however busy it is');
  assert.equal(
    days[0].hist.reduce((a, n) => a + n, 0),
    20,
  );
  const busy = median(days);
  assert.ok(busy >= 40_000 && busy < 80_000, `the median stays in the one-minute bucket, got ${busy} ms`);
  const calmer = [];
  recordDay(calmer, today, 1, [300]);
  assert.ok(busy < median(calmer), 'ranks ahead of a project whose median is five minutes');
});

test('a landing without a time never enters the histogram or moves the others (incident: untimed landings shifted the ring)', () => {
  const days = [];
  recordDay(days, today, 5, [null, null, null, null, null]);
  assert.equal(days[0].hist, undefined, 'untimed landings create no histogram');
  for (let n = 0; n < 10; n++) recordDay(days, today, 1, [90]);
  assert.equal(days[0].count, 15);
  assert.equal(
    days[0].hist.reduce((a, n) => a + n, 0),
    10,
    'only the timed landings are counted in the histogram',
  );
  assert.equal(median(days), 120_000, 'ten 90 s landings sit mid-bucket, whatever came before them');
});

test('days outside the week and legacy days without times contribute nothing', () => {
  const days = [];
  recordDay(days, today - 7, 1, [1_000_000]);
  assert.equal(median(days), undefined, 'a day that left the window never counts');
  assert.equal(median([{ day: today, count: 4 }]), undefined, 'legacy landings stay not reported');
  recordDay(days, today - 1, 2, [null, null]);
  assert.equal(days.find(row => row.day === today - 1).hist, undefined, 'unknown times are never invented');
  recordDay(days, today - 6, 1, [30]);
  assert.equal(median(days), 30_000, 'the oldest day of the window still counts, and a single time is exact');
  assert.equal(median(days, today + 1), undefined, 'one day later that landing has left the week');
});

test('landings record their time once, the directory row carries the median, and Explore’s Active order uses it', async () => {
  const s = fixture();
  const at = iso(NOW - 3_600_000);
  await line.writeLineMain(s.ctx, 'project', { head: head(1), at }, 1, false, 1, [30]);
  await line.writeLineMain(s.ctx, 'project', { head: head(2), at }, 2, false, 2, [60, 100]);
  await line.writeLineMain(s.ctx, 'project', { head: head(2), at }, 2, false, 2, [999, 999]);
  const [only] = (await readSlice._handler(s.ctx, { now: NOW, cursor: null })).projects;
  assert.equal(only.landings, 3, 'a replayed landing sequence counts nothing twice');
  assert.equal(only.timeToMain, 60_000, 'the median of 30, 60 and 100 s');

  const other = { ...only, id: 'other', slug: 'beta', timeToMain: 20_000 };
  const silent = { ...only, id: 'silent', slug: 'gamma' };
  delete silent.timeToMain;
  const { orders } = buildPublicDirectory([silent, only, other], 'https://example.convex.cloud');
  const active = orders.find(order => order.order === 'active').pages[0].projects;
  assert.deepEqual(
    active.map(project => project.slug),
    ['beta', 'atlas', 'gamma'],
    'equal landings: faster first, a project with no recorded time last',
  );
  assert.equal(active[0].timeToMain, 20_000);
});

/** A checkpoint row the rebuild carries forward without auditing it (the audit reads 32 rows a rebuild). */
async function carriedRow(asOf) {
  const r2 = await startFakeR2(fakeR2Config, { local: true });
  const config = { ...fakeR2Config, endpoint: { scheme: 'http', host: r2.host } };
  const at = Date.UTC(2026, 10, 25, 12);
  const old = Array.from({ length: TIME_BINS }, (_, i) => (i === 7 ? 9 : 0)); // nine 20-minute landings
  const fast = Array.from({ length: TIME_BINS }, (_, i) => (i === 3 ? 1 : 0)); // one one-minute landing
  const projects = Array.from({ length: 40 }, (_, n) => ({
    id: String(n).padStart(32, '0'),
    handle: `owner-${n}`,
    slug: `project-${n}`,
    name: `Project ${n}`,
    since: at + n,
    stars: 0,
    landings: 0,
    main: 'passing',
    days: [0, 0, 0, 0, 0, 0, 0],
  }));
  const target = projects.at(-1);
  Object.assign(target, {
    landings: 10,
    days: [9, 1, 0, 0, 0, 0, 0],
    bins: [old, fast, [], [], [], [], []],
    timeToMain: histogramMedian([old, fast]),
  });
  const meter = directoryMeter(config, projects, at);
  assert.equal(await meter.seed(), true);
  const input = await meter.changed([0], at + asOf * 86_400_000);
  r2.close();
  return input.rows.find(row => row.id === target.id);
}

test('a carried, unaudited row derives its median again when days leave the week (incident: expired 20-minute median kept ranking)', async () => {
  const one = await carriedRow(1);
  assert.deepEqual(one.days, [1, 0, 0, 0, 0, 0, 0], 'the 20-minute day left the week');
  assert.equal(one.landings, 1);
  assert.equal(one.timeToMain, 60_000, 'only the one-minute landing is left');
  assert.equal(
    one.bins[0].reduce((a, n) => a + n, 0),
    1,
  );
  const none = await carriedRow(8);
  assert.equal(none.landings, 0);
  assert.equal(none.timeToMain, undefined, 'an empty week has no time to main');
  assert.equal(none.bins, undefined, 'and no histogram is carried');
});
