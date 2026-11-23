// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// A station's drawer (Item 85f456c1, the approved home mock): the Lanes at one stop, when each arrived there, what waits
// on the reader first; Checking grouped by check; main as the newest landings. The stop's Lanes and their times come
// from the line feed the page already holds; titles and people come from the one read the drawer makes while open (the
// Lanes list for a Lane stop, the newest landings for main). Pure.
import type { LineFeed, LineStop } from '../Line';
import type { LaneMeta } from '../lanes/model';
import type { Landed } from '../lanes/reads';
import { flowStations, type Block, type HeldRow } from './model';

export type DrawerStop = LineStop | 'main';
export const DRAWER_STOPS: readonly DrawerStop[] = ['editing', 'saved', 'queued', 'checking', 'main'];
export const isDrawerStop = (value: string | null): value is DrawerStop =>
  DRAWER_STOPS.includes(value as DrawerStop);

/** The river's span: three hours to now on a log scale, so the last minutes have room. */
const SPAN = 3 * 3_600_000;
const TAU = 20_000;
/** Where an age (ms before now) sits on the axis, 0 (three hours or more ago) to 1 (now). */
export const axisAt = (ms: number) =>
  1 - Math.log1p(Math.min(Math.max(ms, 0), SPAN) / TAU) / Math.log1p(SPAN / TAU);
export const TICKS: readonly [number, string][] = [
  [3_600_000, '1 h'],
  [600_000, '10 min'],
  [60_000, '1 min'],
  [0, 'now'],
];
/** Rows shown before "Show more"; each press shows this many more (the mock's 10, then 20). */
export const FIRST_ROWS = 10;
export const MORE_ROWS = 20;

export type RiverRow = {
  id: string;
  title: string;
  who: string | null;
  /** Its state word when held, else null. */
  block: Block | null;
  /** How long ago it arrived (ms), and how long it has been there. */
  ago: number;
  needsYou: boolean;
};
export type LaneGroup = {
  key: string;
  title: string;
  hint: string | null;
  check: string | null;
  rows: RiverRow[];
};
export type LaneDrawer = {
  kind: 'lanes';
  stop: LineStop;
  name: string;
  here: number;
  held: number;
  longest: number | null;
  groups: LaneGroup[];
  /** Lanes past the feed's cap are counted, not listed by stop. */
  more: number;
};
export type MainDrawer = {
  kind: 'main';
  today: number;
  rows: { id: string; title: string; who: string | null; ago: number }[];
};

const titleOf = (meta: LaneMeta | undefined, laneId: string) =>
  meta?.intent?.trim() || `Lane ${laneId.slice(0, 8)}`;
const whoOf = (meta: LaneMeta | undefined) => meta?.actor ?? null;

/** A Lane stop's drawer: held Lanes that wait on the reader first, then (at Checking) one group per check, then the
 * rest, longest here first. */
export function laneDrawer(
  feed: LineFeed | undefined,
  rows: readonly HeldRow[],
  stop: LineStop,
  lanes: readonly LaneMeta[] | undefined,
  drawnAt: number,
): LaneDrawer {
  const station = flowStations(
    feed,
    rows,
    new Map((lanes ?? []).map(lane => [lane.laneId, lane.conflicts])),
  ).find(s => s.stop === stop)!;
  const meta = new Map((lanes ?? []).map(lane => [lane.laneId, lane]));
  const marks = new Map((feed?.lanes ?? []).map(mark => [mark.laneId, mark]));
  const row = (block: Block): RiverRow => {
    const mark = marks.get(block.laneId);
    const m = meta.get(block.laneId);
    return {
      id: block.laneId,
      title: block.head ?? titleOf(m, block.laneId),
      who: block.who ?? whoOf(m),
      block: block.passed || block.shape || block.word === 'main is failing' ? block : null,
      ago: Math.max(0, drawnAt - (mark?.changedAt ?? drawnAt)),
      needsYou: block.needsYou,
    };
  };
  const all = station.allBlocks.map(row);
  const oldest = (a: RiverRow, b: RiverRow) => b.ago - a.ago;
  const groups: LaneGroup[] = [];
  const needs = all.filter(r => r.needsYou).sort(oldest);
  if (needs.length) groups.push({ key: 'needs', title: 'Needs you', hint: null, check: null, rows: needs });
  const rest = all.filter(r => !r.needsYou);
  if (stop === 'checking') {
    const running = feed?.checks?.runs ?? [];
    const runIndices = new Map(running.flatMap((run, index) => run.groups.map(key => [key, index] as const)));
    const checking = new Map<number, LaneGroup>();
    let next = running.length;
    for (const r of rest) {
      const check = station.allBlocks.find(b => b.laneId === r.id)?.check;
      if (!check) continue;
      const index = runIndices.get(check) ?? next++;
      runIndices.set(check, index);
      const group = checking.get(index) ?? {
        key: running[index]?.groups.join(':') ?? check,
        title: `Check ${index + 1}`,
        hint: null,
        check,
        rows: [],
      };
      group.rows.push(r);
      checking.set(index, group);
    }
    for (const [, group] of [...checking].sort(([a], [b]) => a - b))
      groups.push({ ...group, rows: group.rows.sort(oldest) });
    const loose = rest.filter(r => !station.allBlocks.find(b => b.laneId === r.id)?.check).sort(oldest);
    if (loose.length)
      groups.push({
        key: 'other',
        title: 'Passed or held',
        hint: 'longest here first',
        check: null,
        rows: loose,
      });
  } else if (rest.length) {
    const title = { editing: 'At work', saved: 'Saved', queued: 'Waiting for a check' }[stop];
    const hint = 'longest here first';
    groups.push({ key: 'rest', title, hint, check: null, rows: rest.sort(oldest) });
  }
  return {
    kind: 'lanes',
    stop,
    name: station.name,
    here: station.n,
    held: station.held.filter(block => block.held).length,
    longest: all.length ? Math.max(...all.map(r => r.ago)) : null,
    groups,
    more: feed?.more ?? 0,
  };
}

/** main's drawer: the newest landings from the one read, newest first. */
export function mainDrawer(
  landed: readonly Landed[] | undefined,
  today: number,
  drawnAt: number,
): MainDrawer {
  return {
    kind: 'main',
    today,
    rows: (landed ?? []).slice(0, FIRST_ROWS + MORE_ROWS).map(row => ({
      id: row.receiptId,
      title: row.title ?? row.item?.title ?? row.goal ?? `Receipt ${row.receiptId.slice(0, 8)}`,
      who: row.actor ? (row.agentRun ? `${row.actor}/${row.agentRun}` : row.actor) : null,
      ago: Math.max(0, drawnAt - Date.parse(row.at)),
    })),
  };
}
