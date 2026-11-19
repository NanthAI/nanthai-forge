// SPDX-License-Identifier: Apache-2.0
import { STATS_COMPARE_MIN_LANDINGS, statsWindow, type StatsDay } from './stats-estimate.js';

/** Stats for one chosen period (Item a61d3c91): the screen asks for a range of closed UTC days and the read
 * (convex/projectStats.ts) re-aggregates every figure from those day rows only. A range holds at most
 * STATS_RANGE_MAX_DAYS days, so a read is at most that many rows; the figures' methods stay statsWindow's. */
export const STATS_RANGE_MAX_DAYS = 92;
export type StatsRange = { from: string; to: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const at = (day: string) => Date.parse(`${day}T00:00:00Z`);
const real = (day: string) => DAY.test(day) && new Date(at(day)).toISOString().slice(0, 10) === day;
/** Days in a range, both ends included; 0 for a range that is not a real, ordered pair of days. */
export function rangeDays({ from, to }: StatsRange) {
  if (!real(from) || !real(to) || to < from) return 0;
  return Math.round((at(to) - at(from)) / 86_400_000) + 1;
}
export const validRange = (range: StatsRange) => {
  const n = rangeDays(range);
  return n > 0 && n <= STATS_RANGE_MAX_DAYS;
};

/** First-try buckets for "By agent": a fixed four, so the list never grows with the number of agents. */
export const FIRST_TRY_BUCKETS = [
  { label: '100%', min: 1 },
  { label: '75–99%', min: 0.75 },
  { label: '50–74%', min: 0.5 },
  { label: 'Under 50%', min: 0 },
] as const;
type Who = ReturnType<typeof statsWindow>['who'];
export function firstTryBuckets(who: Who) {
  const buckets = FIRST_TRY_BUCKETS.map(b => ({ label: b.label, agents: 0, landings: 0 }));
  const notCounted = { agents: 0, landings: 0 };
  for (const row of who) {
    const rate = row.firstTryRate;
    const into = rate === null ? notCounted : buckets[FIRST_TRY_BUCKETS.findIndex(b => rate >= b.min)]!;
    into.agents++;
    into.landings += row.landings;
  }
  return { buckets, notCounted };
}

/** What one read returns: `head` (opened with the page: the headline figures and landings per day) or one fold,
 * fetched only once that fold is opened. Every part reads the same day rows; each returns only its own figures. */
export const STATS_PARTS = ['head', 'waited', 'agents', 'months'] as const;
export type StatsPart = (typeof STATS_PARTS)[number];

/** The read's reply for one range of closed days (oldest first) and one part. */
export function statsRangeReply(days: readonly StatsDay[], range: StatsRange, part: StatsPart = 'head') {
  const { who, measured, ...window } = statsWindow(days);
  const { stops, ...headline } = measured;
  const base = {
    schema: 2 as const,
    part,
    from: range.from,
    to: range.to,
    /** The newest closed day in the range, or null when none has closed. */
    through: days.at(-1)?.day ?? null,
    landings: window.landings,
  };
  if (part === 'waited') return { ...base, stops };
  if (part === 'agents')
    return { ...base, agents: who.length, others: window.others, ...firstTryBuckets(who) };
  if (part === 'months') {
    const months = [...new Set(days.map(d => d.day.slice(0, 7)))];
    return {
      ...base,
      months: months.map(month => {
        const m = statsWindow(days.filter(d => d.day.startsWith(month)));
        return {
          month,
          landings: m.landings,
          toMainSeconds: m.measured.toMainSeconds,
          ciMinutes: m.measured.ciMinutes,
          savedAtLeast: m.comparison?.savedMinutes.atLeast ?? null,
        };
      }),
    };
  }
  return {
    ...base,
    compareFrom: STATS_COMPARE_MIN_LANDINGS,
    perDay: days.map(d => [d.day, d.landings] as [string, number]),
    window: { ...window, measured: headline },
  };
}
export type StatsHead = Extract<ReturnType<typeof statsRangeReply>, { perDay: unknown }>;
export type StatsWaited = Extract<ReturnType<typeof statsRangeReply>, { stops: unknown }>;
export type StatsAgents = Extract<ReturnType<typeof statsRangeReply>, { buckets: unknown }>;
export type StatsMonths = Extract<ReturnType<typeof statsRangeReply>, { months: unknown }>;
