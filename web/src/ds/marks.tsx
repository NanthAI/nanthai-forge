// SPDX-License-Identifier: Apache-2.0
// The drawn vocabulary of the design system: six state glyphs with their fixed words, two Item glyphs, the five kind
// marks and the person/agent square. Static markup only: no behaviour layer, no effects, safe for first paint.
import type { ReactNode } from 'react';

/** The six states. Each is always a shape, a word and a colour together (DESIGN.md, "State"). */
export type StateKind = 'active' | 'waiting' | 'conflict' | 'failed' | 'passed' | 'stale';
/** Glyphs that are drawn but are not one of the six states: Items with no Lane yet. */
export type ItemGlyph = 'proposed' | 'planned';

const glyphPaths: Record<StateKind | ItemGlyph, ReactNode> = {
  active: <circle cx="8" cy="8" r="4" fill="currentColor" stroke="none" />,
  waiting: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.2l2 1.3" />
    </>
  ),
  conflict: (
    <>
      <rect x="2.5" y="2.5" width="7.5" height="7.5" rx="1" />
      <rect x="6" y="6" width="7.5" height="7.5" rx="1" />
    </>
  ),
  passed: <path d="m3 8.5 3.2 3.2L13 4.8" />,
  failed: <path d="m4 4 8 8M12 4l-8 8" />,
  stale: <path d="M4 8h8" />,
  proposed: <circle cx="8" cy="8" r="5" strokeDasharray="1.6 2.6" />,
  planned: <circle cx="8" cy="8" r="5" />,
};

/** The fixed words, each on its state's glyph. A screen picks a word; it never writes its own. */
export const stateWords = {
  Working: 'active',
  Saving: 'active',
  Checking: 'active',
  'Waiting its turn': 'waiting',
  'Needs you': 'waiting',
  Handoff: 'waiting',
  Conflict: 'conflict',
  'Check failed': 'failed',
  Landed: 'passed',
  'Set aside': 'stale',
  'Not seen': 'stale',
  Done: 'passed',
  'In progress': 'active',
  Left: 'stale',
  Abandoned: 'stale',
  'Not run': 'stale',
  Stopped: 'stale',
  'No Lane': 'stale',
  'Signed out': 'stale',
  'Sign-in expired': 'stale',
  'Not reported': 'stale',
} as const satisfies Record<string, StateKind>;
export type StateWord = keyof typeof stateWords;

/** A state glyph alone, for a place where the word is already beside it (a roll-up tick, a table cell). */
export function Glyph({ of, size = 13 }: { of: StateKind | ItemGlyph; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyphPaths[of]}
    </svg>
  );
}

/** Glyph and word in the state colour; never a pill, never colour alone. `state` overrides the word's default. */
export function State({
  word,
  state,
  children,
}: {
  word: StateWord;
  state?: StateKind;
  children?: ReactNode;
}) {
  const st = state ?? stateWords[word];
  return (
    <span className="st" data-st={st}>
      <Glyph of={st} />
      {children ?? word}
    </span>
  );
}

/** An Item that has no Lane yet: Proposed (dotted ring) or Planned (ring), in the quiet colour. */
export function ItemState({ of }: { of: ItemGlyph }) {
  return (
    <span className="st" data-st="stale">
      <Glyph of={of} />
      {of === 'proposed' ? 'Proposed' : 'Planned'}
    </span>
  );
}

export type Kind = 'lane' | 'item' | 'check' | 'session' | 'person';
const kindPaths: Record<Kind, ReactNode> = {
  lane: (
    <>
      <path d="M1.5 8h6.5" />
      <circle cx="11.5" cy="8" r="3" fill="currentColor" stroke="none" />
    </>
  ),
  item: <circle cx="8" cy="8" r="5" />,
  check: <path d="M4 3.5v9M8 3.5v9M12 3.5v9" strokeWidth="2.4" strokeLinecap="butt" />,
  session: <rect x="3" y="3" width="10" height="10" rx="1.5" />,
  person: <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />,
};

/** One mark per kind of thing, in ink. First in a row about that thing, or once before a region's title. */
export function KindMark({ kind }: { kind: Kind }) {
  return (
    <svg
      className="km"
      data-k={kind}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kindPaths[kind]}
    </svg>
  );
}

const graphemes =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('en', { granularity: 'grapheme' })
    : null;
const firstGrapheme = (word: string) =>
  (graphemes ? graphemes.segment(word)[Symbol.iterator]().next().value?.segment : [...word][0]) ?? '';

/** Initials by grapheme, so an emoji or a non-Latin first letter stays whole. `person/agent` uses the agent part. */
export function initials(handle: string) {
  const name = handle.split('/').pop()!.replace(/^@/, '').trim();
  const parts = name.split(/[-_ .]+/).filter(Boolean);
  return (firstGrapheme(parts[0] ?? '') + (parts[1] ? firstGrapheme(parts[1]) : '')).toLowerCase() || '?';
}

/** A square with initials: a person (`@handle`) is filled, an agent (`person/agent`) is outlined. */
export function Avatar({ handle, large = false }: { handle: string; large?: boolean }) {
  const agent = handle.includes('/');
  return (
    <span className={`av${agent ? ' ag' : ''}${large ? ' lg' : ''}`} aria-hidden="true">
      {initials(handle)}
    </span>
  );
}

/** Who: the square and the public handle in mono. The full handle stays in the label when it is cut. */
export function Who({ handle, app }: { handle: string; app?: string }) {
  return (
    <span className="who" title={handle}>
      <Avatar handle={handle} />
      <span className="mono" dir="auto" translate="no">
        {handle}
      </span>
      {app ? <span className="t2">{app}</span> : null}
    </span>
  );
}

/** A count. `hot` is only for Needs you above zero; zero is never hidden. */
export function Count({ n, hot = false, label }: { n: number; hot?: boolean; label?: string }) {
  return (
    <span className={`cnt${hot && n > 0 ? ' hot' : ''}`} aria-label={label}>
      {n.toLocaleString()}
    </span>
  );
}
