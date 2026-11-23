// SPDX-License-Identifier: Apache-2.0
// One Lane's state, as every screen says it (Items 29671737, 31328be4, d4b68402): the yard row, the Lane page, Needs
// you, the queue rows and the public project page all call `laneState` with what their read holds. The line feed's
// mark decides the stop and whether a person holds it; the CURRENT submission (src/landing-state.ts, already named
// by the server on each queue entry) only says why. An earlier refused or failed submission is history: it never
// sets today's word. A reader that holds less (the public page, the Lane page) gets the same stop, hold and colour,
// only fewer words. Pure and read-free.
import type { StateKind, StateWord } from '../ds';
import type { LandingStateName } from '../../../src/landing-state';
import type { LineStage } from './Line';

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

type Held = { glyph: StateWord; why: string; note: string; word?: string };
/** Why it is held, by the current submission's state. Only a landing held for review is "Needs you": the one hold
 * that waits on a person (needs/count.ts `waitsOnPerson`); every other hold is its agent's next step, said in its own
 * word, so a row never reads Needs you where Needs me says nothing waits (Item 9b9057a9, friction e2f436b6). Nothing
 * known: say so, never a guess at the reason or at whom it waits on. */
function heldBy(landing: CurrentLanding | null | undefined, conflict: boolean): Held {
  const state = landing?.state;
  if (conflict || state === 'conflict')
    return { glyph: 'Conflict', why: 'its saved changes conflict with another Lane', note: 'conflict' };
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
export function heldState(landing: CurrentLanding | null | undefined, conflict = false) {
  const held = heldBy(landing, conflict);
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
 * whose landing ended in a conflict, or, where its landing is not in hand (the line feed, the Lane page), a held Lane
 * whose exact trial merge flagged one. A Lane that has not landed yet is never "in conflict" because it shares saved
 * files with another Lane, or because a trial merge at save flagged a possible one: that stays the quiet "shares N
 * files" note and the dotted tick on the line, with no state colour. */
export function isConflict(mark: Pick<LaneMark, 'held' | 'overlap'>, landing?: CurrentLanding | null) {
  if (!mark.held) return false;
  if (landing && landing.state !== 'unknown') return landing.state === 'conflict';
  return mark.overlap === true;
}

/** The one Lane state. `landing` is the current submission only (see `currentEntries`), or nothing. */
export function laneState(mark: LaneMark, landing?: CurrentLanding | null): LaneState {
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
  if (mark.held) return { ...base, ...heldState(landing, isConflict(mark, landing)) };
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
