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
  checking: 'Checking',
  ready: 'Ready to land',
};

type Held = { glyph: StateWord; why: string; note: string; word?: string };
/** Why it is held, by the current submission's state. Nothing known: "held", never a guess at the reason or at
 * whom it waits on (friction e2f436b6: "held for you" read as the viewer's own hold when it was another's). */
function heldBy(landing: CurrentLanding | null | undefined, overlap: boolean): Held {
  const state = landing?.state;
  if (state === 'conflict' || (overlap && (!state || state === 'unknown')))
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
      return { glyph: 'Needs you', why: 'main moved under it', note: 'main moved' };
    case 'rejected':
      return { glyph: 'Needs you', why: 'Forge refused the landing', note: 'refused' };
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
    default:
      return { glyph: 'Needs you', why: 'held, why not reported', note: 'held' };
  }
}

/** A held Lane's state, wherever it stands on the line: Needs you reads held Lanes without their stop. */
export function heldState(landing: CurrentLanding | null | undefined, overlap = false) {
  const held = heldBy(landing, overlap);
  const kind: StateKind =
    held.glyph === 'Conflict'
      ? 'conflict'
      : held.glyph === 'Check failed'
        ? 'failed'
        : held.glyph === 'Set aside'
          ? 'stale'
          : 'waiting';
  return { kind, glyph: held.glyph, word: held.word ?? held.glyph, why: held.why, note: held.note };
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
  if (mark.held) return { ...base, ...heldState(landing, mark.overlap === true) };
  // On the way to main: the stop is the state. A saved-file overlap matters before the check, not during it.
  if (mark.stage === 'checking')
    return {
      ...base,
      kind: 'active',
      glyph: 'Checking',
      word: stopWords.checking,
      why:
        landing?.state === 'waiting-for-runner'
          ? 'waiting for a runner'
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
      why: 'lands next',
      note: null,
    };
  if (mark.overlap)
    return {
      ...base,
      kind: 'conflict',
      glyph: 'Conflict',
      word: 'Conflict',
      why: 'its saved changes conflict with another Lane',
      note: 'conflict',
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
  landingState?: { state: string } | null;
  lastFailingTests?: string[];
  moreFailingTests?: number;
  hold?: { paths: string[] | null } | null;
}): CurrentLanding | null {
  if (!entry.landingState) return null;
  return {
    state: entry.landingState.state as LandingStateName,
    failing: entry.lastFailingTests ?? [],
    moreFailing: entry.moreFailingTests ?? 0,
    protectedPaths: entry.hold?.paths?.length ?? null,
  };
}

const pending = new Set<string>(['queued', 'checking', 'waiting-for-runner', 'landing']);
/** A queue row's state: the line's mark when the feed has the Lane, else the stop and hold its own submission implies.
 * An entry out of the order is held only when it is held or ended; one still preparing is not a failed check. */
export function queueEntryState(
  entry: Parameters<typeof landingOf>[0] & { phase: string; hold?: object | null },
  mark?: LaneMark | null,
) {
  const landing = landingOf(entry);
  const ready = entry.phase === 'ready' || landing?.state === 'landing';
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
