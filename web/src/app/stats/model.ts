// SPDX-License-Identifier: Apache-2.0
// Stats screen model (Items 2cf30e0a, a61d3c91): the chosen period, the read reply of convex/projectStats.ts and the
// words the screen prints. Figures come only from the project's own closed days (src/stats-period.ts); nothing here
// estimates.
import type { StatsHead } from '../../../../src/stats-period';
import { STATS_RANGE_MAX_DAYS, rangeDays, validRange } from '../../../../src/stats-period';

export type StatsRead = StatsHead;
export type StatsWindow = StatsRead['window'];
export type PeriodKind = '7' | '30' | 'this' | 'last' | 'custom';
/** The page's one period picker, in the address as `?period=7|30|last` (this month is the plain address). */
export const PERIODS: { value: PeriodKind; text: string }[] = [
  { value: '7', text: 'Last 7 days' },
  { value: '30', text: 'Last 30 days' },
  { value: 'this', text: 'This month' },
  { value: 'last', text: 'Last month' },
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
 * Months are UTC calendar months, the days the close files landings under. */
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
  if (kind === '7' || kind === '30') {
    const n = Number(kind);
    return { kind, from: utc(now - (n - 1) * 86_400_000), to: utc(now), label: `the last ${n} days` };
  }
  const last = kind === 'last';
  const range = monthOf(today.getUTCFullYear(), today.getUTCMonth() - (last ? 1 : 0));
  return { kind: last ? 'last' : 'this', ...range, label: monthName(range.from.slice(0, 7)) };
}
/** "in November 2026" or "from 3 Nov to 18 Nov 2026". */
export const periodWords = (p: Period) =>
  p.kind === 'custom' && !p.error ? `from ${p.label}` : `in ${p.label}`;
/** The closed days the figures cover, until the whole period has closed: "over 17–18 Nov 2026 (2 closed days)", never
 * "in November 2026" for two days. */
export function coverWords(period: Period, perDay: Array<[string, number]>) {
  if (!perDay.length) return periodWords(period);
  const first = perDay[0]![0],
    last = perDay.at(-1)![0];
  if (first === period.from && last === period.to) return periodWords(period);
  const closed = `(${plural(perDay.length, 'closed day')})`;
  if (first === last) return `on ${shortDay(first, true)} ${closed}`;
  const span =
    first.slice(0, 7) === last.slice(0, 7)
      ? `${Number(first.slice(8))}–${shortDay(last, true)}`
      : `${shortDay(first, first.slice(0, 4) !== last.slice(0, 4))} – ${shortDay(last, true)}`;
  return `over ${span} ${closed}`;
}

/** Every day from the first to the newest closed day of the read, a day with no row at zero: a day closes only
 * when it had landings and a later one landed, so a gap between closed days had none. Before the first closed day
 * nothing is drawn (Stats may not have been recording yet). */
export function filledDays(perDay: Array<[string, number]>): Array<[string, number]> {
  if (!perDay.length) return [];
  const have = new Map(perDay),
    out: Array<[string, number]> = [];
  const end = Date.parse(`${perDay.at(-1)![0]}T00:00:00Z`);
  for (let t = Date.parse(`${perDay[0]![0]}T00:00:00Z`); t <= end; t += 86_400_000)
    out.push([utc(t), have.get(utc(t)) ?? 0]);
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

/** Landings still needed before the replay is shown, or 0. */
export const toGo = (data: StatsRead) => Math.max(0, data.compareFrom - data.window.landings);

/** Bar heights (percent of the tallest), so every bar in one chart shares one scale. */
export function scale(values: number[]) {
  const top = Math.max(0, ...values);
  return values.map(v => (top > 0 ? Math.max(1, (v / top) * 100) : 0));
}
