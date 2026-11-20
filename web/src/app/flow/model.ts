// SPDX-License-Identifier: Apache-2.0
// The Flow picture's model (Item 85f456c1, direction B): every figure comes from the top bar's one line feed (convex/
// projectLiveLine.ts `read`, already subscribed by the shell) and the Needs me read the page already holds, so a stop's
// count here is the line's count for that stop (Line.tsx `lineStops`) and a held block's words are its Needs you row's.
// No read, timer or clock of its own: "today" and elapsed times are worked out from the feed's timestamps against the
// time the page was drawn. Pure.
import { flowToday } from '../../../../src/flow-day';
import { lineStops, type LineFeed, type LineStop } from '../Line';
import type { StateWord } from '../../ds';

/** A block's colour (the state tokens) and the glyph cut into its top. */
type BlockState = 'active' | 'waiting' | 'failed' | 'conflict';
export type Block = {
  laneId: string;
  colour: BlockState;
  /** The glyph on top: a hole (waits on a person), a cross (failed), a diamond (conflict), or none. */
  shape: '' | 'waiting' | 'failed' | 'conflict';
  /** Waits on a person: it has a row under Needs you, which its tag links to. */
  needsYou: boolean;
  /** The few words its tag and title say. */
  word: string;
  /** Its Needs you row's head and person, when the page has them. */
  head: string | null;
  who: string | null;
  /** The check it is in; Lanes checked together stand as one tower. */
  check: string | null;
  passed: boolean;
};
export type Station = {
  stop: LineStop;
  name: string;
  n: number;
  held: Block[];
  blocks: Block[];
  /** Checks running here (Checking only), largest first, as tower sizes. */
  checks: number[];
  /** Checks that passed and wait to land (Checking only). */
  passed: number;
};
/** What Needs you knows of a held Lane: its row's state word, head and person. */
export type HeldRow = { laneId: string; word: StateWord; tag: string; head: string; who: string | null };

const colourOf = (word: StateWord): BlockState =>
  word === 'Check failed' || word === 'Not run' ? 'failed' : word === 'Conflict' ? 'conflict' : 'waiting';

/** The picture's stations, from the feed and the Needs you rows. Moving work first (oldest first), held work last, so
 * a held block stands in front. */
export function flowStations(feed: LineFeed | undefined, rows: readonly HeldRow[]): Station[] {
  const byLane = new Map(rows.map(row => [row.laneId, row]));
  const lanes = feed?.lanes ?? [];
  return lineStops.map(stop => {
    const at = lanes
      .filter(lane => stop.of.includes(lane.stage))
      .sort((a, b) => Number(a.held) - Number(b.held) || a.changedAt - b.changedAt);
    const blocks = at.map((lane): Block => {
      const row = lane.held && !lane.mainRed ? byLane.get(lane.laneId) : undefined;
      const colour: BlockState = lane.mainRed
        ? 'waiting'
        : row
          ? colourOf(row.word)
          : lane.held
            ? lane.overlap
              ? 'conflict'
              : 'waiting'
            : lane.stage === 'queued'
              ? 'waiting'
              : 'active';
      return {
        laneId: lane.laneId,
        colour,
        shape: lane.held && !lane.mainRed && colour !== 'active' ? colour : '',
        needsYou: !!row,
        word: lane.mainRed
          ? 'main is failing'
          : row
            ? row.tag
            : lane.held
              ? lane.overlap
                ? 'Conflict'
                : 'Held'
              : lane.stage === 'ready'
                ? 'Passed'
                : stop.label,
        head: row?.head ?? null,
        who: row?.who ?? null,
        check: lane.stage === 'checking' && lane.check ? lane.check : null,
        passed: lane.stage === 'ready' && !lane.held,
      };
    });
    const sizes = new Map<string, number>();
    for (const block of blocks) if (block.check) sizes.set(block.check, (sizes.get(block.check) ?? 0) + 1);
    return {
      stop: stop.stage,
      name: stop.label,
      n: at.length,
      held: blocks.filter(block => block.shape !== '' || block.word === 'main is failing'),
      blocks,
      checks: [...sizes.values()].sort((a, b) => b - a),
      passed: blocks.filter(block => block.passed).length,
    };
  });
}

/** The day's figures under the picture, in the reader's day. */
export function flowFigures(feed: LineFeed | undefined, drawnAt: number) {
  const midnight = new Date(drawnAt);
  midnight.setHours(0, 0, 0, 0);
  const today = flowToday(feed?.flow, drawnAt, midnight.getTime());
  const main = feed?.flow?.main;
  return { ...today, red: main?.red === true, since: main ? main.since : null };
}

export function duration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** "08:12" today, or the date and time before today, in the reader's time. */
export function clock(at: number, drawnAt: number) {
  const day = new Date(drawnAt);
  day.setHours(0, 0, 0, 0);
  const time = new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return at >= day.getTime()
    ? time
    : `${new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
}

/** The last part of a handle, for a tag: "salt-wren" from "mara/salt-wren". */
export const shortWho = (who: string | null) => (who ? (who.split('/').pop() ?? who) : null);
