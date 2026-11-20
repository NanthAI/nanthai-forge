// SPDX-License-Identifier: Apache-2.0
// Stats screen model (Items 2cf30e0a, a61d3c91): the chosen period, the read reply of convex/projectStats.ts and the
// words the screen prints. Figures come only from the project's own closed days (src/stats-period.ts); nothing here
// estimates.
import type { StatsCover, StatsHead } from '../../../../src/stats-period';
import { STATS_RANGE_MAX_DAYS, rangeDays, validRange } from '../../../../src/stats-period';

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
/** The closed days the figures cover, until the whole period has closed: "over 17–18 Nov 2026 (2 closed days)", never
 * "in November 2026" for two days. A day not measured (its close did not finish) is not a closed day: it is in neither
 * the span nor the count, and a period holding one has not wholly closed. */
export function coverWords(period: Period, cover: StatsCover) {
  const { first, last } = cover;
  if (first === null || last === null) return periodWords(period);
  if (period.kind !== 'all' && first === period.from && last === period.to && !cover.notMeasured)
    return periodWords(period);
  const closed = `(${plural(cover.closed, 'closed day')})`;
  if (first === last) return `on ${shortDay(first, true)} ${closed}`;
  const span =
    first.slice(0, 7) === last.slice(0, 7)
      ? `${Number(first.slice(8))}–${shortDay(last, true)}`
      : `${shortDay(first, first.slice(0, 4) !== last.slice(0, 4))} – ${shortDay(last, true)}`;
  return `over ${span} ${closed}`;
}

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

/** What a window with days read only in part may say (reviews b4dd69b4 finding 3, d6b0f1aa finding 1); null when every
 * day was read in full. Runs not read leave counts and minutes short: a lower bound. Landings not read leave the landing
 * count short and every run spread over fewer landings, so minutes per landing are an upper bound; rates and medians
 * cover only the landings read, no bound either way. Saved minutes: runs not read leave Forge's minutes short (fewer
 * saved than shown), landings not read leave the replays short (more saved than shown). */
export function partialWords(w: Pick<StatsWindow, 'partial' | 'partialLandings' | 'partialRuns'>) {
  if (!w.partial) return null;
  const measured = [
    w.partialRuns
      ? 'Some days had more check runs than one day’s close reads, and the rest were not counted: runs and CI minutes are a lower bound.'
      : '',
    w.partialLandings
      ? `Some days had more landings than one day’s close reads: landings are a lower bound, ${
          w.partialRuns
            ? 'CI minutes per landing may be more or fewer than shown'
            : 'CI minutes per landing an upper bound (every run, over fewer landings)'
        }, and first-try rate and times cover only the landings read.`
      : '',
  ];
  return {
    measured: measured.filter(Boolean).join(' '),
    saved: savedWords(w),
  };
}
const savedWords = (w: Pick<StatsWindow, 'partialLandings' | 'partialRuns'>) =>
  w.partialRuns && w.partialLandings
    ? 'Some days were read only in part, both their landings and their check runs, so the minutes saved may be more or fewer than shown.'
    : w.partialRuns
      ? 'Some days’ check runs were read only in part, so Forge used at least these minutes: the minutes saved are an upper bound.'
      : 'Some days’ landings were read only in part, and the replays price only those read: the minutes saved are a lower bound.';
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
