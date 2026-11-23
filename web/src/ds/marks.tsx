// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The drawn vocabulary of the design system: six state glyphs with their fixed words, two Item glyphs, the five kind
// marks and the person/agent square. Static markup only: no behaviour layer, no effects, safe for first paint.
import type { MouseEventHandler, ReactNode } from 'react';

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
  'Save failed': 'failed',
  'Check failed': 'failed',
  Landed: 'passed',
  'Set aside': 'stale',
  'Not seen': 'stale',
  Done: 'passed',
  'In progress': 'active',
  Left: 'stale',
  Abandoned: 'stale',
  Archived: 'stale',
  Deleted: 'stale',
  'Not run': 'stale',
  Stopped: 'stale',
  'No Lane': 'stale',
  'Signed out': 'stale',
  'Sign-in expired': 'stale',
  'Not reported': 'stale',
  Paid: 'passed',
  'Not paid': 'failed',
  'Card declined': 'failed',
  Refunded: 'stale',
  'Extra block': 'stale',
  'View only': 'stale',
  'Limit near': 'waiting',
  'Landings wait': 'waiting',
  Confirming: 'waiting',
  'Card expires': 'waiting',
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

/** What a run's identity reads as: `handle/run` is an agent run, anything else a person (`@handle`). A stored
 * `@handle/run` (an Item's owner can be written either way) is the same run: the person is `@handle`, never `@@handle`. */
export function whoParts(handle: string) {
  const slash = handle.indexOf('/');
  const at = (name: string) => `@${name.replace(/^@+/, '')}`;
  if (slash < 0) return { agent: false as const, person: at(handle), run: '' };
  return { agent: true as const, person: at(handle.slice(0, slash)), run: handle.slice(slash + 1) };
}

/** The whole public identity as one name: `@handle` for a person, `handle/run` for an agent run. */
function whoName(handle: string) {
  const { agent, person, run } = whoParts(handle);
  return agent ? `${person.slice(1)}/${run}` : person;
}

/** Who did it (Item 41514fee), as the hover title: a run's full public address (`handle/run-name`, what a person
 * copies or searches for) and the model it declared. */
export function whoWords(handle: string, model?: string | null) {
  const { agent, person } = whoParts(handle);
  if (!agent) return person;
  const said = model === undefined ? null : model || 'model not declared';
  return [whoName(handle), said].filter(Boolean).join(' · ');
}

export type WhoProps = {
  /** `@handle` for a person, `handle/run-name` for an agent run. Public identities only: never a name or a device. */
  handle: string;
  /** The model the run declared, shown as declared; '' or null reads "model not declared". Leave it out when the
   * record carries no declaration at all (older rows): then nothing about a model is said. A person has none. */
  model?: string | null;
  /** The agent app as the run reported it (older detail rows). */
  app?: string;
  /** `line` gives it a line of its own that measures itself: the model gives way first and goes whole under 300px.
   * The default sits inline in a sentence or a cell and only cuts with an ellipsis. */
  layout?: 'inline' | 'line';
  /** `md` when who did it is the row's own title (a list of agents, the agent page's band). */
  size?: 'md';
  /** Leave out "for @person" (on that person's own page). */
  nofor?: boolean;
  /** The whole public identity as one name (`handle/run`, `@handle`), as the Plan board shows an owner: no model,
   * no "for @person"; it cuts only at the end when the space runs out. */
  whole?: boolean;
  /** Where the handle and the run name lead. Without one the name is text (also inside a row that is itself a link). */
  personHref?: string;
  runHref?: string;
  /** The app's in-page navigation for those links. */
  onFollow?: MouseEventHandler<HTMLAnchorElement>;
};

/** Who did it: a person (solid square, the handle) or an agent run (hollow square, run · model · for @person), on one
 * line that never wraps. The marks are the system's own; no kind takes a colour. Spec: DESIGN.md "Who did it". */
export function Who({
  handle,
  model,
  app,
  layout = 'inline',
  size,
  nofor,
  whole,
  personHref,
  runHref,
  onFollow,
}: WhoProps) {
  const { agent, person, run } = whoParts(handle);
  const name = (text: string, href: string | undefined, cls: string) =>
    href ? (
      <a className={cls} href={href} onClick={onFollow} dir="auto" translate="no">
        {text}
      </a>
    ) : (
      <span className={cls} dir="auto" translate="no">
        {text}
      </span>
    );
  const cls = `who${layout === 'line' ? ' one' : ''}${size ? ` a-${size}` : ''}`;
  if (whole) {
    const said = whoName(handle);
    return (
      <span className={`${cls} whole`} data-kind={agent ? 'agent' : 'person'} title={whoWords(handle, model)}>
        <Avatar handle={handle} />
        {agent ? <span className="sr">agent run </span> : null}
        {name(said, agent ? runHref : personHref, 'mono')}
      </span>
    );
  }
  if (!agent)
    return (
      <span className={cls} data-kind="person" title={person}>
        <Avatar handle={person} />
        {name(person, personHref, 'a-run mono')}
        {app ? <span className="t2">{app}</span> : null}
      </span>
    );
  return (
    <span className={cls} data-kind="agent" title={whoWords(handle, model)}>
      <Avatar handle={handle} />
      <span className="sr">agent run </span>
      {name(run, runHref, 'a-run mono')}
      {model === undefined ? null : model ? (
        <span className={`a-model mono${model.length > 12 ? ' long' : ''}`} translate="no">
          {model}
        </span>
      ) : (
        <span className="a-model nd">model not declared</span>
      )}
      {nofor ? null : (
        <span className="a-for">
          <span className="w">for </span>
          {name(person, personHref, 'mono')}
        </span>
      )}
      {app ? <span className="a-app t2">{app}</span> : null}
    </span>
  );
}

/** A count. `hot` is only for Needs you above zero; zero is never hidden. */
export function Count({
  n,
  hot = false,
  atLeast = false,
  label,
}: {
  n: number;
  hot?: boolean;
  atLeast?: boolean;
  label?: string;
}) {
  return (
    <span className={`cnt${hot && n > 0 ? ' hot' : ''}`} aria-label={label}>
      {n.toLocaleString()}
      {atLeast ? '+' : ''}
    </span>
  );
}
