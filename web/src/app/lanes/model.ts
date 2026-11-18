// SPDX-License-Identifier: Apache-2.0
// The Lanes place's one model (Item e317b6ea): the line feed decides each Lane's stop and whether it is held, so the
// yard's words and counts are the shell's; the existing Lane page, queue view and overlap view add the title, the
// person, the reason it is held and the queue order. Pure and read-free: every count here comes from rows in hand and
// says when the rows are not all of them.
import type { LineFeed, LineStage } from '../Line';
import type { StateKind, StateWord } from '../../ds';
import { QUIET_MS } from '../../../../src/lane-quiet';
import { currentEntries, landingOf, laneState, stopWords, waitLine } from '../lane-state';

/** One open Lane from `projectHostedLiveLanes:list` (the agent `lanes` page). */
export type LaneMeta = {
  laneId: string;
  intentId: string;
  intent: string | null;
  actor: string;
  lastSaveAt: string | null;
  landing: { submissionId: string; state: string } | null;
  dormant?: boolean;
  lastActivityAt?: string;
  /** A resolution Lane: the conflicted Lane of the same Item it continues. */
  resolves?: string;
};
/** One entry from `projectHostedQueueView:read`. `landingState` is the server's one reading of this submission
 * (src/landing-state.ts); a Lane can have older entries too, and only its newest is current (lane-state.ts). */
export type QueueEntry = {
  position: number | null;
  laneId: string | null;
  submissionId?: string;
  intentTitle?: string | null;
  landingState?: { state: string; label?: string } | null;
  phase: string;
  lastFailingTests?: string[];
  moreFailingTests?: number;
  recomposeCount?: number;
  batchId?: string | null;
  submittedAt: string;
  lastProgressAt: string;
  error?: string;
  hold?: { kind: 'review' | 'dependency' | 'main-red'; reason: string; paths: string[] | null };
  waitingOn?: { kind: string };
};
export type QueueView = {
  total: number;
  held?: number;
  listed: number;
  more: boolean;
  entries: QueueEntry[];
};
/** The overlap view's shared saved paths (`projectNowOverlaps:now`, src/now-overlap-view.ts). */
export type SharedFiles = {
  lanes: { laneId: string }[];
  paths: string[];
  edits: { lane: number; paths: number[] }[];
  complete: boolean;
};

export type Band = 'needs' | 'queue' | 'work' | 'quiet';
export const bandTitles: Record<Band, { title: string; hint: string }> = {
  // Every held Lane, an agent's too; Needs me counts only those that wait on a person (needs/count.ts).
  needs: { title: 'Held', hint: 'stopped until someone acts; what waits on you is in Needs me' },
  queue: { title: 'In the landing queue', hint: 'in landing order' },
  work: { title: 'Being worked on', hint: 'latest change first' },
  quiet: { title: 'Quiet', hint: 'no save for a while' },
};

export { stopWords };

export type YardRow = {
  laneId: string;
  /** The short Lane mark that tells two Lanes of one Item apart. */
  mark: string;
  intentId: string | null;
  band: Band;
  stage: LineStage;
  title: string;
  actor: string | null;
  /** The state glyph and colour, and the word beside it (lane-state.ts, the same as every other screen). */
  state: StateKind;
  glyph: StateWord;
  word: string;
  /** Why it is here, in a few words: the hold's reason, what it waits on, the last save. */
  why: string;
  /** A second line under `why`, when there is one. */
  detail: string | null;
  position: number | null;
  /** When it last changed stop (ms), for ordering the work band. */
  changedAt: number;
  overlap: boolean;
  /** The Lane page did not list it (beyond its window): the title is not known. */
  untitled: boolean;
  /** Open Lanes for the same Item, this one included (1 when it is alone). */
  lanes: number;
  /** The Lane of the same Item that took this one's place, when this one is left (`replacedBy`). */
  replacedBy: string | null;
  /** Waiting in the queue for longer than a usual check. */
  longWait: boolean;
};

export type Yard = {
  rows: YardRow[];
  counts: Record<Band, number>;
  /** Lanes open beyond the feed's window (`more`), and whether that is a lower bound. */
  beyond: number;
  beyondIsLowerBound: boolean;
  open: number;
  next: YardRow | null;
};

const ago = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
};

/** The yard draws once its reads are in (Item 31328be4): the line feed, the Lane page and the queue, each answered or
 * failed. Drawing from the feed alone would show ids for titles, no person and states the queue then changes. */
export function yardReady(reads: {
  feed: LineFeed | undefined;
  lanes: readonly LaneMeta[] | undefined;
  laneError?: Error;
  queue: QueueView | undefined;
  queueError?: Error;
}) {
  return !!reads.feed && (!!reads.lanes || !!reads.laneError) && (!!reads.queue || !!reads.queueError);
}

type Sibling = { laneId: string; intentId: string; lastAt: number; inFlight: boolean; resolves?: string };
/** Several open Lanes for one Item (Item d9e1ac62): one that has been quiet for QUIET_MS with no landing in flight is
 * replaced by the busiest other Lane of that Item (a landing in flight first, then the latest save). An open resolution
 * Lane replaces the conflicted Lane it continues even when both are quiet, unless that one has a landing in flight.
 * Otherwise, when every Lane of the Item is quiet, or none is, nothing is called replaced: they are only grouped. */
export function replacedBy(lanes: readonly Sibling[], now: number) {
  const byItem = new Map<string, Sibling[]>();
  for (const lane of lanes) byItem.set(lane.intentId, [...(byItem.get(lane.intentId) ?? []), lane]);
  const out = new Map<string, string>();
  for (const group of byItem.values()) {
    if (group.length < 2) continue;
    for (const lane of group) {
      const origin = lane.resolves ? group.find(other => other.laneId === lane.resolves) : undefined;
      if (origin && !origin.inFlight) out.set(origin.laneId, lane.laneId);
    }
    const quiet = (lane: Sibling) => !lane.inFlight && now - lane.lastAt >= QUIET_MS;
    // A Lane already replaced by its resolution never stands in for another.
    const live = group
      .filter(lane => !quiet(lane) && !out.has(lane.laneId))
      .sort((a, b) => Number(b.inFlight) - Number(a.inFlight) || b.lastAt - a.lastAt)[0];
    if (!live) continue;
    for (const lane of group) if (quiet(lane) && !out.has(lane.laneId)) out.set(lane.laneId, live.laneId);
  }
  return out;
}

/** The yard: every Lane the feed shows, in its band, stuck work first; Lanes of one Item sit together, a replaced one
 * below the one that replaced it. `now` is the render time, never a query arg. */
export function buildYard(
  feed: LineFeed,
  lanes: readonly LaneMeta[],
  queue: QueueView | undefined,
  now: number,
): Yard {
  const meta = new Map(lanes.map(lane => [lane.laneId, lane]));
  const entries = currentEntries(queue?.entries ?? []);
  const perItem = new Map<string, number>();
  for (const lane of lanes) perItem.set(lane.intentId, (perItem.get(lane.intentId) ?? 0) + 1);
  const lastAt = (laneId: string, changedAt: number) => {
    const lane = meta.get(laneId);
    const at = Date.parse(lane?.lastSaveAt ?? lane?.lastActivityAt ?? '');
    return Number.isFinite(at) ? Math.max(at, changedAt) : changedAt;
  };
  const replaced = replacedBy(
    feed.lanes.flatMap(mark => {
      const lane = meta.get(mark.laneId);
      if (!lane) return [];
      const inFlight =
        entries.has(mark.laneId) || mark.held || mark.stage === 'checking' || mark.stage === 'ready';
      return [
        {
          laneId: mark.laneId,
          intentId: lane.intentId,
          lastAt: lastAt(mark.laneId, mark.changedAt),
          inFlight,
          ...(lane.resolves ? { resolves: lane.resolves } : {}),
        },
      ];
    }),
    now,
  );
  const short = (laneId: string) => laneId.slice(0, 8);
  const rows = feed.lanes.map((mark): YardRow => {
    const lane = meta.get(mark.laneId);
    const entry = entries.get(mark.laneId);
    const said = laneState(mark, entry ? landingOf(entry) : null);
    const by = replaced.get(mark.laneId) ?? null;
    const base = {
      laneId: mark.laneId,
      mark: short(mark.laneId),
      intentId: lane?.intentId ?? null,
      stage: mark.stage,
      title: lane?.intent ?? entry?.intentTitle ?? `Lane ${short(mark.laneId)}`,
      actor: lane?.actor ?? null,
      changedAt: mark.changedAt,
      overlap: mark.overlap,
      untitled: !lane?.intent && !entry?.intentTitle,
      position: null,
      state: said.kind,
      glyph: said.glyph,
      word: said.word,
      why: said.why,
      detail: null,
      lanes: lane ? (perItem.get(lane.intentId) ?? 1) : 1,
      replacedBy: by,
      longWait: false,
    };
    const left = by ? { why: `replaced by ${short(by)}`, detail: said.why || null } : {};
    if (mark.held) return { ...base, band: 'needs', ...left };
    if (entry && entry.position !== null) {
      const wait = mark.stage === 'ready' ? waitLine(entry, queue?.entries ?? [], now) : null;
      return {
        ...base,
        band: 'queue',
        position: entry.position,
        why: wait?.line ?? (entry.position === 1 ? 'lands next' : `position ${entry.position}`),
        detail: wait?.long ? 'longer than a usual check' : null,
        longWait: wait?.long ?? false,
      };
    }
    if (lane?.dormant)
      return {
        ...base,
        band: 'quiet',
        state: 'stale',
        why: `no save since ${ago(now - Date.parse(lane.lastActivityAt ?? lane.lastSaveAt ?? ''))}`,
        ...left,
      };
    return {
      ...base,
      band: mark.stage === 'checking' || mark.stage === 'ready' ? 'queue' : 'work',
      why: said.why || (lane?.lastSaveAt ? `saved ${ago(now - Date.parse(lane.lastSaveAt))}` : 'no save yet'),
      ...left,
    };
  });
  const order: Record<Band, number> = { needs: 0, queue: 1, work: 2, quiet: 3 };
  rows.sort(
    (a, b) =>
      order[a.band] - order[b.band] ||
      (a.band === 'needs' ? a.changedAt - b.changedAt : 0) ||
      (a.position ?? Infinity) - (b.position ?? Infinity) ||
      b.changedAt - a.changedAt,
  );
  const counts = { needs: 0, queue: 0, work: 0, quiet: 0 };
  for (const row of rows) counts[row.band]++;
  return {
    rows: byItem(rows),
    counts,
    beyond: feed.more,
    beyondIsLowerBound: feed.moreIsLowerBound,
    open: rows.length + feed.more,
    next: rows.find(row => row.position === 1) ?? null,
  };
}

/** Within each band, Lanes of one Item sit together where the first live one sits; replaced ones follow it, and a
 * replaced Lane whose replacement is in another band goes to the bottom of its own band. Stable otherwise. */
function byItem(rows: readonly YardRow[]) {
  const rank = new Map(rows.map((row, index) => [row.laneId, index]));
  const head = new Map<string, number>();
  for (const row of rows)
    if (row.intentId && !row.replacedBy) {
      const key = `${row.band}:${row.intentId}`;
      if (!head.has(key)) head.set(key, rank.get(row.laneId)!);
    }
  const groupRank = (row: YardRow) =>
    (row.intentId ? head.get(`${row.band}:${row.intentId}`) : undefined) ??
    (row.replacedBy ? rows.length + rank.get(row.laneId)! : rank.get(row.laneId)!);
  return rows
    .slice()
    .sort(
      (a, b) =>
        groupRank(a) - groupRank(b) ||
        Number(!!a.replacedBy) - Number(!!b.replacedBy) ||
        rank.get(a.laneId)! - rank.get(b.laneId)!,
    );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The head's sentence: what needs the reader, what is not listed, and what lands next. Counts per stop are the shell
 * strip's alone: a second grouping of the same Lanes here read as a disagreement (owner dogfood 2026-11-17). */
export function situation(yard: Yard): { lead: string; rest: string } {
  const needs = yard.counts.needs;
  const lead = !yard.open
    ? 'No Lanes are open.'
    : needs
      ? `${plural(needs, 'Lane')} ${needs === 1 ? 'is' : 'are'} held.`
      : 'No Lane is held.';
  const parts = [
    yard.beyond &&
      `${yard.beyond.toLocaleString()}${yard.beyondIsLowerBound ? ' or more' : ''} more not shown`,
  ].filter(Boolean) as string[];
  const rest = parts.length ? `${parts.join(', ').replace(/^./, c => c.toUpperCase())}.` : '';
  const next = yard.next ? ` ${yard.next.title} lands next.` : '';
  return { lead, rest: (rest + next).trim() };
}

export type Filter = 'all' | 'needs' | 'mine';
export function filterRows(rows: readonly YardRow[], filter: Filter, viewer: string | undefined) {
  if (filter === 'needs') return rows.filter(row => row.band === 'needs');
  if (filter === 'mine') return rows.filter(row => !!viewer && row.actor === viewer);
  return rows;
}

/** A stop picked on the top bar (`?stop=`) narrows the yard to the Lanes at that stop. */
export function atStop(rows: readonly YardRow[], stop: string | null) {
  return stop && stop in stopWords ? rows.filter(row => row.stage === stop) : rows;
}

export type SharedFile = { path: string; laneIds: string[] };
/** Files more than one open Lane has saved changes to, most crowded first. Saved work only. */
export function sharedFiles(view: SharedFiles | undefined): { files: SharedFile[]; complete: boolean } {
  if (!view) return { files: [], complete: false };
  const byPath = new Map<number, string[]>();
  for (const edit of view.edits)
    for (const at of edit.paths) {
      const laneId = view.lanes[edit.lane]?.laneId;
      if (!laneId) continue;
      const list = byPath.get(at) ?? [];
      if (!list.includes(laneId)) list.push(laneId);
      byPath.set(at, list);
    }
  const files = [...byPath]
    .filter(([, ids]) => ids.length > 1)
    .map(([at, laneIds]) => ({ path: view.paths[at]!, laneIds }))
    .sort((a, b) => b.laneIds.length - a.laneIds.length || a.path.localeCompare(b.path));
  return { files, complete: view.complete };
}

export type Wait = { laneId: string; on: string; why: string; since: string | null; person: boolean };

/** Who waits on whom, from the queue alone: held entries wait on a person (or their dependency), each queued entry
 * waits on the one ahead of it. People first, then the longest wait. */
export function waits(entries: readonly QueueEntry[], titleOf: (laneId: string) => string): Wait[] {
  const queued = entries.filter(entry => entry.position !== null).sort((a, b) => a.position! - b.position!);
  const out: Wait[] = [];
  for (const entry of entries) {
    if (!entry.laneId) continue;
    if (entry.hold?.kind === 'review')
      out.push({
        laneId: entry.laneId,
        on: 'a person',
        why: entry.hold.reason,
        since: entry.lastProgressAt,
        person: true,
      });
    else if (entry.hold?.kind === 'dependency')
      out.push({
        laneId: entry.laneId,
        on: 'the Lane it depends on',
        why: entry.hold.reason,
        since: entry.lastProgressAt,
        person: false,
      });
    else if (entry.hold?.kind === 'main-red')
      out.push({
        laneId: entry.laneId,
        on: 'main',
        why: 'main’s full check is red',
        since: entry.lastProgressAt,
        person: false,
      });
    else if (entry.position !== null && entry.position > 1) {
      const wait = waitLine(entry, queued, 0);
      out.push({
        laneId: entry.laneId,
        on: wait?.aheadLaneId ? titleOf(wait.aheadLaneId) : `number ${entry.position - 1} in the queue`,
        why: wait?.reason ?? 'next in the queue behind it',
        since: entry.submittedAt,
        person: false,
      });
    }
  }
  return out.sort(
    (a, b) => Number(b.person) - Number(a.person) || (a.since ?? '').localeCompare(b.since ?? ''),
  );
}

/** The bands: landed today, then each earlier day, newest first. */
export function groupByDay<T extends { at: string }>(rows: readonly T[], today: string) {
  const groups: { title: string; rows: T[] }[] = [];
  for (const row of rows) {
    const d = new Date(row.at).toDateString();
    const title =
      d === today
        ? 'Today'
        : new Date(row.at).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    const last = groups.at(-1);
    if (last?.title === title) last.rows.push(row);
    else groups.push({ title, rows: [row] });
  }
  return groups;
}

/** Why History shows no rows, or null when it has rows or is still reading (Item 35f62c2c: an empty state only when
 * the read came back with none). A filtered page that found none but has more to look through is not empty. */
export function historyEmpty(
  page:
    | { rows: readonly unknown[]; next: number | null; newest: number | null; started: boolean }
    | undefined,
  filter: { unread: boolean; by: string | null; item: string | null },
): 'nothing-landed' | 'all-read' | 'no-match' | 'look-further' | null {
  if (!page || page.rows.length) return null;
  if (page.next !== null) return 'look-further';
  if (filter.by || filter.item) return 'no-match';
  // The unread view reads only above the read line: with a line set, an empty answer means everything was read.
  if (filter.unread) return page.started ? 'all-read' : 'nothing-landed';
  return 'nothing-landed';
}
