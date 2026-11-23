// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One Lane's state, as every screen says it (Items 29671737, 31328be4, d4b68402): the yard row, the Lane page, Needs
// you, the queue rows and the public project page all call `laneState` with what their read holds. The line feed's
// mark decides the stop and whether a person holds it; the CURRENT submission (src/landing-state.ts, already named
// by the server on each queue entry) only says why. An earlier refused or failed submission is history: it never
// sets today's word. A reader that holds less (the public page, the Lane page) gets the same stop, hold and colour,
// only fewer words. Pure and read-free.
import type { StateKind, StateWord } from '../ds';
import type { LandingStateName } from '../../../src/landing-state';
import type { LineStage } from './Line';
import { NOTICE_PATHS } from '../../../src/conflict-notice-paths';

export type LaneMark = { stage: LineStage | 'main'; held: boolean; overlap?: boolean };
/** What a reader knows of the Lane's current submission. */
export type CurrentLanding = {
  state: LandingStateName;
  /** The server's word for that state (src/landing-state.ts), when the read carries it. */
  label?: string;
  failing?: readonly string[];
  moreFailing?: number;
  /** Protected paths a review hold names, when the hold names them. */
  protectedPaths?: number | null;
};
/** One open trial-merge conflict notice, in brief (convex/projectHostedLiveLanes.ts `conflicts`, the Lane page's
 * `conflicts`): the peer ('main' or a Lane id), that peer's goal, how many files cross; `atLeast` when its list was cut. */
export type ConflictNote = {
  with: string;
  goal?: string;
  /** The peer Lane's handle, from the Lanes read the reader already holds (`namePeers`); said when its goal names nothing. */
  peer?: string;
  files: number;
  path?: string;
  atLeast?: boolean;
};
export type LaneState = {
  stage: LineStage | 'main';
  held: boolean;
  kind: StateKind;
  /** The design system's word for the glyph (ds `State`). */
  glyph: StateWord;
  /** The word beside it. */
  word: string;
  /** Why, in a few words. */
  why: string;
  /** The few words under the Lane page's stop. */
  note: string | null;
};

/** The shell's stop words (Line.tsx), so a row, the Lane page and the top bar always say the same thing. */
export const stopWords: Record<LineStage, string> = {
  editing: 'Editing',
  saved: 'Saved',
  queued: 'In queue',
  checking: 'Checking',
  ready: 'Ready to land',
};

/** The Lane page's conflict (its files, cut at NOTICE_PATHS) as the same brief note the Lane row carries. */
export function conflictNote(conflict: {
  with: string;
  goal?: string;
  files: readonly { path: string }[];
}): ConflictNote {
  return {
    with: conflict.with,
    ...(conflict.goal ? { goal: conflict.goal } : {}),
    files: new Set(conflict.files.map(file => file.path)).size,
    ...(conflict.files[0] ? { path: conflict.files[0].path } : {}),
    ...(conflict.files.length >= NOTICE_PATHS ? { atLeast: true } : {}),
  };
}

const GOAL_CHARS = 60;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Who a conflict is with, never an id: the peer's goal without any UUID (a Lane started on an Item can carry the Item's
 * id as its outcome), else its handle, else its short Lane mark (owner 2026-11-23: "name the other Lane by its short
 * title, never a UUID"). */
function peerName(note: ConflictNote) {
  const goal = (note.goal ?? '')
    .replace(UUID, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:·–—-]+|[\s:·–—-]+$/g, '');
  if ((goal.match(/\p{L}/gu)?.length ?? 0) >= 3) return goal;
  return note.peer ?? `Lane ${note.with.slice(0, 8)}`;
}
/** Give each Lane's notices their peer's handle, from the one Lanes page (no read): a notice's peer is a Lane id. */
export function namePeers<
  T extends { laneId: string; actor?: string; agentRun?: string; conflicts?: ConflictNote[] },
>(lanes: readonly T[]): T[] {
  const handle = new Map(lanes.map(lane => [lane.laneId, lane.agentRun ?? lane.actor] as const));
  return lanes.map(lane =>
    lane.conflicts?.length
      ? {
          ...lane,
          conflicts: lane.conflicts.map(note => {
            const peer = handle.get(note.with);
            return peer ? { ...note, peer } : note;
          }),
        }
      : lane,
  );
}
/** "conflicts with <peer Item or Lane> in N files", then "and M more" for further peers: who and where, in one clause.
 * `path` adds the first crossing file, for a hover: "conflicts with <peer> in N files: <first path>…". */
export function conflictWords(notes: readonly ConflictNote[] | undefined, path = false) {
  const first = notes?.[0];
  if (!first) return null;
  const goal = first.with === 'main' ? 'main' : peerName(first);
  const who = goal.length > GOAL_CHARS ? `${goal.slice(0, GOAL_CHARS - 1).trimEnd()}…` : goal;
  const count = `${first.atLeast ? 'at least ' : ''}${first.files.toLocaleString()} ${first.files === 1 ? 'file' : 'files'}`;
  const more = notes.length - 1;
  const where = path && first.path ? `: ${first.path}${first.files > 1 ? '…' : ''}` : '';
  return `conflicts with ${who} in ${count}${more > 0 ? ` and ${more} more ${more === 1 ? 'Lane' : 'Lanes'}` : ''}${where}`;
}

/** What Conflict means, said plainly (the Flow legend and the hover of a Conflict Lane with no notice in hand). A
 * Lane that only shares a file with another, with no clash, is not marked: both can land. */
export const CONFLICT_MEANING =
  'this Lane’s changes clash with another Lane’s on the same lines; one must be redone before both can land';
/** The hover on a Conflict Lane: with whom, in how many files and the first file; the plain meaning when no notice is in hand. */
export function conflictTip(notes: readonly ConflictNote[] | undefined) {
  const words = conflictWords(notes, true);
  return words ? words[0]!.toUpperCase() + words.slice(1) : `Conflict: ${CONFLICT_MEANING}.`;
}
export const SHARED_FILE_MEANING =
  'Lanes that only share a file, with no clash, are not marked: both can land.';
/** The Conflict legend entry's hover, in full. */
export const CONFLICT_HOVER = `${CONFLICT_MEANING[0]!.toUpperCase()}${CONFLICT_MEANING.slice(1)}. ${SHARED_FILE_MEANING}`;

type Held = { glyph: StateWord; why: string; note: string; word?: string };
/** Why it is held, by the current submission's state. Only a landing held for review is "Needs you": the one hold
 * that waits on a person (needs/count.ts `waitsOnPerson`); every other hold is its agent's next step, said in its own
 * word, so a row never reads Needs you where Needs me says nothing waits (Item 9b9057a9, friction e2f436b6). Nothing
 * known: say so, never a guess at the reason or at whom it waits on. */
function heldBy(
  landing: CurrentLanding | null | undefined,
  conflict: boolean,
  notes?: readonly ConflictNote[],
): Held {
  const state = landing?.state;
  if (conflict || state === 'conflict')
    return {
      glyph: 'Conflict',
      why: conflictWords(notes) ?? 'its saved changes conflict with another Lane',
      note: 'conflict',
    };
  switch (state) {
    case 'check-failed': {
      const failing = landing?.failing ?? [];
      const more = failing.length - 1 + (landing?.moreFailing ?? 0);
      return {
        glyph: 'Check failed',
        why: failing[0] ? `${failing[0]}${more > 0 ? ` and ${more} more` : ''}` : 'its check failed',
        note: 'check failed',
      };
    }
    case 'not-run':
      return { glyph: 'Not run', why: 'its check could not run', note: 'check not run' };
    case 'stale-head':
      return { glyph: 'Stopped', why: 'main moved under it', note: 'main moved' };
    case 'rejected':
      return { glyph: 'Stopped', why: 'Forge refused the landing', note: 'refused' };
    case 'held-review': {
      const paths = landing?.protectedPaths;
      return {
        glyph: 'Needs you',
        why: paths
          ? `approval: changes ${paths === 1 ? 'a protected path' : `${paths} protected paths`}`
          : 'waiting for approval',
        note: 'waits for approval',
      };
    }
    case 'held-dependency':
      return {
        glyph: 'Waiting its turn',
        why: 'waits for the Lane it depends on',
        note: 'waits for its parent',
      };
    case 'cancelled':
      return {
        glyph: 'Set aside',
        word: 'Withdrawn',
        why: 'its agent withdrew the landing',
        note: 'withdrawn',
      };
    case 'held-main-red':
      return { glyph: 'Waiting its turn', why: 'held while main’s check is red', note: 'main is red' };
    case 'unknown':
      // Forge read the landing and has no outcome on record for it: said as that, with the next step beside it.
      return { glyph: 'Stopped', why: 'no landing outcome on record', note: 'held' };
    default:
      // A reader with the mark only (no landing in hand): held, its reason is on the Lane page and Needs me.
      return { glyph: 'Waiting its turn', word: 'Held', why: 'held', note: 'held' };
  }
}

/** A held Lane's state, wherever it stands on the line: Needs you reads held Lanes without their stop. */
export function heldState(
  landing: CurrentLanding | null | undefined,
  conflict = false,
  notes?: readonly ConflictNote[],
) {
  const held = heldBy(landing, conflict, notes);
  const kind: StateKind =
    held.glyph === 'Conflict'
      ? 'conflict'
      : held.glyph === 'Check failed'
        ? 'failed'
        : held.glyph === 'Set aside' || held.glyph === 'Stopped'
          ? 'stale'
          : 'waiting';
  return { kind, glyph: held.glyph, word: held.word ?? held.glyph, why: held.why, note: held.note };
}

/** The one rule for "Conflict" (purple, the diamond, the F), for every screen and agent read (Item 9b9057a9): a Lane
 * whose landing ended in a conflict, or whose exact trial merge flagged one that is still open (`overlap` is Forge's
 * open conflict notice, convex/projectHostedConflicts.ts, which ends when the peer lands, the Lane or the peer saves
 * clean, or either is set aside). A held Lane whose landing is in hand is what that landing says. A Lane that has not
 * landed and is not in the queue (saved: a notice is only ever decided for a saved head) is in conflict while its notice is open: the early warning to
 * settle it before it queues. A shared saved file alone is never a conflict: that stays the quiet "shares N files"
 * note and the dotted tick on the line, with no state colour. A queued, checking or ready Lane says its stop. */
export function isConflict(
  mark: Pick<LaneMark, 'held' | 'overlap'> & { stage?: LaneMark['stage'] },
  landing?: CurrentLanding | null,
) {
  if (mark.held)
    return landing && landing.state !== 'unknown' ? landing.state === 'conflict' : mark.overlap === true;
  return mark.overlap === true && mark.stage === 'saved';
}

/** The predicate Who is touching what ranks its pairs by (Item 9b9057a9): the Lanes `isConflict` says are in conflict,
 * from the line's marks and the queue's entries. */
export function conflictedLanes<
  T extends Parameters<typeof landingOf>[0] & { laneId: string | null; submittedAt: string },
>(
  marks: readonly (LaneMark & { laneId: string })[],
  entries: readonly T[],
  /** The Lane reads: a Lane whose landing ended in conflict (the queue lists pending entries only) and its open
   * notices, so a pair is marked only where a notice names its other Lane. */
  lanes: readonly {
    laneId: string;
    conflicts?: readonly ConflictNote[];
    landing?: { cause?: string } | null;
  }[] = [],
) {
  const meta = new Map(lanes.map(lane => [lane.laneId, lane]));
  const latest = currentEntries(entries);
  const byLanding = new Set<string>();
  const conflicted = new Set<string>();
  for (const mark of marks) {
    const entry = latest.get(mark.laneId);
    const cause = meta.get(mark.laneId)?.landing?.cause;
    const landing = entry ? landingOf(entry) : cause ? ({ state: cause } as CurrentLanding) : null;
    if (!isConflict(mark, landing)) continue;
    conflicted.add(mark.laneId);
    if (landing && landing.state === 'conflict') byLanding.add(mark.laneId);
  }
  return (laneId: string, others?: readonly string[]) => {
    if (!conflicted.has(laneId)) return false;
    const named = meta.get(laneId)?.conflicts;
    if (byLanding.has(laneId) || !named || !others) return true;
    return named.some(note => others.includes(note.with));
  };
}

/** The one Lane state. `landing` is the current submission only (see `currentEntries`), or nothing. */
export function laneState(
  mark: LaneMark,
  landing?: CurrentLanding | null,
  notes?: readonly ConflictNote[],
): LaneState {
  const base = { stage: mark.stage, held: mark.held };
  if (mark.stage === 'main')
    return {
      ...base,
      held: false,
      kind: 'passed',
      glyph: 'Landed',
      word: 'Landed',
      why: 'on main',
      note: null,
    };
  if (mark.held) return { ...base, ...heldState(landing, isConflict(mark, landing), notes) };
  // Not landed and not queued, with Forge's open conflict notice: Conflict, with whom and where (Item 9b9057a9).
  if (isConflict(mark, landing)) return { ...base, ...heldState(null, true, notes) };
  // On the way to main: the stop is the state.
  if (mark.stage === 'checking')
    return {
      ...base,
      kind: 'active',
      glyph: 'Checking',
      word: stopWords.checking,
      why:
        landing?.state === 'waiting-for-runner'
          ? // The server's label names since when (Item 0d8a85a3): "waiting for check infrastructure since 05:55Z".
            landing.label
            ? landing.label[0]!.toLowerCase() + landing.label.slice(1)
            : 'waiting for check infrastructure'
          : landing?.state === 'queued'
            ? 'waiting for its turn'
            : 'its check is running',
      note: null,
    };
  if (mark.stage === 'ready')
    return {
      ...base,
      kind: 'waiting',
      glyph: 'Waiting its turn',
      word: stopWords.ready,
      // A passed entry parked behind an older one does not land next (43b51a5e).
      why: landing?.state === 'waiting-for-order' ? 'waits for an older landing' : 'lands next',
      note: null,
    };
  if (mark.stage === 'queued')
    return {
      ...base,
      kind: 'waiting',
      glyph: 'Waiting its turn',
      word: stopWords.queued,
      why: 'waits for its check',
      note: null,
    };
  return { ...base, kind: 'active', glyph: 'Working', word: stopWords[mark.stage], why: '', note: null };
}

/** The entries the queue read lists, by Lane: the newest submission is the current one, the rest are history. */
export function currentEntries<T extends { laneId: string | null; submittedAt: string }>(
  entries: readonly T[],
) {
  const current = new Map<string, T>();
  for (const entry of entries) {
    if (!entry.laneId) continue;
    const seen = current.get(entry.laneId);
    if (!seen || Date.parse(entry.submittedAt) > Date.parse(seen.submittedAt))
      current.set(entry.laneId, entry);
  }
  return current;
}

/** The queue entry's current submission, as `laneState` reads it. */
export function landingOf(entry: {
  landingState?: { state: string; label?: string } | null;
  lastFailingTests?: string[];
  moreFailingTests?: number;
  hold?: { paths: string[] | null } | null;
}): CurrentLanding | null {
  if (!entry.landingState) return null;
  return {
    state: entry.landingState.state as LandingStateName,
    ...(entry.landingState.label ? { label: entry.landingState.label } : {}),
    failing: entry.lastFailingTests ?? [],
    moreFailing: entry.moreFailingTests ?? 0,
    protectedPaths: entry.hold?.paths?.length ?? null,
  };
}

const pending = new Set<string>(['queued', 'checking', 'waiting-for-runner', 'landing', 'waiting-for-order']);
/** A queue row's state: the line's mark when the feed has the Lane, else the stop and hold its own submission implies.
 * An entry out of the order is held only when it is held or ended; one still preparing is not a failed check. */
export function queueEntryState(
  entry: Parameters<typeof landingOf>[0] & { phase: string; hold?: object | null },
  mark?: LaneMark | null,
) {
  const landing = landingOf(entry);
  const ready =
    entry.phase === 'ready' || landing?.state === 'landing' || landing?.state === 'waiting-for-order';
  return laneState(
    mark ?? {
      stage: ready ? 'ready' : 'checking',
      held: !!entry.hold || (!!landing && !pending.has(landing.state)),
    },
    landing,
  );
}

/** Needs you's hold reasons (convex/projectNeedsMe.ts `needsMeWhy`) in the shared state names. */
export const heldWhyState = {
  conflict: 'conflict',
  'check-failed': 'check-failed',
  infra: 'not-run',
  'stale-head': 'stale-head',
  rejected: 'rejected',
  review: 'held-review',
  dependency: 'held-dependency',
  withdrawn: 'cancelled',
  unknown: 'unknown',
} as const satisfies Record<string, LandingStateName>;

/** The usual check time: the check-p50 speed budget (src/speed-budgets.json, pinned by tests/lane-state.test.mjs). */
export const USUAL_CHECK_MS = 10 * 60_000;

type Queued = {
  laneId: string | null;
  position: number | null;
  phase: string;
  recomposeCount?: number;
  batchId?: string | null;
  lastProgressAt: string;
};
/** Why a queued entry has not landed yet, in a few words, from the queue read alone. */
export function notLandedWhy(entry: Pick<Queued, 'phase' | 'recomposeCount'>) {
  const restarts = entry.recomposeCount ?? 0;
  return restarts > 0
    ? `its check restarted ${restarts === 1 ? 'once' : `${restarts.toLocaleString()} times`} because main moved`
    : entry.phase === 'needs-sync'
      ? 'it must update from main first'
      : entry.phase === 'checking'
        ? 'its check is running'
        : 'it lands first';
}

/** What a queued Lane waits on (Item d4b68402), in one line, from the queue read alone: the entry ahead of it and why
 * that one has not landed. `long` when it has waited past a usual check. Nothing for the first in line. */
export function waitLine(entry: Queued, entries: readonly Queued[], now: number) {
  if (entry.position === null || entry.position <= 1) return null;
  const ahead = entries
    .filter(other => other.position !== null && other.position < entry.position!)
    .sort((a, b) => b.position! - a.position!)[0];
  if (!ahead) return null;
  const reason = notLandedWhy(ahead);
  const together = entry.batchId && entry.batchId === ahead.batchId ? ', checked together' : '';
  const since = Date.parse(entry.lastProgressAt);
  return {
    aheadLaneId: ahead.laneId,
    reason,
    line: `waits for #${ahead.position}${together}: ${reason}`,
    long: Number.isFinite(since) && now - since > USUAL_CHECK_MS,
  };
}
