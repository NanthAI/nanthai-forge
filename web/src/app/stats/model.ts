// SPDX-License-Identifier: Apache-2.0
// Stats screen model (Items 2cf30e0a, a61d3c91): the read reply of convex/projectStats.ts and the words the screen
// prints. Figures come only from the project's own closed days (src/stats-estimate.ts); nothing here estimates.
import type { statsWindow } from '../../../../src/stats-estimate';

export type StatsWindow = ReturnType<typeof statsWindow>;
export type StatsRead = {
  schema: 1;
  /** Landings a window needs before the replay is shown (STATS_COMPARE_MIN_LANDINGS). */
  compareFrom: number;
  /** The newest closed day, or null before the first close. */
  through: string | null;
  perDay: Array<[string, number]>;
  months: Array<StatsWindow & { month: string }>;
  all: StatsWindow & { from: string | null };
};
export type Period = { key: string; label: string; window: StatsWindow; days: Array<[string, number]> };

const monthName = (month: string) =>
  new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
export const dayName = (day: string) =>
  new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );

/** Each month with closed days, newest first, then the whole read. */
export function periods(data: StatsRead): Period[] {
  const list: Period[] = data.months.map(m => ({
    key: m.month,
    label: monthName(m.month),
    window: m,
    days: data.perDay.filter(([day]) => day.startsWith(m.month)),
  }));
  if (data.months.length > 1)
    list.push({
      key: 'all',
      label: `Last ${data.all.days} closed days`,
      window: data.all,
      days: data.perDay,
    });
  return list;
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
export const toGo = (data: StatsRead, window: StatsWindow) => Math.max(0, data.compareFrom - window.landings);

/** Bar heights (percent of the tallest), so every bar in one chart shares one scale. */
export function scale(values: number[]) {
  const top = Math.max(0, ...values);
  return values.map(v => (top > 0 ? Math.max(1, (v / top) * 100) : 0));
}
