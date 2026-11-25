// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';

/** Speed budget ratchet (Issue a217b83e), an automatic setting judged inside the landing that already
 * writes the budget row (below); no call, read or timer of its own. Pure math, split out of landing-speed-alerts
 * (Item 4e8d6bbf); the MCP module ceiling counts this module (the CLI never loads it).
 * - Signal: the worst rolling-window value of each landing-judged percentile budget per UTC day.
 * - Formula: after RATCHET_DAYS closed days with landings, every one at or under the line, the line
 *   becomes max(worst held day, today's value so far, median of the held days + band), rounded up to
 *   two significant figures. The band is 3 x 1.4826 x the held days' MAD, never under 15% of the line:
 *   the signal is a smoothed rolling percentile, so its day-to-day MAD understates real spread.
 * - Bounds: never above the file's `max` (a line never loosens past it by itself), never below the
 *   value judged now or the worst held day, so the data that set a line cannot break it.
 * - Undo: a window over a ratcheted line but at or under the file `max` is not a P0. The ratchet is
 *   undone (back to the line before it, or the file `max` when the value is over that too) with a
 *   recorded reason and one message. Only the file `max` opens the P0 Issue.
 * - Override: `"ratchet": false` pins a budget to its file `max` (any ratcheted line is dropped; held
 *   days still count, so the report shows what the automatic line would be); editing `max` in
 *   src/speed-budgets.json, with the data and reason, replaces any ratcheted line and restarts the hold.
 * - Top metric: the budget's own statistic; it interacts with its own break and recovery only. Each undo
 *   also records the shared flow metric it could have moved (lead note on a217b83e, Forge adapts): how
 *   many landings landed while the tighter line held, and how many of their outcomes it changed. That is
 *   0 by construction: no landing, queue or acceptance path reads a speed line, only these alerts do.
 *   The keep rule (fa2c1383) reads the row's check samples for measured costs, never a line
 *   (tests/speed-budget-shift-waste.test.mjs lists every reader of the speed row and fails on a new one). */
export const RATCHET_DAYS = 7;
/** Undo records kept per budget, newest last. */
const UNDOS_KEPT = 4;
/** Landing outcomes a speed line can change: none, it only sends alerts (see the reader guard above). */
export const LINE_OUTCOMES_CHANGED = 0;
/** The band's floor as a share of the current line. */
export const MIN_BAND = 0.15;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const ratchetEntrySchema = z
  .object({
    /** Today's worst window value so far; it joins `days` once a later day's landing closes it. */
    open: z.tuple([day, z.number()]).optional(),
    /** The worst value of each closed day with landings while the line held, oldest first. */
    days: z.array(z.tuple([day, z.number()])).max(RATCHET_DAYS),
    /** The ratcheted line, the file `max` it tightened (a different file `max` drops it), and the
     * line it replaced (an undo returns there). */
    line: z.number().nonnegative().optional(),
    fromMax: z.number().nonnegative().optional(),
    from: z.number().nonnegative().optional(),
    at: z.iso.datetime().optional(),
    landing: z.string().optional(),
    reason: z.string().max(400).optional(),
    /** Each undo: [day, tightened line, line back to, landings landed while it held (in the retained
     * row, so at most 40), landing outcomes it changed]. Newest last. */
    undos: z
      .array(
        z.tuple([
          day,
          z.number(),
          z.number(),
          z.number().int().nonnegative(),
          z.number().int().nonnegative(),
        ]),
      )
      .max(UNDOS_KEPT)
      .optional(),
  })
  .strict();
export type RatchetEntry = z.infer<typeof ratchetEntrySchema>;

/** The line a budget is judged against: the file `max` when pinned, else the ratcheted line while the
 * file `max` it came from stands. */
export const ratchetedLine = (max: number, entry?: RatchetEntry, pinned = false) =>
  !pinned && entry?.line !== undefined && entry.fromMax === max ? Math.min(entry.line, max) : max;

/** Round up to two significant figures, so a line reads as a plain number in any unit. */
function roundUp2(value: number) {
  if (!(value > 0)) return 0;
  const step = 10 ** (Math.floor(Math.log10(value)) - 1);
  return Number((Math.ceil(value / step - 1e-9) * step).toPrecision(2));
}
export const ratchetMedian = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b),
    middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
export const round3 = (n: number) => Number(n.toPrecision(3));
/** The line the held days support: their median plus the noise band, never below the worst held day
 * or the value judged now. */
function ratchetTarget(days: number[], line: number, now: number) {
  const mid = ratchetMedian(days),
    band = Math.max(3 * 1.4826 * ratchetMedian(days.map(value => Math.abs(value - mid))), MIN_BAND * line),
    floor = Math.max(...days, now);
  return { median: mid, band, floor, line: roundUp2(Math.max(floor, mid + band)) };
}

type RatchetStep = {
  entry: RatchetEntry;
  /** The line judged after this landing. */
  line: number;
  /** Set when this landing tightened the line. */
  ratcheted?: { from: number; to: number; reason: string };
  /** Set when this landing's value broke a ratcheted line at or under the file max. */
  undone?: { from: number; to: number; reason: string; landed: number; changed: number };
};
const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10);
/** Pure: fold one landing's window value into the budget's entry. `at` is the landing's time. */
export function stepRatchet(
  previous: RatchetEntry | undefined,
  value: number,
  max: number,
  at: number,
  landing: string,
  pinned = false,
  /** Landings landed since the line tightened (from the retained row), for the undo's flow record. */
  landedSince = 0,
  /** A day budget: `value` is a whole closed day, held (or not) at once instead of on the next day. */
  closedDay = false,
): RatchetStep {
  // A changed file line is a manual override: drop the old ratchet and start a new hold.
  const kept =
    previous && (previous.fromMax === undefined || previous.fromMax === max) ? previous : undefined;
  let line = ratchetedLine(max, kept, pinned);
  const today = isoDay(at);
  let open = kept?.open,
    days: [string, number][] = [...(kept?.days ?? [])];
  if (open && open[0] < today) {
    // A closed day over the line breaks the hold.
    days = open[1] <= line ? [...days, open].slice(-RATCHET_DAYS) : [];
    open = undefined;
  }
  open = open && open[0] === today ? [today, Math.max(open[1], value)] : [today, value];
  if (closedDay) {
    days = open[1] <= line ? [...days, open].slice(-RATCHET_DAYS) : [];
    open = undefined;
  }
  const opened = open ? { open } : {};
  // Pinned: judged at the file max; held days still count for the report's automatic line.
  if (pinned) return { entry: { ...opened, days }, line };
  if (kept?.line !== undefined && line < max && value > line) {
    // Over a ratcheted line: undo the ratchet, never a P0 unless the file max breaks too.
    const back = kept.from !== undefined && kept.from <= max && value <= kept.from ? kept.from : max;
    const since = kept.at ? Math.max(0, Math.floor((at - Date.parse(kept.at)) / 86_400_000)) : null;
    const changed = LINE_OUTCOMES_CHANGED;
    const reason =
      `Ratchet undone: the window reached ${value}, over the ratcheted line ${line}` +
      (since === null ? '' : ` ${since} day${since === 1 ? '' : 's'} after it tightened`) +
      `; line back to ${back}${back === max ? ' (the file max)' : ''}. ` +
      `Flow: ${landedSince} landing${landedSince === 1 ? '' : 's'} landed while it held; it changed ${changed} of their outcomes (a speed line only sends alerts).`;
    const undone = { from: line, to: back, reason, landed: landedSince, changed };
    const undos = [
      ...(kept.undos ?? []),
      [today, line, back, landedSince, changed] as [string, number, number, number, number],
    ].slice(-UNDOS_KEPT);
    line = back;
    return {
      entry:
        back < max
          ? {
              ...opened,
              days: [],
              line: back,
              fromMax: max,
              from: max,
              at: new Date(at).toISOString(),
              landing,
              reason,
              undos,
            }
          : { ...opened, days: [], undos },
      line,
      ...(value <= max ? { undone } : {}),
    };
  }
  const base = {
    ...(kept?.line !== undefined ? { line: kept.line, fromMax: kept.fromMax } : {}),
    ...(kept?.from !== undefined ? { from: kept.from } : {}),
    ...(kept?.at ? { at: kept.at, landing: kept.landing, reason: kept.reason } : {}),
    ...(kept?.undos ? { undos: kept.undos } : {}),
  };
  const entry: RatchetEntry = { ...base, ...opened, days };
  if (days.length < RATCHET_DAYS) return { entry, line };
  const target = ratchetTarget(
    days.map(d => d[1]),
    line,
    open?.[1] ?? value,
  );
  if (!(target.line < line)) return { entry, line };
  const reason =
    `Held at or under ${line} for ${RATCHET_DAYS} closed days, ${days[0]![0]} to ${days.at(-1)![0]}: worst ${round3(target.floor)}, ` +
    `median ${round3(target.median)}, band ${round3(target.band)} (3 x 1.4826 x MAD, at least ${MIN_BAND * 100}% of the line); line ${line} -> ${target.line}.`;
  return {
    entry: {
      ...opened,
      days: [],
      line: target.line,
      fromMax: max,
      from: line,
      at: new Date(at).toISOString(),
      landing,
      reason,
      ...(kept?.undos ? { undos: kept.undos } : {}),
    },
    line: target.line,
    ratcheted: { from: line, to: target.line, reason },
  };
}

/** For the report: the line judged now, what the automatic rule would pick from the held days (a pinned
 * budget included), and the closed held days still needed before the next ratchet can happen. */
export function ratchetStatus(entry: RatchetEntry | undefined, max: number, pinned = false) {
  const line = ratchetedLine(max, entry, pinned);
  const days = entry?.days ?? [];
  const automatic =
    days.length >= RATCHET_DAYS
      ? Math.min(
          ratchetTarget(
            days.map(d => d[1]),
            line,
            entry?.open?.[1] ?? 0,
          ).line,
          line,
        )
      : null;
  return {
    line,
    pinned,
    automatic,
    daysLeft: Math.max(0, RATCHET_DAYS - days.length),
    ...(entry?.line !== undefined && entry.fromMax === max && !pinned
      ? { since: entry.at ?? null, reason: entry.reason ?? null }
      : {}),
  };
}
