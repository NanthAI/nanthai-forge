// SPDX-License-Identifier: Apache-2.0
// The Lanes place's one model (Item e317b6ea): the line feed decides each Lane's stop and whether it is held, so the
// yard's words and counts are the shell's; the existing Lane page, queue view and overlap view add the title, the
// person, the reason it is held and the queue order. Pure and read-free: every count here comes from rows in hand and
// says when the rows are not all of them.
import type { LineFeed, LineStage } from '../Line';
import type { StateKind } from '../../ds';

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
};
/** One entry from `projectHostedQueueView:read`. */
export type QueueEntry = {
  position: number | null;
  laneId: string | null;
  intentTitle?: string | null;
  phase: string;
  lastFailingTests?: string[];
  moreFailingTests?: number;
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
  needs: { title: 'Needs you', hint: 'held until a person decides' },
  queue: { title: 'In the landing queue', hint: 'in landing order' },
  work: { title: 'Being worked on', hint: 'latest change first' },
  quiet: { title: 'Quiet', hint: 'no save for a while' },
};

/** The shell's stop words (Line.tsx), so a row and the top bar always say the same thing. */
export const stopWords: Record<LineStage, string> = {
  editing: 'Editing',
  saved: 'Saved',
  checking: 'Checking',
  ready: 'Ready to land',
};

export type YardRow = {
  laneId: string;
  band: Band;
  stage: LineStage;
  title: string;
  actor: string | null;
  /** The state glyph and colour, and the word beside it. */
  state: StateKind;
  word: string;
  /** Why it is here, in a few words: the hold's reason, the queue place, the last save. */
  why: string;
  position: number | null;
  /** When it last changed stop (ms), for ordering the work band. */
  changedAt: number;
  overlap: boolean;
  /** The Lane page did not list it (beyond its window): the title is not known. */
  untitled: boolean;
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

function heldWords(entry: QueueEntry | undefined): { state: StateKind; word: string; why: string } {
  if (entry?.phase === 'terminal-failed' || entry?.error)
    return {
      state: 'failed',
      word: 'Check failed',
      why: entry.lastFailingTests?.length
        ? `${entry.lastFailingTests[0]}${entry.lastFailingTests.length + (entry.moreFailingTests ?? 0) > 1 ? ` and ${entry.lastFailingTests.length - 1 + (entry.moreFailingTests ?? 0)} more` : ''}`
        : 'its check failed',
    };
  if (entry?.hold?.kind === 'review')
    return {
      state: 'waiting',
      word: 'Needs you',
      why: entry.hold.paths?.length
        ? `approval: changes ${entry.hold.paths.length === 1 ? 'a protected path' : `${entry.hold.paths.length} protected paths`}`
        : 'waiting for approval',
    };
  if (entry?.hold?.kind === 'dependency')
    return { state: 'waiting', word: 'Needs you', why: 'waits for the Lane it depends on' };
  if (entry?.hold?.kind === 'main-red')
    return { state: 'waiting', word: 'Needs you', why: 'held while main’s check is red' };
  return { state: 'waiting', word: 'Needs you', why: 'held for a person' };
}

/** The yard: every Lane the feed shows, in its band, stuck work first. `now` is the render time, never a query arg. */
export function buildYard(
  feed: LineFeed,
  lanes: readonly LaneMeta[],
  queue: QueueView | undefined,
  now: number,
): Yard {
  const meta = new Map(lanes.map(lane => [lane.laneId, lane]));
  const entries = new Map(
    (queue?.entries ?? []).flatMap(entry => (entry.laneId ? [[entry.laneId, entry] as const] : [])),
  );
  const rows = feed.lanes.map((mark): YardRow => {
    const lane = meta.get(mark.laneId);
    const entry = entries.get(mark.laneId);
    const base = {
      laneId: mark.laneId,
      stage: mark.stage,
      title: lane?.intent ?? entry?.intentTitle ?? `Lane ${mark.laneId.slice(0, 8)}`,
      actor: lane?.actor ?? null,
      changedAt: mark.changedAt,
      overlap: mark.overlap,
      untitled: !lane?.intent && !entry?.intentTitle,
      position: null,
    };
    if (mark.held) return { ...base, band: 'needs', ...heldWords(entry) };
    if (entry && entry.position !== null)
      return {
        ...base,
        band: 'queue',
        position: entry.position,
        state: mark.stage === 'checking' ? 'active' : 'waiting',
        word: mark.stage === 'checking' ? stopWords.checking : stopWords[mark.stage],
        why: entry.position === 1 ? 'lands next' : `position ${entry.position}`,
      };
    if (lane?.dormant)
      return {
        ...base,
        band: 'quiet',
        state: 'stale',
        word: stopWords[mark.stage],
        why: `no save since ${ago(now - Date.parse(lane.lastActivityAt ?? lane.lastSaveAt ?? ''))}`,
      };
    return {
      ...base,
      band: mark.stage === 'checking' || mark.stage === 'ready' ? 'queue' : 'work',
      state: mark.overlap ? 'conflict' : 'active',
      word: mark.overlap ? 'Conflict' : stopWords[mark.stage],
      why: mark.overlap
        ? 'its saved changes conflict with another Lane'
        : lane?.lastSaveAt
          ? `saved ${ago(now - Date.parse(lane.lastSaveAt))}`
          : 'no save yet',
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
    rows,
    counts,
    beyond: feed.more,
    beyondIsLowerBound: feed.moreIsLowerBound,
    open: rows.length + feed.more,
    next: rows.find(row => row.position === 1) ?? null,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The head's sentence: what needs the reader first, then where the rest is. Counts reconcile with the yard. */
export function situation(yard: Yard): { lead: string; rest: string } {
  const needs = yard.counts.needs;
  const lead = !yard.open
    ? 'No Lanes are open.'
    : needs
      ? `${plural(needs, 'Lane')} ${needs === 1 ? 'needs' : 'need'} you.`
      : 'No Lane needs you.';
  const parts = [
    yard.counts.queue && `${yard.counts.queue.toLocaleString()} in the landing queue`,
    yard.counts.work && `${yard.counts.work.toLocaleString()} being worked on`,
    yard.counts.quiet && `${yard.counts.quiet.toLocaleString()} quiet`,
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
      const ahead = queued[queued.indexOf(entry) - 1];
      out.push({
        laneId: entry.laneId,
        on: ahead?.laneId ? titleOf(ahead.laneId) : `number ${entry.position - 1} in the queue`,
        why: 'next in the queue behind it',
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
        ? 'Landed today, not read'
        : `Landed ${new Date(row.at).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}, not read`;
    const last = groups.at(-1);
    if (last?.title === title) last.rows.push(row);
    else groups.push({ title, rows: [row] });
  }
  return groups;
}
