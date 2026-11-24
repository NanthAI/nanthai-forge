// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Needs me, as data (Items 9e748e41, 12fde646, 48049998): what waits on the reader comes first, longest held first,
// one row per held Lane that waits on a person (count.ts `waitsOnPerson`) plus questions for the reader, so the count
// is the top bar's "Needs you" number; held Lanes that ask nobody become FYI rows naming who acts next; requests asked
// ahead are listed apart and never counted (DESIGN.md rules 15, 16, 41). Pure: tests/app-needs-me.test.mjs pins it.
import type { StateWord } from '../../ds';
import { heldState, heldWhyState } from '../lane-state';
import {
  approvalsTruncated,
  blockedRequestIds,
  laneRequests,
  parkHolder,
  parkShown,
  parkWords,
  waitsOnPerson,
  type Ask,
  type HeldLane,
  type HeldWhy,
  type NeedsRead,
  type Notice,
  type Park,
  type ParkedLane,
} from './count';

export type { Ask, HeldLane, HeldWhy, NeedsRead, Notice, Park, ParkedLane } from './count';
/** One open request from the approvals payload (projectHostedApprovals `openApprovalRequests`). */
export type Approval = {
  laneId: string;
  kind: 'lane' | 'fork' | 'setting';
  needsOwner: boolean;
  label: string;
  nextStep: string;
  reason?: string;
  requester?: string;
  agent?: string;
  head: string;
  at: string;
  membership?: boolean;
  setting?: { origin: string };
  /** Until when an agent's wait holds this settings request (ms); future = an agent is blocked on it. */
  waitUntil?: number;
};
export type NowRow = HeldLane & {
  word: StateWord;
  /** The kind, in the state's colour: what holds it. */
  tag: string;
  /** The line's question: what holds it and what the reader decides. */
  head: string;
  who: string | null;
  /** The Lane's approval request, when the hold is a landing waiting for the owner. */
  approval: Approval | null;
  /** The held landing itself, when it waits for review: a landing-policy hold (protected paths, a supervised
   * project) has no request, and the owner decides this exact attempt as the /approve page does. */
  landing: { submissionId: string; attemptId: string } | null;
  /** The short Lane mark, and how many held Lanes share its Item, so two rows never look the same. */
  mark: string;
  siblings: number;
  /** For an FYI row: what happens next, and who does it. */
  next: string | null;
};
export type AskRow = Ask & { who: string | null };
/** Work reverted from main, work that needs a fix, or a stopped mirror (Item 12fde646): a shared-state decision. */
export type NoticeRow = Notice & { word: StateWord; tag: string; head: string };
/** A Lane parked for the reader (Item e1633718): named to the reader, or the reader's own Lane parked with no one
 * named and idle 4 h. `since` is when it was parked (named) or last active (no one named). */
export type ParkedRow = ParkedLane & {
  head: string;
  tag: string;
  who: string | null;
  mark: string;
  since: number;
};
/** `head` stays the request's own head, which a decision must name; `question` is what the row says. */
export type AheadRow = Approval & { word: StateWord; tag: string; question: string; who: string | null };
export type NeedsView = {
  now: NowRow[];
  /** Questions with choices for the reader: they wait on the reader, so they are counted. */
  asks: AskRow[];
  askedAhead?: AskRow[];
  /** Questions directed at an agent session (live or ended): never live answer keys here, never counted. */
  sessionAsks?: AskRow[];
  /** Lanes parked for the reader that show now (count.ts `parkShown`): counted. */
  parked: ParkedRow[];
  /** Shared-state decisions (work reverted from main, a stopped mirror): counted, and kept until the state changes. */
  notices: NoticeRow[];
  /** Held, but nothing for a person to decide (count.ts `waitsOnPerson`): FYI rows, never counted. */
  fyi: NowRow[];
  ahead: AheadRow[];
  /** Settings and GitHub-connect requests an agent is blocked on: they wait on the reader, so they are counted
   * (Item 12fde646). */
  blocked: AheadRow[];
  /** What waits on the reader: held rows that wait on a person plus questions. The shell's number (count.ts). */
  count: number;
  /** True when the held, question or parked rows stopped at the read's limit. */
  atLeast: boolean;
  /** True when `count` is a lower bound: `atLeast`, or more recovery notices than the read lists. The Held page
   * counts Lanes only, so it keeps `atLeast`. */
  countAtLeast: boolean;
  /** False when the approvals read hit its bound: a missing request is "can't confirm", never "none". */
  approvalsComplete: boolean;
};

/** The held word is the one every screen says for this hold (lane-state.ts). */
const stateOf = (why: HeldWhy) =>
  (heldWhyState as Record<string, (typeof heldWhyState)[keyof typeof heldWhyState]>)[why] ?? 'unknown';
const wordOf = (why: HeldWhy): StateWord => heldState({ state: stateOf(why) }).glyph;
const tags: Record<HeldWhy, string> = {
  conflict: 'Conflict',
  'check-failed': 'Check failed',
  infra: 'Not run',
  'stale-head': 'Main moved',
  rejected: 'Refused',
  review: 'Approval',
  dependency: 'Waiting its turn',
  withdrawn: 'Withdrawn',
  unknown: 'Held',
};
const questions: Record<HeldWhy, (title: string) => string> = {
  conflict: title => `${title} conflicts with another change. Which lands first?`,
  'check-failed': title => `${title}: its check failed. Retry it or set it aside?`,
  infra: title => `${title}: the check could not run on your CI. Run it again?`,
  'stale-head': title => `${title}: main moved under it. Update it from main?`,
  rejected: title => `${title}: Forge refused the landing.`,
  review: title => `${title} waits for your approval to land.`,
  dependency: title => `${title} waits for the Lane it depends on.`,
  withdrawn: title => `${title}: its agent withdrew the landing.`,
  unknown: title => `${title} is held; Forge has no landing outcome on record for it.`,
};
/** FYI lines: what happened, without a question (nobody here is asked to decide). */
const facts: Record<HeldWhy, (title: string) => string> = {
  conflict: title => `${title} conflicts with another change.`,
  'check-failed': title => `${title}: its check failed.`,
  infra: title => `${title}: the check could not run on your CI.`,
  'stale-head': title => `${title}: main moved under it.`,
  rejected: title => `Forge refused the landing of ${title}.`,
  review: title => `${title} waits for an approval.`,
  dependency: title => `${title} waits for the Lane it depends on.`,
  withdrawn: title => `${title}: its agent withdrew the landing.`,
  unknown: title => `${title} is held; Forge has no landing outcome on record for it.`,
};
/** Who acts next on an FYI row, and how. `who` is the agent (or person) holding the Lane. */
function nextStep(why: HeldWhy, who: string | null) {
  const by = who ?? 'its holder';
  switch (why) {
    case 'conflict':
      return `${by} updates it from main and lands again`;
    case 'check-failed':
      return `${by} fixes it in the same Lane`;
    case 'infra':
      return `${by} runs the check again`;
    case 'stale-head':
      return `${by} updates it from main`;
    case 'rejected':
      return `${by} reads why and lands again`;
    case 'dependency':
      return 'it lands after the Lane it depends on';
    case 'withdrawn':
      return `${by} lands again when ready`;
    case 'review':
      return 'the project owner approves or declines it';
    default:
      return `${by} lands it again from the Lane`;
  }
}

/** `person/agent` for an agent, `@person` for a person, nothing when the reader may not see people. */
export function whoOf(actor: string | null | undefined, agent: string | null | undefined) {
  if (!actor) return null;
  const handle = actor.replace(/^@/, '');
  return agent ? `${handle}/${agent}` : `@${handle}`;
}

/** A bare id (a UUID, or a long hex digest) is never a title: such a goal falls back to the short Lane mark. */
const BARE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,64})$/i;
export function laneTitle(
  lane: Pick<HeldLane, 'title' | 'laneId'> & Partial<Pick<HeldLane, 'submissionId'>>,
) {
  const title = lane.title?.replace(/\s+/g, ' ').trim();
  if (title && !BARE_ID.test(title)) return title;
  return lane.laneId
    ? `Lane ${lane.laneId.slice(0, 8)}`
    : `Submission ${lane.submissionId?.slice(0, 8) ?? ''}`;
}

function approvalsOf(payload: string): { requests: Approval[]; complete: boolean } {
  try {
    const parsed = JSON.parse(payload) as { requests?: Approval[]; complete?: boolean };
    return { requests: parsed.requests ?? [], complete: parsed.complete !== false };
  } catch {
    return { requests: [], complete: false };
  }
}

const aheadWord = (request: Approval): StateWord =>
  request.kind === 'fork' ? 'Waiting its turn' : 'Needs you';
function aheadHead(request: Approval) {
  const asked = request.reason?.replace(/\s+/g, ' ').trim();
  if (asked) return asked;
  if (request.membership) return 'A membership change waits for you.';
  if (request.kind === 'setting') return 'A settings change waits for you.';
  if (request.kind === 'fork') return 'A pull request from a fork asks to run its checks.';
  return request.label;
}

/** The parked row's line. The holder named is the reader (an agent run's holder is the reader's own run). */
function parkedRow(row: ParkedLane): ParkedRow {
  const title = laneTitle(row);
  const holder = parkHolder(row.park);
  const run = holder?.includes('/') ? holder.slice(holder.indexOf('/') + 1) : null;
  return {
    ...row,
    head: !row.park.named
      ? `${title} is parked, no one named.`
      : run
        ? `${title} is parked for your agent run ${run}.`
        : `${title} is parked for you.`,
    tag: row.park.named ? 'Parked' : 'Parked, no one named',
    who: row.park.by || null,
    mark: row.laneId.slice(0, 8),
    since: row.park.named ? row.park.at : row.at,
  };
}

const noticeTags = {
  reverted: 'Reverted from main',
  'needs-fix': 'Fix needed',
  mirror: 'GitHub mirror',
  deploy: 'Deploy failed',
} as const;
function noticeRow(notice: Notice): NoticeRow {
  return {
    ...notice,
    word: notice.kind === 'reverted' || notice.kind === 'deploy' ? 'Check failed' : 'Needs you',
    tag: noticeTags[notice.kind],
    head: notice.summary || `${noticeTags[notice.kind]}.`,
  };
}

/** `now` decides only which Lanes parked with no one named show (count.ts `parkShown`); the page passes the time
 * its reads arrived, so nothing ticks. */
export function needsView(read: NeedsRead, now = Date.now()): NeedsView {
  const { requests, complete } = approvalsOf(read.approvals);
  const laneApprovals = new Map(
    requests.filter(request => request.kind === 'lane').map(request => [request.laneId, request]),
  );
  const asked = laneRequests(read.approvals);
  const perItem = new Map<string, number>();
  for (const lane of read.held)
    if (lane.intentId) perItem.set(lane.intentId, (perItem.get(lane.intentId) ?? 0) + 1);
  const rows = read.held
    .map(lane => {
      const approval = laneApprovals.get(lane.laneId ?? '') ?? null;
      const why: HeldWhy = lane.why === 'unknown' && approval ? 'review' : lane.why;
      const who = whoOf(lane.actor, lane.agent);
      const waits = waitsOnPerson({ why }, asked.has(lane.laneId ?? ''), read.canDecide);
      // A dependency the read names: the Lane it lands after, by name (Item 9e748e41).
      const after =
        why === 'dependency' && lane.dependsOn
          ? laneTitle({ laneId: lane.dependsOn.laneId, title: lane.dependsOn.title })
          : null;
      return {
        ...lane,
        why,
        waits,
        word: wordOf(why),
        tag: tags[why],
        head: after
          ? `${laneTitle(lane)} waits for ${after} to land.`
          : (waits ? questions : facts)[why](laneTitle(lane)),
        who,
        approval,
        landing:
          why === 'review' && lane.submissionId && lane.attemptId
            ? { submissionId: lane.submissionId, attemptId: lane.attemptId }
            : null,
        mark: (lane.laneId ?? lane.submissionId ?? '').slice(0, 8),
        siblings: lane.intentId ? (perItem.get(lane.intentId) ?? 1) : 1,
        next: waits ? null : after ? `it lands after ${after}` : nextStep(why, who),
      };
    })
    // Longest held first (Item 9e748e41, I41); ties keep the read's order.
    .sort((a, b) => a.since - b.since);
  const waiting = rows.filter(row => row.waits).map(({ waits: _waits, ...row }) => row);
  const fyi = rows.filter(row => !row.waits).map(({ waits: _waits, ...row }) => row);
  const messageRows = (read.asks ?? [])
    .map(ask => ({ ...ask, who: whoOf(ask.actor, ask.agent) }))
    .sort((a, b) => a.at - b.at);
  const asks = messageRows.filter(row => !row.ahead && !row.recipientSession);
  const askedAhead = messageRows.filter(row => Boolean(row.ahead) && !row.recipientSession);
  const sessionAsks = messageRows.filter(row => Boolean(row.recipientSession));
  const parked = (read.parked ?? [])
    .filter(row => parkShown(row, now))
    .map(parkedRow)
    .sort((a, b) => a.since - b.since);
  // A Lane request holds that Lane's landing, so it is drawn on the held row, never twice (rule 9). Asked before the
  // Lane holds a landing (request-approval, then wait), it holds nothing yet and is listed ahead (Item 0a99ab23).
  const heldLanes = new Set(read.held.map(lane => lane.laneId));
  const blockedIds = blockedRequestIds(read.approvals, now, read.canDecide);
  const listed = requests
    // Only a request still waiting for the owner is listed: a granted or declined one is the Lane page's to show
    // (Item 4f1f7984).
    .filter(request => request.needsOwner && (request.kind !== 'lane' || !heldLanes.has(request.laneId)));
  const ahead = listed.filter(request => !blockedIds.has(request.laneId)).map(aheadRow);
  const blocked = listed.filter(request => blockedIds.has(request.laneId)).map(aheadRow);
  return {
    now: waiting,
    asks,
    ...(askedAhead.length ? { askedAhead } : {}),
    ...(sessionAsks.length ? { sessionAsks } : {}),
    parked,
    notices: (read.notices ?? []).map(noticeRow),
    fyi,
    ahead,
    blocked,
    count: waiting.length + asks.length + parked.length + blocked.length + (read.notices?.length ?? 0),
    atLeast: read.more > 0 || read.parkedMore === true || read.asksMore === true,
    countAtLeast:
      read.more > 0 ||
      read.parkedMore === true ||
      read.asksMore === true ||
      read.noticesMore === true ||
      approvalsTruncated(read.approvals),
    approvalsComplete: complete,
  };
}

/** A request asked ahead, as Needs me and the Lane page draw it (Item 0a99ab23). */
export function aheadRow(request: Approval): AheadRow {
  return {
    ...request,
    word: aheadWord(request),
    tag: request.membership
      ? 'Access'
      : request.setting?.origin === 'github-connect'
        ? 'GitHub'
        : request.kind === 'setting'
          ? 'Setting'
          : request.kind === 'fork'
            ? 'Fork run'
            : 'Request',
    question: aheadHead(request),
    who: whoOf(request.requester, request.agent),
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The page sentence: the answer first, then at most one more clause (DESIGN.md rule 45). */
export function needsSentence(view: NeedsView): { bold: string; rest: string } {
  const lanes = `${view.countAtLeast ? 'At least ' : ''}${plural(view.count, 'thing')}`;
  const aheadCount = view.ahead.length + (view.askedAhead?.length ?? 0);
  const ahead = aheadCount
    ? `${plural(aheadCount, 'request')} asked ahead ${aheadCount === 1 ? 'holds' : 'hold'} nothing yet.`
    : '';
  if (view.count)
    return { bold: `${lanes} ${view.count === 1 ? 'holds' : 'hold'} work until you decide.`, rest: ahead };
  if (view.countAtLeast) return { bold: 'Some requests could not be listed.', rest: ahead };
  // A hold that asks nobody is still a hold: never "nothing is held" while one is (Item 9b9057a9).
  const stuck = view.fyi.length;
  return {
    bold: 'Nothing needs you.',
    rest:
      ahead ||
      (stuck
        ? `${plural(stuck, 'Lane')} ${stuck === 1 ? 'is' : 'are'} held; ${stuck === 1 ? 'its' : 'their'} agent or holder acts next.`
        : 'Nothing is held and no agent is waiting for an answer.'),
  };
}

/** The Held page's sentence: how many Lanes are held now (those waiting on the reader and those waiting on their
 * agent or holder), by the same rows Needs me draws, then what the list below it is. */
export function heldSentence(view: NeedsView): { bold: string; rest: string } {
  const held = view.now.length + view.fyi.length;
  return {
    bold: held
      ? `${view.atLeast ? 'At least ' : ''}${plural(held, 'Lane')} ${held === 1 ? 'is' : 'are'} held now.`
      : view.atLeast
        ? 'Some held Lanes could not be listed.'
        : 'Nothing is held now.',
    rest: view.now.length
      ? `${view.now.length.toLocaleString()} wait${view.now.length === 1 ? 's' : ''} on you, decided on Needs me. Below: everything Forge held, redid or refused.`
      : 'Below: everything Forge held, redid or refused.',
  };
}

/** "waiting 18 min": how long the hold has lasted, from the time the view was drawn (no timer). */
export function waited(since: number, now: number) {
  const minutes = Math.max(0, Math.round((now - since) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60 ? `${minutes % 60} min` : ''}`.trim();
  return `${Math.floor(hours / 24)} d`;
}

/** The Lane page's park sentence (Item e1633718): who it waits on, for how long, and why in the parker's words. */
export function parkLine(park: Park, now: number) {
  const words = parkWords(park);
  return `${words[0]!.toUpperCase()}${words.slice(1)} (${waited(park.at, now)}): ${park.reason.replace(/\s+/g, ' ').trim()}`;
}

/** The Lane page's hold sentence (friction e2f436b6), from the same Needs me read: "for you" only when Needs me says
 * this hold waits on the reader; otherwise why it is held, for how long, and who acts next. Before the read answers,
 * or when the Lane is past its limit, only "Held.": never a guess at whom it waits on. */
export function holdLine(view: NeedsView | undefined, laneId: string, now: number) {
  const mine = view?.now.find(row => row.laneId === laneId);
  if (mine) return `Held for your approval (${waited(mine.since, now)}).`;
  const other = view?.fyi.find(row => row.laneId === laneId);
  if (!other) return 'Held.';
  const next = other.next ? ` Next: ${other.next}.` : '';
  return `Held (${waited(other.since, now)}): ${heldState({ state: stateOf(other.why) }).why}.${next}`;
}
