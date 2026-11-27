// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Stats screen model (Items 2cf30e0a, a61d3c91): the chosen period, the read reply of convex/projectStats.ts and the
// words the screen prints. Figures come only from the project's own day rows (src/stats-period.ts): closed days and
// today so far; nothing here estimates.
import type { StatsCover, StatsHead } from '../../../../src/stats-period';
import { STATS_RANGE_MAX_DAYS, rangeDays, validRange } from '../../../../src/stats-period';
import { STATS_DAY_MAX_LANDINGS } from '../../../../src/stats-estimate';

export type StatsRead = StatsHead;
export type StatsWindow = StatsRead['window'];
export type PeriodKind = '7' | '30' | 'this' | 'last' | 'all' | 'custom';
/** The page's one period picker, in the address as `?period=7|30|last|all` (this month is the plain address). */
export const PERIODS: { value: PeriodKind; text: string }[] = [
  { value: '7', text: 'Last 7 days' },
  { value: '30', text: 'Last 30 days' },
  { value: 'this', text: 'This month' },
  { value: 'last', text: 'Last month' },
  { value: 'all', text: 'All time' },
  { value: 'custom', text: 'Custom range' },
];
export const periodSearch = (kind: Exclude<PeriodKind, 'custom'>) =>
  kind === 'this' ? '' : `period=${kind}`;
export type Period = { kind: PeriodKind; from: string; to: string; label: string; error?: string };

const utc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const monthOf = (year: number, month: number) => ({
  from: utc(Date.UTC(year, month, 1)),
  to: utc(Date.UTC(year, month + 1, 0)),
});
export const monthName = (month: string) =>
  new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
export const dayName = (day: string) =>
  new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );
/** "15 Nov" or "15 Nov 2026": day before month, as the period labels read. */
const shortDay = (day: string, year = false) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(year ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));

/** The period in the address (`?period=last`, or `?from=…&to=…`), so a link, a reload and Back show the same one.
 * Months are UTC calendar months, the days the close files landings under. All time has no range of its own: the read
 * names the days it covers. */
export function periodOf(search: URLSearchParams, now: number): Period {
  const today = new Date(now);
  const from = search.get('from'),
    to = search.get('to');
  if (from && to) {
    const label = `${shortDay(from, from.slice(0, 4) !== to.slice(0, 4))} to ${shortDay(to, true)}`;
    if (validRange({ from, to })) return { kind: 'custom', from, to, label };
    const fallback = monthOf(today.getUTCFullYear(), today.getUTCMonth());
    return {
      kind: 'custom',
      ...fallback,
      label: monthName(fallback.from.slice(0, 7)),
      error:
        rangeDays({ from, to }) > STATS_RANGE_MAX_DAYS
          ? `Choose at most ${STATS_RANGE_MAX_DAYS} days; showing this month.`
          : 'Choose a start day on or before the end day; showing this month.',
    };
  }
  const kind = search.get('period');
  if (kind === 'all') return { kind, from: '', to: '', label: 'all time' };
  if (kind === '7' || kind === '30') {
    const n = Number(kind);
    return { kind, from: utc(now - (n - 1) * 86_400_000), to: utc(now), label: `the last ${n} days` };
  }
  const last = kind === 'last';
  const range = monthOf(today.getUTCFullYear(), today.getUTCMonth() - (last ? 1 : 0));
  return { kind: last ? 'last' : 'this', ...range, label: monthName(range.from.slice(0, 7)) };
}
/** "in November 2026", "from 3 Nov to 18 Nov 2026", or "yet" for All time. */
export const periodWords = (p: Period) =>
  p.kind === 'all' ? 'yet' : p.kind === 'custom' && !p.error ? `from ${p.label}` : `in ${p.label}`;
/** The reply includes the provisional summary in its measured-day count. */
export function coverDayWords(cover: StatsCover, partialDay: boolean) {
  if (!partialDay) return plural(cover.closed, 'closed day');
  return cover.closed > 1 ? `${plural(cover.closed - 1, 'closed day')} and 1 partial day` : '1 partial day';
}

/** The days the figures cover. A day not measured (its close did not finish) is left out of the span and count. */
export function coverWords(period: Period, cover: StatsCover, provisionalDay?: string) {
  const { first, last } = cover;
  if (first === null || last === null) return periodWords(period);
  const partialDay = last === provisionalDay;
  if (
    period.kind !== 'all' &&
    first === period.from &&
    last === period.to &&
    !cover.notMeasured &&
    !partialDay
  )
    return periodWords(period);
  const coverage = coverDayWords(cover, partialDay);
  if (first === last) return `on ${shortDay(first, true)} (${coverage})`;
  const span =
    first.slice(0, 7) === last.slice(0, 7)
      ? `${Number(first.slice(8))}–${shortDay(last, true)}`
      : `${shortDay(first, first.slice(0, 4) !== last.slice(0, 4))} – ${shortDay(last, true)}`;
  return `over ${span} (${coverage})`;
}

/** The period holds today (UTC), so today's row counts so far (Item 580b1a1a). All time always does. */
export function holdsToday(period: Period, now: number) {
  const today = utc(now);
  return period.kind === 'all' || (period.from <= today && today <= period.to);
}
/** Today's landings live (Item 6bd1cf57): the figure the top bar shows, in place of the hourly close's. The landings of
 * today (the page's counts, the per-day bar, the month's bar) take `live`; every derived figure (first-try rate, CI
 * minutes, medians, the comparison) stays the close's and says so (`derivedAsOf`). With no live figure, a period
 * without today, or a today whose close did not finish, the read is returned as it came. */
export function withLiveToday(
  data: StatsRead,
  live: number | null | undefined,
  period: Period,
  now: number,
): { data: StatsRead; live: boolean } {
  if (live === null || live === undefined || !Number.isFinite(live) || !holdsToday(period, now))
    return { data, live: false };
  const today = utc(now);
  const closed = data.todayLanded ?? data.perDay.find(([day]) => day === today)?.[1] ?? null;
  const row = data.perDay.find(([day]) => day === today);
  if (data.perMonth === null && row?.[1] === null) return { data, live: false };
  // An older server reply names no figure for an All time read: leave that read as it is.
  if (data.perMonth !== null && data.todayLanded === undefined) return { data, live: false };
  const delta = live - (closed ?? 0);
  if (!delta) return { data, live: true };
  const month = today.slice(0, 7);
  const perMonth = data.perMonth
    ? data.perMonth.some(([m]) => m === month)
      ? data.perMonth.map(([m, n]): [string, number] => (m === month ? [m, n + delta] : [m, n]))
      : [...data.perMonth, [month, live] as [string, number]]
    : null;
  const perDay: Array<[string, number | null]> = data.perMonth
    ? data.perDay
    : row
      ? data.perDay.map(([day, n]) => (day === today ? [day, live] : [day, n]))
      : [...data.perDay, [today, live]];
  const landings = data.window.landings + delta;
  return {
    live: true,
    data: { ...data, landings, perDay, perMonth, window: { ...data.window, landings } },
  };
}
/** Where the derived figures stop while today's landings are live: "as of 10:00 UTC" (today's close), or "through
 * Sat 22 Nov" when today has no close yet; null when they are as current as the landings. */
export function derivedAsOf(data: StatsRead, period: Period, now: number, live: boolean, landed: number) {
  if (!live || !holdsToday(period, now)) return null;
  const soFar = soFarOf(data.todayUpTo);
  if (soFar && soFar.day === utc(now)) return `as of ${soFar.time} UTC`;
  return landed > 0 && data.cover.last ? `through ${weekdayName(data.cover.last)}` : null;
}
/** A region's hint with where its figures stop appended, when they stop short of the live landings. */
export const hintAsOf = (hint: string, asOf: string | null) => (asOf ? `${hint} · ${asOf}` : hint);

/** The value headline's opening words: "In November 2026" when the whole period is counted, "Since 28 Oct" while it is
 * still filling (this month, the last days, All time), "From 3 Nov to 18 Nov" for a custom range cut short. */
export function valueWhen(period: Period, cover: StatsCover) {
  const { first, last } = cover;
  if (first === null || last === null) return `In ${period.label}`;
  const years = first.slice(0, 4) !== last.slice(0, 4);
  const whole = period.kind !== 'all' && first === period.from && last === period.to && !cover.notMeasured;
  if (whole) return `In ${period.label}`;
  if (period.kind === 'custom' || period.kind === 'last')
    return `From ${shortDay(first, years)} to ${shortDay(last, years)}`;
  return `Since ${shortDay(first, years)}`;
}
/** How far a provisional newest row counts: its UTC day and "10:00"; null for none (or a reply without the field). */
export function soFarOf(upTo: number | null | undefined) {
  if (upTo === null || upTo === undefined || !Number.isFinite(upTo)) return null;
  const iso = new Date(upTo).toISOString();
  return { day: iso.slice(0, 10), time: iso.slice(11, 16) };
}
/** "Sat 21 Nov". */
export const weekdayName = (day: string) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));

/** Every day from the first to the newest closed day of the read, a day with no row at zero: a day closes only
 * when it had landings and a later one landed, so a gap between closed days had none. Before the first closed day
 * nothing is drawn (Stats may not have been recording yet). A day whose close did not finish stays null: missing,
 * never zero. */
export function filledDays(perDay: Array<[string, number | null]>): Array<[string, number | null]> {
  if (!perDay.length) return [];
  const have = new Map(perDay),
    out: Array<[string, number | null]> = [];
  const end = Date.parse(`${perDay.at(-1)![0]}T00:00:00Z`);
  for (let t = Date.parse(`${perDay[0]![0]}T00:00:00Z`); t <= end; t += 86_400_000)
    out.push([utc(t), have.has(utc(t)) ? have.get(utc(t))! : 0]);
  return out;
}

export const int = (n: number) => Math.round(n).toLocaleString('en');
/** CI minutes: whole minutes from 100, one decimal below. */
export const minutes = (n: number) =>
  Math.abs(n) >= 100 ? int(n) : (Math.round(n * 10) / 10).toLocaleString('en');
export function duration(seconds: number | null) {
  if (seconds === null) return 'not recorded';
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
/** Bar label: m:ss under an hour. */
export const clock = (seconds: number) => {
  const s = Math.round(seconds);
  return s >= 3600 ? duration(s) : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const percent = (rate: number | null) =>
  rate === null ? 'not counted' : `${Math.round(rate * 100)}%`;
export const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;

/** Why a window has no comparison, in the page's words (src/stats-estimate.ts#statsWindow `compare`): never "0
 * landings to go" for days that simply were not recorded. */
export function gapWords(w: Pick<StatsWindow, 'compare' | 'daysWithoutRuns'>) {
  if (w.compare.gap === 'not-recorded')
    return {
      title: 'No comparison for these days',
      text: `${plural(w.daysWithoutRuns, 'day')} here closed before Stats recorded every check run, so ${w.daysWithoutRuns === 1 ? 'its' : 'their'} CI figures are not recorded and there is nothing fair to compare.`,
      short: 'not recorded',
    };
  if (w.compare.gap === 'no-solo')
    return {
      title: 'No comparison yet',
      text: 'No change here has run the whole check on its own yet, so there is no price for one GitHub run of this project.',
      short: 'no solo check yet',
    };
  return {
    title: `${plural(w.compare.toGo, 'landing')} to go`,
    text: 'Until then this page shows what was measured, with no comparison.',
    short: `${plural(w.compare.toGo, 'landing')} to go`,
  };
}

/** What a window with days read only in part says, once, on hover over the figure it affects (reviews b4dd69b4 finding
 * 3, d6b0f1aa finding 1, Item 3678767e); null when every day was read in full. A day's close reads a bounded number of
 * check runs, attempts and landings and stops while the transaction still has read room (convex/projectStatsRuns.ts,
 * convex/projectStats.ts): it samples, never guesses. Runs not read leave counts and minutes short (a lower bound;
 * Forge's minutes short, so minutes saved are at most those shown). Landings not read leave the landing count short, every
 * run spread over fewer landings (minutes per landing an upper bound), rates and medians covering only the landings read,
 * and the replays pricing only those (minutes saved at least those shown). */
export function partialWords(w: Pick<StatsWindow, 'partial' | 'partialLandings' | 'partialRuns'>) {
  if (!w.partial) return null;
  const effects = [
    w.partialRuns
      ? 'check runs read in part: runs and CI minutes are at least what is shown, so the minutes saved are at most these'
      : '',
    w.partialLandings
      ? `landings read in part: landings are at least what is shown, ${w.partialRuns ? 'CI minutes per landing may be more or fewer' : 'CI minutes per landing are at most what is shown'}, rates and times cover only the landings read, and the minutes saved are at least these`
      : '',
  ].filter(Boolean);
  return `A day’s close reads at most ${int(STATS_DAY_MAX_LANDINGS)} landings and a bounded number of check runs, oldest first, and stops early when its read room runs out, so a very busy day is counted from its start as far as it was read, never guessed. Some days here were: ${effects.join('; ')}. Where both apply, the minutes saved may be more or fewer.`;
}
/** A month read in part, by which way its replayed saving may be off (src/stats-period.ts month rows). */
export const monthPartWords = (w: Pick<StatsWindow, 'partialLandings' | 'partialRuns'>) =>
  w.partialRuns && w.partialLandings
    ? 'read in part: saving may be more or fewer'
    : w.partialRuns
      ? 'read in part: saving is at most this'
      : 'read in part: saving is at least this';

/** Bar heights (percent of the tallest), so every bar in one chart shares one scale. */
export function scale(values: number[]) {
  const top = Math.max(0, ...values);
  return values.map(v => (top > 0 ? Math.max(1, (v / top) * 100) : 0));
}

/** Dollars at GitHub's list price (src/stats-pricing.ts): whole dollars from $10, cents below. */
export const usd = (n: number) =>
  Math.abs(n) >= 10
    ? `$${Math.round(n).toLocaleString('en')}`
    : `$${(Math.round(n * 100) / 100).toLocaleString('en', { minimumFractionDigits: 2 })}`;
/** Hours of waiting, always in hours (no money value for people's time): one decimal below ten. */
export function hoursWords(seconds: number) {
  const h = Math.abs(seconds) / 3600;
  if (h < 10) return `${(Math.round(h * 10) / 10).toLocaleString('en')} ${h === 1 ? 'hour' : 'hours'}`;
  return plural(Math.round(h), 'hour');
}
/** A saving as a whole percent of what the baseline took; null without a baseline. */
export const savedPercent = (saved: number | null, baseline: number | null) =>
  saved === null || baseline === null || !(baseline > 0) ? null : Math.round((saved / baseline) * 100);
