// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The Flow picture's model (Item 85f456c1, direction B): every figure comes from the top bar's one line feed (convex/
// projectLiveLine.ts `read`, already subscribed by the shell) and the Needs me read the page already holds, so a stop's
// count here is the line's count for that stop (Line.tsx `lineStops`) and a held block's words are its Needs you row's.
// No read, timer or clock of its own: "today" and elapsed times are worked out from the feed's timestamps against the
// time the page was drawn. Pure.
import { flowToday, flowVerdict, mainFailedToday, utcDayStart } from '../../../../src/flow-day';
import { lineStopCounts, lineStops, type LineFeed, type LineStage, type LineStop } from '../Line';
import { CONFLICT_HOVER, conflictTip, isConflict, type ConflictNote } from '../lane-state';
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
  /** The Lane is held (waits on someone or something); a Conflict block of a saved Lane is drawn but not held. */
  held: boolean;
  /** The few words its tag and title say. */
  word: string;
  /** A Conflict block's hover: with whom, in how many files, the first file (lane-state.ts `conflictTip`). */
  why: string | null;
  /** Its Needs you row's head and person, when the page has them. */
  head: string | null;
  who: string | null;
  /** The check it is in; Lanes checked together stand as one tower. */
  check: string | null;
  passed: boolean;
  running: boolean;
};
export type Station = {
  stop: LineStop;
  name: string;
  n: number;
  count: number;
  held: Block[];
  /** The blocks drawn: every Lane, or past the feed's cap only the held ones, in front of the solid. */
  blocks: Block[];
  /** Every Lane at this stop, drawn or not (the drawer lists them). */
  allBlocks: Block[];
  /** Past the feed's cap (more open Lanes than it lists): the moving Lanes here, drawn as one solid. */
  solid: number;
  /** Checks that passed and wait to land (Checking only). */
  passed: number;
};
/** What Needs you knows of a held Lane: its row's state word, head and person. */
export type HeldRow = {
  laneId: string | null;
  word: StateWord;
  tag: string;
  head: string;
  who: string | null;
};

const colourOf = (word: StateWord): BlockState =>
  word === 'Check failed' || word === 'Not run' ? 'failed' : word === 'Conflict' ? 'conflict' : 'waiting';

/** How a block looks: its colour and the glyph cut into its top. */
export type Look = { colour: BlockState; shape: Block['shape'] };

/** THE rule for how a Lane's block looks; `flowStations` draws with it and the legend (`looks`) is checked against
 * every input it can take (tests/lanes-place.test.mjs), so a look the picture draws always has a legend entry and the
 * legend has none the picture never draws. `row` is the word of the Lane's Needs you row, for a held Lane that has one. */
export function blockLook(lane: {
  mainRed: boolean;
  held: boolean;
  conflict: boolean;
  stage: LineStage;
  row?: StateWord | undefined;
}): Look {
  // A Needs you row is only ever a held Lane's.
  const row = lane.held && !lane.mainRed ? lane.row : undefined;
  const colour: BlockState = lane.mainRed
    ? 'waiting'
    : row
      ? colourOf(row)
      : lane.conflict
        ? 'conflict'
        : lane.held || lane.stage === 'queued' || lane.stage === 'ready'
          ? 'waiting'
          : 'active';
  return {
    colour,
    shape: (lane.held || colour === 'conflict') && !lane.mainRed && colour !== 'active' ? colour : '',
  };
}

/** The Flow legend: every look `blockLook` can give, one short word each, the meaning said on hover only. */
export const looks = [
  {
    word: 'Working',
    colour: 'active',
    shape: '',
    meaning: 'A Lane is being worked on or its check is running.',
  },
  {
    word: 'Waiting its turn',
    colour: 'waiting',
    shape: '',
    meaning: 'A Lane is queued, passed and waits to land, or waits for another Lane to land.',
  },
  {
    word: 'Held',
    colour: 'waiting',
    shape: 'waiting',
    meaning:
      'A Lane is held: it waits for your approval or an answer (Needs you lists these), or for its agent.',
  },
  {
    word: 'Check failed',
    colour: 'failed',
    shape: 'failed',
    meaning: 'A Lane’s check failed; its agent fixes it.',
  },
  { word: 'Conflict', colour: 'conflict', shape: 'conflict', meaning: CONFLICT_HOVER },
] as const satisfies readonly (Look & { word: string; meaning: string })[];

/** The picture's stations, from the feed and the Needs you rows. Moving work first (oldest first), held work last, so
 * a held block stands in front. */
export function flowStations(
  feed: LineFeed | undefined,
  rows: readonly HeldRow[],
  /** Each Conflict Lane's open notices, when the page holds them (Lane page read), for its hover. */
  notes?: ReadonlyMap<string, readonly ConflictNote[] | undefined>,
): Station[] {
  const byLane = new Map(rows.map(row => [row.laneId, row]));
  const lanes = feed?.lanes ?? [];
  return lineStops.map(stop => {
    const { total, count, passed } = lineStopCounts(feed, stop);
    const at = lanes
      .filter(lane => stop.of.includes(lane.stage))
      .sort((a, b) => Number(a.held) - Number(b.held) || a.changedAt - b.changedAt);
    const blocks = at.map((lane): Block => {
      const row = lane.held && !lane.mainRed ? byLane.get(lane.laneId) : undefined;
      const conflict = isConflict(lane);
      const { colour, shape } = blockLook({
        mainRed: !!lane.mainRed,
        held: lane.held,
        conflict,
        stage: lane.stage,
        row: row?.word,
      });
      return {
        laneId: lane.laneId,
        colour,
        shape,
        needsYou: !!row,
        held: lane.held,
        why: colour === 'conflict' && !lane.mainRed ? conflictTip(notes?.get(lane.laneId)) : null,
        word: lane.mainRed
          ? 'main is failing'
          : row
            ? row.tag
            : conflict
              ? 'Conflict'
              : lane.held
                ? 'Held'
                : lane.stage === 'ready'
                  ? 'Passed, waiting to land'
                  : stop.label,
        head: row?.head ?? null,
        who: row?.who ?? null,
        check: lane.stage === 'checking' && lane.check ? lane.check : null,
        running: !lane.held && (lane.stage === 'editing' || lane.stage === 'checking'),
        passed: lane.stage === 'ready' && !lane.held,
      };
    });
    const held = blocks.filter(block => block.shape !== '' || block.word === 'main is failing');
    // Past the cap the feed lists 60 Lanes, held ones first, and counts the rest: the picture draws counts per stop,
    // with held Lanes still as blocks (the line's rule; lead 2026-11-20).
    const over = (feed?.more ?? 0) > 0;
    return {
      stop: stop.stage,
      name: stop.label,
      n: total,
      count,
      held,
      blocks: over ? held : blocks,
      allBlocks: blocks,
      solid: over ? blocks.length - held.length : 0,
      passed,
    };
  });
}

/** The day's figures under the picture, in the project day (UTC, as the top bar and Stats count it). */
export function flowFigures(feed: LineFeed | undefined, drawnAt: number) {
  const today = flowToday(feed?.flow, drawnAt, utcDayStart(drawnAt));
  const verdict = flowVerdict(feed?.flow);
  return { ...today, failed: mainFailedToday(today), red: verdict?.red === true, verdict };
}

export const unverifiedMain = (checksConfigured: boolean | undefined) =>
  checksConfigured === false ? 'main not checked' : 'main health not reported';

export function mainHealth(
  verdict: ReturnType<typeof flowVerdict>,
  checkedAt: number | undefined,
  drawnAt: number,
) {
  if (!verdict) return null;
  // Red says since when where it is read, not only on hover (Item 8d21cc9e), and names its red view when known.
  if (verdict.red) {
    // A red that began before the project day (UTC) gives its date, as "main failed today" counts it on that day.
    const word =
      verdict.since === null
        ? 'main red'
        : `main red since ${verdict.since < utcDayStart(drawnAt) ? dated(verdict.since) : clock(verdict.since, drawnAt)}`;
    return {
      word,
      state: 'failed' as const,
      title: verdict.since === null ? 'A check of main failed' : word,
      red: verdict.sequence ?? null,
    };
  }
  // FYI and the line arrive independently. A pass from an earlier green streak
  // cannot date the check that ended a more recent red.
  const time =
    checkedAt !== undefined && checkedAt >= (verdict.since ?? -Infinity)
      ? ` at ${clock(checkedAt, drawnAt)}`
      : '';
  return {
    word: 'main green',
    state: 'passed' as const,
    title: `Latest full check of main passed${time}`,
    red: null,
  };
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
  return at >= day.getTime() ? timeOf(at) : dated(at);
}
const timeOf = (at: number) =>
  new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
/** "22 Nov 23:50", in the reader's time. */
const dated = (at: number) =>
  `${new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${timeOf(at)}`;

/** The last part of a handle for a tag, such as the agent name in "mara/salt-wren". */
export const shortWho = (who: string | null) => (who ? (who.split('/').pop() ?? who) : null);
