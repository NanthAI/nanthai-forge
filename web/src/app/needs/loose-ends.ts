// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Loose ends (Item fc1831eb) as data. `looseEndsView` is the folded Needs me region's Lane groups. `looseEndsScreen`
// is the Loose ends page from the details read (projectLooseEnds:read with details: true): the five groups in the
// approved order, each with its rows, its next page cursor, or why it is not reported, plus pages the reader asked for
// merged once per group. `setAsideWord` says what happened to each Lane the owner set aside, `trashWord` to each
// project moved to the trash, and `handText` is the one prompt that hands Lanes to an agent. Pure.
import { waited, whoOf } from './model';
import type { IntentPin, IntentRow } from './loose-intents';

export type LooseRow = {
  laneId: string;
  intentId: string;
  title: string;
  actor: string;
  agent: string | null;
  paths: number;
  at: number;
  /** Saves this Lane has had, stored by its own writes (Item fc1831eb). Absent: not recorded, never guessed. */
  saves?: number;
  /** A landing of this Lane's work was recorded before; absent means it never landed. */
  landedBefore?: true;
  /** When an unrequested check last passed on this exact head (Checked, never landed rows). */
  passedAt?: number;
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
  /** Stored by the project's own writes (Item fc1831eb); absent means not recorded yet. */
  openLanes?: number;
  /** More than the counted number of open Lanes. */
  openLanesMore?: true;
  bytes?: number;
  /** Present on the reader's own projects: what projectLifecycle:trash pins (revision and the landing seen). */
  trash?: ProjectTrash;
};
/** An open permanent-delete request of the reader's account (projectDeleteRequests openDeleteRequests). */
export type DeleteRequestRow = { id: string; selector: string; projects: number; byDevice: boolean };
/** The first unchecked Done-when line with a date on an open Item (projectLooseEndsDetails datedChecks). */
export type DatedRow = {
  selection: { itemId: string; expectedVersion: number };
  title: string;
  date: string;
  line: number;
  text: string;
  reason: string;
  /** The Item's owner (`@handle` or `@handle/agent`) and whether it is still proposed. */
  owner?: string;
  proposed?: true;
};
type Listed<Row> = {
  reported: true;
  rows: Row[];
  more?: boolean;
  continueCursor?: string | null;
  /** A reported group whose coverage is incomplete says so. */
  why?: string;
  /** Leftover projects only: the account's projects waiting for a permanent-delete approval. */
  deleteRequests?: DeleteRequestRow[];
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
    intents?: Group<IntentRow>;
    active?: Group;
  };
};
export type GroupKey = 'idle' | 'stopped' | 'checked' | 'projects' | 'dated' | 'intents';
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

/** What a row offers: the owner sets an idle Lane aside, anyone hands a stopped one to an agent, the owner of a
 * leftover project moves it to the trash, a dated check opens its Item. */
export type ProjectTrash = { expectedRevision: number; expectedLastLanding?: string | null };
export type RowAction = 'set-aside' | 'tidy' | 'hand' | 'trash' | 'open';
export type ScreenRow = {
  key: string;
  title: string;
  /** `@handle` or `handle/agent`, shown whole as the approved page does. */
  who: string | null;
  /** The project name is code-like and set in mono. */
  mono: boolean;
  evidence: string;
  age: string;
  laneId: string | null;
  itemId: string | null;
  action: RowAction | null;
  /** The row has a tick box: its action can run on many at once. */
  pickable: boolean;
  /** Leftover projects: what the trash pins. */
  trash: ProjectTrash | null;
  /** Dated checks: the Item is still proposed. */
  proposed: boolean;
  /** Open Intents: what the reader pinned, for the batch set-aside. */
  intent: IntentPin | null;
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
  /** Leftover projects only: open permanent-delete requests of the account. */
  deleteRequests: DeleteRequestRow[];
  /** Open Intents only: not read yet; the reader asks for the first page. */
  unread: boolean;
};

const SCREEN_META: { key: GroupKey | 'active'; title: string; hint: string }[] = [
  { key: 'idle', title: 'Lanes nobody holds', hint: 'no save for days, oldest first' },
  {
    key: 'checked',
    title: 'Checked, never landed',
    hint: 'the work passed and then nobody asked for the landing',
  },
  { key: 'stopped', title: 'Stopped mid-task', hint: 'no save, sync or start for over 90 minutes' },
  {
    key: 'intents',
    title: 'Open Intents with no Item',
    hint: 'left open with nothing to land against, oldest first',
  },
  { key: 'projects', title: 'Leftover projects', hint: 'no landing for 30 days' },
  { key: 'dated', title: 'Waiting for a date', hint: 'nothing to do until then' },
  { key: 'active', title: 'Still active', hint: 'has a live landing or recent activity, left alone' },
];
const files = (n: number) => (n ? `${n.toLocaleString('en')} ${n === 1 ? 'file' : 'files'}` : 'no files yet');
const saves = (n: number) => `${n.toLocaleString('en')} ${n === 1 ? 'save' : 'saves'}`;
/** A stored size, as the approved page words it: "12 MB", "1.2 TB". Decimal units from MB up, no decimals from 10. */
export function sizeWords(bytes: number) {
  if (bytes <= 0) return '0 MB';
  if (bytes < 1_000_000) return '<1 MB';
  const units = ['MB', 'GB', 'TB', 'PB'];
  let unit = 0,
    size = bytes / 1_000_000;
  while (size >= 1000 && unit < units.length - 1) {
    size /= 1000;
    unit++;
  }
  return `${(size >= 10 ? Math.round(size) : Math.round(size * 10) / 10).toLocaleString('en')} ${units[unit]}`;
}

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

/** What a Lane row says about its saves and landing, from the fields its own writes stored. A Lane written before
 * those fields existed says "not recorded" until its next save; the file count stays as the recorded fact. */
function laneEvidence(row: LooseRow, key: GroupKey | 'active', now: number) {
  const extra =
    (row.replacedBy ? `, replaced by Lane ${row.replacedBy.slice(0, 8)}` : '') +
    (row.heldBy ? ` · ${row.heldBy}` : '');
  // A row without a save count was written before the counts existed: its landing history is not asserted either.
  const landed = row.landedBefore ? 'landed before' : row.saves === undefined ? '' : 'never landed';
  if (key === 'checked')
    return `passed its check ${since(row.passedAt ?? row.at, now)} ago; landing was never asked for`;
  if (key === 'stopped')
    return `${
      row.saves === 0
        ? 'Nothing saved yet'
        : row.saves === undefined
          ? row.paths
            ? `${files(row.paths)} now, saves not recorded`
            : 'Saves not recorded'
          : `${saves(row.saves)} not landed`
    }${extra}. Why it stopped: not reported`;
  return `${[row.saves === undefined ? 'saves not recorded' : saves(row.saves), files(row.paths), landed].filter(Boolean).join(', ')}${extra}`;
}
const plain = { laneId: null, itemId: null, trash: null, proposed: false, pickable: false, intent: null };
function laneRow(row: LooseRow, key: GroupKey | 'active', now: number, owner: boolean): ScreenRow {
  const age = since(row.at, now);
  const extra =
    (row.replacedBy ? `, replaced by Lane ${row.replacedBy.slice(0, 8)}` : '') +
    (row.heldBy ? ` · ${row.heldBy}` : '');
  const action: RowAction | null =
    key === 'idle' ? (owner ? 'set-aside' : null) : key === 'active' ? null : 'hand';
  return {
    ...plain,
    key: row.laneId,
    title: row.title || 'Lane without a goal',
    who: whoOf(row.actor, row.agent),
    mono: false,
    evidence: laneEvidence(row, key, now) + (key === 'checked' ? extra : ''),
    age:
      key === 'stopped'
        ? `not seen for ${age}`
        : key === 'checked' && row.passedAt
          ? since(row.passedAt, now)
          : age,
    laneId: row.laneId,
    action,
    // Picking many is the owner's: the selection's Set aside needs the owner's authority.
    pickable: owner && action !== null,
  };
}
/** An open Intent no Item links. The batch refuses one whose Item link is not reported or whose Lanes cannot be read in
 * one bounded step, so those rows are listed for review and cannot be picked. */
const intentRow = (row: IntentRow, now: number, owner: boolean): ScreenRow => {
  const at = row.lastActivityAt === null ? null : Date.parse(row.lastActivityAt);
  // Undo reopens an Intent as open, so only an open one is tidied here; a proposed or ready one is for review.
  const review = row.reason !== 'No linked Item' || at === null || row.status !== 'active';
  const status = row.status === 'proposed' ? 'proposed' : row.status === 'ready' ? 'ready' : 'open';
  return {
    ...plain,
    key: row.selection.intentId,
    title: row.title || 'Intent without an outcome',
    who: null,
    mono: false,
    evidence:
      `${row.reason}, ${status}` +
      (row.reason !== 'No linked Item' || status !== 'open'
        ? '; review it before tidying'
        : at === null
          ? '; more Lanes than one read covers, review them first'
          : ''),
    age: at === null ? 'activity not known' : since(at, now),
    action: owner && !review ? 'tidy' : null,
    pickable: owner && !review,
    intent: row.selection,
  };
};
const projectEvidence = (row: ProjectRow) => {
  const lanes =
    row.openLanes === undefined
      ? 'open Lanes not recorded'
      : `${row.openLanes.toLocaleString('en')}${row.openLanesMore ? '+' : ''} open ${row.openLanes === 1 && !row.openLanesMore ? 'Lane' : 'Lanes'}`;
  return row.bytes === undefined ? `size not recorded, ${lanes}` : `${sizeWords(row.bytes)}, ${lanes}`;
};
const projectRow = (row: ProjectRow, now: number, viewer: string | undefined): ScreenRow => ({
  ...plain,
  key: row.projectId,
  title: row.name,
  who: row.trash && viewer ? `@${viewer.replace(/^@/, '')}` : null,
  mono: true,
  evidence: projectEvidence(row),
  age: row.lastLandingAt === null ? 'never landed' : `no landing for ${since(row.lastLandingAt, now)}`,
  action: row.trash ? 'trash' : null,
  pickable: !!row.trash,
  trash: row.trash ?? null,
});
const datedRow = (row: DatedRow, now: number): ScreenRow => ({
  ...plain,
  key: `${row.selection.itemId}:${row.line}`,
  title: row.text,
  who: row.owner ?? null,
  mono: false,
  evidence: `Done-when line ${row.line} on the Item “${row.title}”`,
  age: dueWords(row.date, row.reason, now),
  itemId: row.selection.itemId,
  action: 'open',
  proposed: !!row.proposed,
});

/** The Loose ends page: the five groups in the approved order (and the Lanes held meanwhile), the sentence over them.
 * The owner (the read carries the set-aside authority) picks Lanes; a project is picked by its own owner. */
export function looseEndsScreen(read: LooseEndsRead, pages: Pages, now: number, viewer?: string) {
  const owner = !!read.setAside;
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
  let urgent = 0;
  const sections = SCREEN_META.flatMap((meta): Section[] => {
    const extra = pages[meta.key];
    // Open Intents are read on request: until the first page is asked for, the group offers it.
    if (meta.key === 'intents' && !extra)
      return [
        { ...meta, reported: true, why: null, rows: [], cursor: null, deleteRequests: [], unread: true },
      ];
    // Lanes found held on a continued page form Still active even when the live first page held none.
    const group =
      read.groups[meta.key] ?? (extra ? { reported: true as const, rows: [], continueCursor: null } : null);
    if (!group) return [];
    if (!group.reported)
      return [
        {
          ...meta,
          reported: false,
          why: group.why,
          rows: [],
          cursor: null,
          deleteRequests: [],
          unread: false,
        },
      ];
    const lanes = meta.key !== 'projects' && meta.key !== 'dated' && meta.key !== 'intents';
    const continued = ((extra?.rows ?? []) as LooseRow[]).filter(
      row => !lanes || (!live.has(row.laneId) && (meta.key === 'active' || !heldLater.has(row.laneId))),
    );
    const seen = new Set<string>();
    const rows = [...group.rows, ...continued]
      .map(row => {
        if (meta.key === 'projects') return projectRow(row as ProjectRow, now, viewer);
        if (meta.key === 'intents') return intentRow(row as IntentRow, now, owner);
        if (meta.key !== 'dated') return laneRow(row as LooseRow, meta.key, now, owner);
        if ((row as DatedRow).reason === 'Date passed') urgent++;
        return datedRow(row as DatedRow, now);
      })
      .filter(row => !seen.has(row.key) && !!seen.add(row.key));
    return [
      {
        ...meta,
        reported: true,
        // A page of open Intents read to its end with none left says so; it is not a coverage gap.
        why:
          group.why ??
          (meta.key === 'intents' && !rows.length && !(extra ? extra.cursor : group.continueCursor)
            ? 'None found. Every open Intent has an Item.'
            : null),
        rows,
        cursor: extra ? (extra.cursor ?? null) : (group.continueCursor ?? null),
        deleteRequests: (group as { deleteRequests?: DeleteRequestRow[] }).deleteRequests ?? [],
        unread: false,
      },
    ];
  });
  const loose = sections.filter(section => section.key !== 'active');
  const total = loose.reduce((sum, section) => sum + section.rows.length, 0);
  const more = loose.some(section => section.cursor);
  const partial = loose.some(section => section.reported && section.why && section.key !== 'intents');
  const oldest = sections.find(section => section.key === 'idle')?.rows[0];
  // "Nothing" only once every reported group is read to its end with full coverage. A group not reported says so
  // on its own band, never in this sentence.
  const exhausted = !more && !partial;
  const one = total === 1 && !more;
  return {
    sections,
    total,
    exhausted,
    /** Open Intents have not been read, so "no loose ends" cannot speak for them. */
    intentsUnread: sections.some(section => section.unread),
    sentence: total
      ? {
          bold: `${total.toLocaleString('en')}${more ? ' or more' : ''} loose ${one ? 'end' : 'ends'}, ${urgent ? `${urgent.toLocaleString('en')} urgent` : one ? 'not urgent' : 'none urgent'}.`,
          rest: `${oldest ? `The oldest is a Lane with no save for ${oldest.age}. ` : ''}Setting a Lane aside keeps every save; a project in the trash can be restored for 90 days.`,
        }
      : exhausted
        ? {
            bold: 'Nothing is left lying around.',
            rest: 'Every open Lane had a recent save, and every project landed something in the last 30 days.',
          }
        : {
            bold: 'No loose ends shown yet.',
            rest: more
              ? 'Some groups have more to read; Show 25 more keeps looking.'
              : 'Some groups are not fully read yet; each says why.',
          },
  };
}

/** What `projectHostedDormant:abandon` said about one Lane, in words. A failed call is the only kind retry repeats. */
export function setAsideWord(result: string | 'failed') {
  switch (result) {
    case 'abandoned':
      return { word: 'Set aside', done: true, retry: false };
    case 'reopened':
      return { word: 'Brought back', done: false, retry: false };
    case 'has-saved-work':
      return { word: 'Skipped: it holds work that is not on main', done: false, retry: false };
    case 'not-dormant':
      return { word: 'Skipped: it was saved meanwhile', done: false, retry: false };
    case 'changed':
      return { word: 'Skipped: it changed meanwhile', done: false, retry: false };
    case 'pinned':
      return { word: 'Skipped: it is pinned', done: false, retry: false };
    case 'in-queue':
      return { word: 'Skipped: it is in the landing queue', done: false, retry: false };
    case 'not-open':
    case 'not-found':
      return { word: 'Skipped: it is already closed', done: false, retry: false };
    case 'failed':
      return { word: 'Could not set aside', done: false, retry: true };
    default:
      return { word: `Skipped (${result})`, done: false, retry: false };
  }
}

/** What projectLifecycle:trash did to one project. `changed` is its WORK_STALE refusal: the project changed since the
 * list was read, so it was left alone. */
export function trashWord(result: 'trashed' | 'changed' | 'failed' | 'restored') {
  switch (result) {
    case 'trashed':
      return { word: 'In the trash', done: true, retry: false };
    case 'restored':
      return { word: 'Restored', done: false, retry: false };
    case 'changed':
      return { word: 'Skipped: it changed meanwhile', done: false, retry: false };
    default:
      return { word: 'Could not move to the trash', done: false, retry: true };
  }
}

/** The one prompt "Hand to an agent" copies: the existing explicit takeover (`start --open` with `takeover`) for each
 * Lane, then the agent finishes or abandons it. It names the project, so an agent opened anywhere finds its checkout
 * (or clones one). Nothing is sent; the reader pastes it into their own agent app. */
export function handText(
  lanes: { laneId: string; title: string }[],
  project: { name: string; projectId: string; backend: string },
) {
  const list = lanes.map(lane => `- ${lane.title.replace(/\s+/g, ' ').trim()} (${lane.laneId})`).join('\n');
  return (
    `Take over ${lanes.length === 1 ? 'this Lane' : `these ${lanes.length} Lanes`} of the Forge project ${JSON.stringify(project.name)} (project ID ${project.projectId}) from Loose ends and finish ${lanes.length === 1 ? 'it' : 'them'}. ` +
    `Work in an existing checkout of that project (ROOT below), or make one with nforge clone ${project.projectId} NEW_DIRECTORY --deployment ${project.backend}. ` +
    `For each Lane run nforge agent ROOT start --open '{"laneId":"LANE_ID","takeover":true,"reason":"Handed over from Loose ends"}', ` +
    'work in the Lane path it returns, read its Item and saves, then land it with nforge agent ROOT land --save, or abandon it with a reason if the work is no longer needed. Every save is kept either way.\n' +
    list
  );
}
