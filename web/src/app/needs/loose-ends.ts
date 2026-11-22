// SPDX-License-Identifier: Apache-2.0
// Loose ends (Item fc1831eb) as data. `looseEndsView` is the folded Needs me region's Lane groups. `looseEndsScreen`
// is the Loose ends page from the details read (projectLooseEnds:read with details: true): the five groups in the
// approved order, each with its rows, its next page cursor, or why it is not reported, plus pages the reader asked for
// merged once per group. `setAsideWord` says what happened to each Lane the owner set aside. Pure.
import { waited, whoOf } from './model';

export type LooseRow = {
  laneId: string;
  intentId: string;
  title: string;
  actor: string;
  agent: string | null;
  paths: number;
  at: number;
  /** Another open Lane of the same Item is live: this one was left behind, and its agent abandons it. */
  replacedBy?: string;
  /** Current liveness evidence, for rows in the Still active group. */
  heldBy?: string;
  /** Why the details read listed it. */
  reason?: string;
};
/** A project of the reader's with no landing for 30 days (projectLooseEndsDetails inactiveProjects). */
export type ProjectRow = {
  projectId: string;
  name: string;
  role: string;
  lastLandingAt: number | null;
  reason: string;
};
/** The first unchecked Done-when line with a date on an open Item (projectLooseEndsDetails datedChecks). */
export type DatedRow = {
  selection: { itemId: string; expectedVersion: number };
  title: string;
  date: string;
  line: number;
  text: string;
  reason: string;
};
type Listed<Row> = {
  reported: true;
  rows: Row[];
  more?: boolean;
  continueCursor?: string | null;
  /** A reported group whose coverage is incomplete says so. */
  why?: string;
};
type NotReported = { reported: false; why: string };
type Group<Row = LooseRow> = Listed<Row> | NotReported;
export type LooseEndsRead = {
  at: number;
  setAside?: { authorityEpoch: number } | null;
  groups: {
    idle?: Group | null;
    stopped?: Group;
    checked?: Group;
    projects?: Group<ProjectRow>;
    dated?: Group<DatedRow>;
    active?: Group;
  };
};
export type GroupKey = 'idle' | 'stopped' | 'checked' | 'projects' | 'dated';
type LaneKey = 'idle' | 'stopped' | 'checked' | 'active';

const LANE_META: { key: LaneKey; title: string; hint: string }[] = [
  { key: 'idle', title: 'Lanes nobody holds', hint: 'no save for days, oldest first' },
  { key: 'stopped', title: 'Stopped mid-task', hint: 'no save, sync or start for over 90 minutes' },
  { key: 'checked', title: 'Checked, never landed', hint: 'the check passed and nobody asked to land' },
  { key: 'active', title: 'Still active', hint: 'has a live landing or recent activity' },
];

/** The folded region's view: Lane groups only. Leftover projects and dated checks are read on the Loose ends page. */
export function looseEndsView(read: LooseEndsRead, now: number) {
  const groups = LANE_META.flatMap(meta => {
    const group = read.groups[meta.key];
    if (!group) return [];
    return [
      {
        ...meta,
        reported: group.reported,
        why: group.reported ? null : group.why,
        more: group.reported && !!group.more,
        rows: group.reported
          ? group.rows.map(row => ({ ...row, who: whoOf(row.actor, row.agent), age: waited(row.at, now) }))
          : [],
      },
    ];
  });
  const unreported = (['projects', 'dated'] as const).flatMap(key => {
    const group = read.groups[key];
    return group && !group.reported
      ? [
          {
            key,
            title: key === 'projects' ? 'Leftover projects' : 'Waiting for a date',
            reported: false as const,
          },
        ]
      : [];
  });
  return {
    groups: [
      ...groups,
      ...unreported.map(group => ({ ...group, hint: '', why: null, more: false, rows: [] })),
    ],
  };
}

/** Rows a reader asked for past the first page, per group, and where each group continues. */
export type Pages = Partial<Record<GroupKey | 'active', { rows: unknown[]; cursor?: string | null }>>;

/** Merge one continuation reply for `key`: only that group's rows and cursor (a Lane page also returns the Lanes it
 * found held meanwhile, which join Still active). A row already shown is not repeated. */
export function mergePage(pages: Pages, key: GroupKey, reply: LooseEndsRead): Pages {
  const group = reply.groups[key];
  const next: Pages = { ...pages };
  if (group?.reported)
    next[key] = { rows: [...(pages[key]?.rows ?? []), ...group.rows], cursor: group.continueCursor ?? null };
  const active = reply.groups.active;
  if (active?.reported && active.rows.length)
    next.active = { rows: [...(pages.active?.rows ?? []), ...active.rows], cursor: null };
  return next;
}

export type ScreenRow = {
  key: string;
  title: string;
  who: string | null;
  /** The project name is code-like and set in mono. */
  mono: boolean;
  evidence: string;
  age: string;
  laneId: string | null;
  itemId: string | null;
};
export type Section = {
  key: GroupKey | 'active';
  title: string;
  hint: string;
  reported: boolean;
  /** Why the group is not reported, or why its coverage is incomplete. */
  why: string | null;
  rows: ScreenRow[];
  cursor: string | null;
  pickable: boolean;
};

const SCREEN_META: { key: GroupKey | 'active'; title: string; hint: string }[] = [
  { key: 'idle', title: 'Lanes nobody holds', hint: 'no save for days, oldest first' },
  {
    key: 'checked',
    title: 'Checked, never landed',
    hint: 'the work passed and then nobody asked for the landing',
  },
  { key: 'stopped', title: 'Stopped mid-task', hint: 'no save, sync or start for over 90 minutes' },
  { key: 'projects', title: 'Leftover projects', hint: 'no landing for 30 days' },
  { key: 'dated', title: 'Waiting for a date', hint: 'a Done-when line with a date' },
  { key: 'active', title: 'Still active', hint: 'has a live landing or recent activity, left alone' },
];
const files = (n: number) => (n ? `${n.toLocaleString('en')} ${n === 1 ? 'file' : 'files'}` : 'no files yet');

/** How long ago, as the approved page words it: "40 min", "3 h", "6 days". */
function since(at: number, now: number) {
  const hours = Math.floor((now - at) / 3_600_000);
  return hours < 48
    ? waited(at, now).replace(/ h \d+ min$/, ' h')
    : `${Math.floor(hours / 24).toLocaleString('en')} days`;
}

/** "1 December", with the year when it is not this year's. Dates are calendar days (YYYY-MM-DD, UTC). */
function dueWords(date: string, reason: string, now: number) {
  const day = new Date(`${date}T00:00:00Z`);
  const sameYear = day.getUTCFullYear() === new Date(now).getUTCFullYear();
  const words = day.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
  return reason === 'Due today'
    ? 'due today'
    : reason === 'Date passed'
      ? `was due ${words}`
      : `due ${words}`;
}

function laneRow(row: LooseRow, key: GroupKey | 'active', now: number): ScreenRow {
  const age = since(row.at, now);
  return {
    key: row.laneId,
    title: row.title || 'Lane without a goal',
    who: whoOf(row.actor, row.agent),
    mono: false,
    evidence:
      files(row.paths) +
      (row.replacedBy ? `, replaced by Lane ${row.replacedBy.slice(0, 8)}` : '') +
      (row.heldBy ? ` · ${row.heldBy}` : ''),
    age: key === 'stopped' ? `not seen for ${age}` : age,
    laneId: row.laneId,
    itemId: null,
  };
}
const projectRow = (row: ProjectRow, now: number): ScreenRow => ({
  key: row.projectId,
  title: row.name,
  who: null,
  mono: true,
  evidence: `${row.reason}; you are its ${row.role}`,
  age: row.lastLandingAt === null ? 'never landed' : `no landing for ${since(row.lastLandingAt, now)}`,
  laneId: null,
  itemId: null,
});
const datedRow = (row: DatedRow, now: number): ScreenRow => ({
  key: `${row.selection.itemId}:${row.line}`,
  title: row.text,
  who: null,
  mono: false,
  evidence: `Done-when line ${row.line} on the Item “${row.title}”`,
  age: dueWords(row.date, row.reason, now),
  laneId: null,
  itemId: row.selection.itemId,
});

/** The Loose ends page: the five groups in the approved order (and the Lanes held meanwhile), the sentence over them.
 * Only Lanes nobody holds can be picked, and only by the owner (the read carries the set-aside authority). */
export function looseEndsScreen(read: LooseEndsRead, pages: Pages, now: number) {
  // The live read classifies a Lane: a continued row of a Lane the live read now lists elsewhere (held meanwhile, or
  // moved between groups) is dropped, so one Lane is shown, and picked, once.
  const live = new Set(
    (['idle', 'stopped', 'checked', 'active'] as const).flatMap(key => {
      const group = read.groups[key];
      return group?.reported ? group.rows.map(row => row.laneId) : [];
    }),
  );
  // A Lane a continued page found held meanwhile is shown under Still active, not where an older page listed it.
  const heldLater = new Set(((pages.active?.rows ?? []) as LooseRow[]).map(row => row.laneId));
  const sections = SCREEN_META.flatMap((meta): Section[] => {
    const extra = pages[meta.key];
    // Lanes found held on a continued page form Still active even when the live first page held none.
    const group =
      read.groups[meta.key] ?? (extra ? { reported: true as const, rows: [], continueCursor: null } : null);
    if (!group) return [];
    if (!group.reported)
      return [{ ...meta, reported: false, why: group.why, rows: [], cursor: null, pickable: false }];
    const lanes = meta.key !== 'projects' && meta.key !== 'dated';
    const continued = ((extra?.rows ?? []) as LooseRow[]).filter(
      row => !lanes || (!live.has(row.laneId) && (meta.key === 'active' || !heldLater.has(row.laneId))),
    );
    const seen = new Set<string>();
    const rows = [...group.rows, ...continued]
      .map(row =>
        meta.key === 'projects'
          ? projectRow(row as ProjectRow, now)
          : meta.key === 'dated'
            ? datedRow(row as DatedRow, now)
            : laneRow(row as LooseRow, meta.key, now),
      )
      .filter(row => !seen.has(row.key) && !!seen.add(row.key));
    return [
      {
        ...meta,
        reported: true,
        why: group.why ?? null,
        rows,
        cursor: extra ? (extra.cursor ?? null) : (group.continueCursor ?? null),
        pickable: meta.key === 'idle' && !!read.setAside,
      },
    ];
  });
  const loose = sections.filter(section => section.key !== 'active');
  const total = loose.reduce((sum, section) => sum + section.rows.length, 0);
  const more = loose.some(section => section.cursor);
  const partial = loose.some(section => section.reported && section.why);
  const quiet = loose.filter(section => !section.reported);
  const oldest = sections.find(section => section.key === 'idle')?.rows[0];
  const notYet = quiet.length
    ? ` ${new Intl.ListFormat('en-GB').format(quiet.map(section => section.title))} ${quiet.length === 1 ? 'is' : 'are'} not reported yet; ${quiet.length === 1 ? 'it says' : 'each says'} why.`
    : '';
  // "Nothing" only once every reported group is read to its end with full coverage.
  const exhausted = !more && !partial;
  return {
    sections,
    total,
    exhausted,
    sentence: total
      ? {
          bold: `${total.toLocaleString('en')}${more ? ' or more' : ''} loose ${total === 1 && !more ? 'end' : 'ends'}.`,
          rest: `${oldest ? `The oldest is a Lane with no save for ${oldest.age}. ` : ''}Setting a Lane aside keeps every save; nothing here is deleted.${notYet}`,
        }
      : exhausted
        ? {
            bold: 'Nothing is left lying around.',
            rest: `No Lane, project or dated check is waiting.${notYet}`,
          }
        : {
            bold: 'No loose ends shown yet.',
            rest: `${more ? 'Some groups have more to read; Show 25 more keeps looking.' : 'Some groups are not fully read yet; each says why.'}${notYet}`,
          },
  };
}

/** What `projectHostedDormant:abandon` said about one Lane, in words. A failed call is the only kind retry repeats. */
export function setAsideWord(result: string | 'failed') {
  switch (result) {
    case 'abandoned':
      return { word: 'Set aside', done: true, retry: false };
    case 'has-saved-work':
      return { word: 'Skipped: it holds work that is not on main', done: false, retry: false };
    case 'not-dormant':
      return { word: 'Skipped: it was saved meanwhile', done: false, retry: false };
    case 'pinned':
      return { word: 'Skipped: it is pinned', done: false, retry: false };
    case 'not-open':
    case 'not-found':
      return { word: 'Skipped: it is already closed', done: false, retry: false };
    case 'failed':
      return { word: 'Could not set aside', done: false, retry: true };
    default:
      return { word: `Skipped (${result})`, done: false, retry: false };
  }
}
