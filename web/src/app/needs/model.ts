// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Needs me, as data (Items 9e748e41, 12fde646, 48049998): what waits on the reader comes first, longest held first,
// one row per held Lane that waits on a person (count.ts `waitsOnPerson`) plus questions for the reader, so the count
// is the top bar's "Needs you" number; held Lanes that ask nobody become FYI rows naming who acts next; requests asked
// ahead are listed apart and never counted (DESIGN.md rules 15, 16, 41). Pure: tests/app-needs-me.test.mjs pins it.
import type { StateWord } from '../../ds';
import { landingHold } from '../../../../src/hosted-landing-hold';
import { heldState, heldWhyState } from '../lane-state';
import type { AttentionNotice } from './notice-attention';
import {
  needsAttention,
  parkHolder,
  parkWords,
  type Approval,
  type Ask,
  type HeldLane,
  type HeldWhy,
  type NeedsRead,
  type Park,
  type ParkedLane,
  type Taken,
} from './count';

export type { Approval, Ask, HeldLane, HeldWhy, NeedsRead, Notice, Park, ParkedLane, Taken } from './count';
export type NowRow = HeldLane & {
  word: StateWord;
  /** The kind, in the state's colour: what holds it. */
  tag: string;
  /** The line's question: what holds it and what the reader decides. */
  head: string;
  /** Detail for the card, whose title and state are already shown separately. */
  detail: string | null;
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

export function protectedApprovalCopy(row: HeldLane) {
  if (row.why !== 'review' || !row.note) return null;
  const paths = landingHold({
    observation: { state: 'pending', pendingReason: 'waiting-for-review' },
    error: { code: 'REVIEW_REQUIRED', message: row.note },
  })?.paths;
  if (!paths?.length) return null;
  const reason =
    paths.length === 1
      ? `Changes a protected path: ${paths[0]}.`
      : `Changes ${paths.length} protected paths: ${paths[0]} and ${paths.length - 1} more.`;
  return row.reviewCheck === 'not-configured' ? `${reason} No check is set up.` : reason;
}
/** Work reverted from main, work that needs a fix, or a stopped mirror (Item 12fde646): a shared-state decision. */
export type NoticeRow = AttentionNotice & { word: StateWord; tag: string; head: string };
/** A revert the reader ran: an FYI row with the Lane to bring back. */
export type TookOutRow = Taken & { id: string };
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
  /** Lanes parked for the reader that show now: counted. */
  parked: ParkedRow[];
  parkedFyi: ParkedRow[];
  /** Shared-state decisions (work reverted from main, a stopped mirror): counted, and kept until the state changes. */
  notices: NoticeRow[];
  fyiNotices: NoticeRow[];
  /** Reverts the reader ran themselves (J08): FYI rows, never counted. */
  tookOut: TookOutRow[];
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
  /** True when `count` is a lower bound: `atLeast`, or more recovery notices than the read lists. FYI
   * counts Lanes only, so it keeps `atLeast`. */
  countAtLeast: boolean;
  /** False when the approvals read hit its bound: a missing request is "can't confirm", never "none". */
  approvalsComplete: boolean;
  /** The timestamp at which this view was classified, used for wait durations in the headline. */
  at: number;
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
const cardDetails: Partial<Record<HeldWhy, string>> = {
  conflict: 'Conflicts with another change.',
  infra: 'The check could not run on your CI.',
  'stale-head': 'Main moved during the landing.',
  review: 'Waiting for approval to land.',
  unknown: 'Forge has no landing outcome on record.',
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
        : row.park.toAgent
          ? `${title} is parked for an agent.`
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
  'source-proof': 'Source verification stopped',
  mirror: 'GitHub mirror',
  deploy: 'Deploy needs attention',
  secrets: 'Secrets',
} as const;
const noticeFallback = {
  reverted: 'A change was taken out of main.',
  'needs-fix': 'A change needs a fix before it can land again.',
  'source-proof': 'Forge stopped a recompose when its source proof failed.',
  mirror: 'The GitHub mirror stopped.',
  deploy: 'A deploy failed.',
  secrets: 'Sealed secrets wait on you.',
} as const;
const RAW_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const AGENT_COMMAND =
  /\bnforge\b|\bland\s+--[a-z-]+|\bsave\s+--[a-z-]+|\bFix it in this Lane\b|"retry"\s*:\s*true|\bsupersedeFinish\b/i;
const REPAIR_SUFFIX = /\b(?:Fix it\b|If it fails without your\b)[\s\S]*$/i;
/** Text a person reads: a card never shows a raw id or an agent's command (J08, 01.1/06.2). The board note, CLI and
 * agent status keep their exact text; the web words the card itself. */
export const readable = (text: string | null | undefined) =>
  text && !RAW_UUID.test(text) && !AGENT_COMMAND.test(text) ? text : null;
/** Clean person-facing summary from a Lane note: strips trailing agent repair instructions and drops raw ids/commands. */
function readableNote({ note, why }: HeldLane) {
  if (!note) return null;
  const summary = why === 'check-failed' ? note.replace(REPAIR_SUFFIX, '') : note;
  return readable(summary.replace(/\s+/g, ' ').trim());
}
/** "@who took “title” out of main" (an offer to the Lane's owner), or "You took …" for the one who ran it. */
function takenHead(taken: Taken) {
  const title = readable(taken.title?.replace(/\s+/g, ' ').trim());
  return `${whoOf(taken.by, taken.agent) ?? 'Someone'} took ${title ? `“${title}”` : 'a change'} out of main.`;
}
function noticeRow(notice: AttentionNotice): NoticeRow {
  const tests = notice.tests?.map(readable).filter(Boolean) ?? [];
  const testSummary = tests.length
    ? `${tests.join(', ')}${notice.moreTests ? ` and ${notice.moreTests} more` : ''} failed on main.`
    : null;
  const who = notice.who ?? whoOf(notice.repair?.actor, notice.repair?.agent);
  return {
    ...notice,
    ...(who ? { who } : {}),
    word: notice.kind === 'reverted' || !notice.action ? 'Check failed' : 'Needs you',
    tag: notice.kind === 'deploy' && !notice.action ? 'Deploy failed' : noticeTags[notice.kind],
    head: notice.taken
      ? takenHead(notice.taken)
      : (testSummary ?? readable(notice.summary) ?? noticeFallback[notice.kind]),
    next: readable(notice.next),
  };
}

/** Classify the read at the shell's draw time or the next recorded attention deadline. */
export function needsView(read: NeedsRead, now = Date.now()): NeedsView {
  const attention = needsAttention(read, now);
  const { requests, complete } = attention.approvals;
  const laneApprovals = new Map(
    requests.filter(request => request.kind === 'lane').map(request => [request.laneId, request]),
  );
  const perItem = new Map<string, number>();
  for (const lane of read.held)
    if (lane.intentId) perItem.set(lane.intentId, (perItem.get(lane.intentId) ?? 0) + 1);
  const rows = read.held
    .map(lane => {
      const approval = laneApprovals.get(lane.laneId ?? '') ?? null;
      const why: HeldWhy = lane.why === 'unknown' && approval ? 'review' : lane.why;
      const who = whoOf(lane.actor, lane.agent);
      const waits = attention.held.has(lane);
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
        detail:
          readableNote(lane) ??
          (waits && after ? `Waiting for ${after} to land.` : (cardDetails[why] ?? null)),
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
  const asks = messageRows.filter(row => attention.asks.has(row.id));
  const askedAhead = messageRows.filter(row => Boolean(row.ahead) && !row.recipientSession);
  const sessionAsks = messageRows.filter(row => Boolean(row.recipientSession));
  const parked = attention.parked.map(parkedRow).sort((a, b) => a.since - b.since);
  // A Lane request holds that Lane's landing, so it is drawn on the held row, never twice (rule 9). Asked before the
  // Lane holds a landing (request-approval, then wait), it holds nothing yet and is listed ahead (Item 0a99ab23).
  const heldLanes = new Set(read.held.map(lane => lane.laneId));
  const blockedIds = attention.blocked;
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
    parkedFyi: attention.parkedFyi.map(parkedRow),
    tookOut: [...(read.tookOut ?? [])],
    notices: attention.notices.map(noticeRow),
    fyiNotices: attention.fyiNotices.map(noticeRow),
    fyi,
    ahead,
    blocked,
    count: attention.n,
    atLeast: read.more > 0 || read.parkedMore === true || read.asksMore === true,
    countAtLeast: attention.atLeast,
    approvalsComplete: complete,
    at: now,
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

/** Earliest timestamp among holds currently waiting on the reader (excludes offers, deploys, FYI and asked ahead). */
function oldestHoldAt(view: NeedsView): number | null {
  let oldest = Infinity;
  const consider = (at: number | undefined) => {
    if (typeof at === 'number' && Number.isFinite(at) && at < oldest) oldest = at;
  };
  for (const row of view.now) consider(row.since);
  for (const row of view.asks) consider(row.at);
  for (const row of view.parked) consider(row.since);
  for (const row of view.blocked) consider(Date.parse(row.at));
  for (const row of view.notices) {
    if (!row.taken && row.kind !== 'deploy') consider(row.since);
  }
  return Number.isFinite(oldest) ? oldest : null;
}

/** The page sentence: the answer first (including the longest eligible hold), then at most one more clause (rule 45). */
export function needsSentence(view: NeedsView, now = view.at): { bold: string; rest: string } {
  // A taken-out change offered to its owner is a choice, not a hold: nothing waits on it (J08).
  const offers = view.notices.filter(notice => notice.taken).length;
  const deploys = view.notices.filter(notice => notice.kind === 'deploy').length;
  const holds = view.count - offers - deploys;
  const lowerBound = view.countAtLeast ? 'At least ' : '';
  const needYou = `${lowerBound}${plural(view.count, 'thing')} need you.`;
  const aheadCount = view.ahead.length + (view.askedAhead?.length ?? 0);
  const ahead = aheadCount
    ? `${plural(aheadCount, 'request')} asked ahead ${aheadCount === 1 ? 'holds' : 'hold'} nothing yet.`
    : '';
  const deploySentence = deploys
    ? `${deploys === 1 ? 'A deploy needs' : `${deploys} deploys need`} someone to look into ${deploys === 1 ? 'it' : 'them'}.`
    : '';
  if (holds > 0) {
    const oldest = oldestHoldAt(view);
    const span = oldest !== null ? waited(oldest, now) : null;
    const duration = span ? (span === 'just now' ? 'under 1 min' : span) : null;
    const longest = duration
      ? holds === 1
        ? `; waiting ${duration}`
        : `; the longest has waited ${duration}`
      : '';
    const prefix = holds === view.count ? lowerBound : '';
    const holding = `${prefix}${plural(holds, 'thing')} ${holds === 1 ? 'holds' : 'hold'} work until you decide${longest}.`;
    return holds === view.count ? { bold: holding, rest: ahead } : { bold: needYou, rest: holding };
  }
  if (deploys && offers) return { bold: needYou, rest: deploySentence };
  if (deploySentence) return { bold: deploySentence, rest: ahead };
  if (offers)
    return {
      bold: `${offers === 1 ? 'A change' : `${offers.toLocaleString()} changes`} you own ${offers === 1 ? 'was' : 'were'} taken out of main.`,
      rest: ahead || 'Nothing is held; bring it back or leave it out.',
    };
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

/** The Standing bar's In-progress detail: open Lanes plus the shared Needs you attention count. */
export function standingInProgress(
  lanesOpen: number | null,
  view: Pick<NeedsView, 'count' | 'countAtLeast'> | null,
) {
  if (lanesOpen === null) return undefined;
  const open = `${lanesOpen.toLocaleString()} ${lanesOpen === 1 ? 'Lane' : 'Lanes'} open`;
  if (!view || view.count <= 0) return open;
  const count = `${view.count.toLocaleString()}${view.countAtLeast ? '+' : ''}`;
  const verb = view.count === 1 && !view.countAtLeast ? 'needs' : 'need';
  return `${open}, ${count} ${verb} you`;
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

/** "18 min ago", or "just now" under a minute (never "just now ago"). */
export function agoText(since: number, now: number) {
  const span = waited(since, now);
  return span === 'just now' ? 'just now' : `${span} ago`;
}

/** "Waiting 18 min", or "Waiting under 1 min" under a minute. */
export function waitingText(since: number, now: number) {
  const span = waited(since, now);
  return span === 'just now' ? 'Waiting under 1 min' : `Waiting ${span}`;
}

/** In-browser guidance for an approval request: never tells a person already in Forge to open the approve link. */
export function inPageApprovalNext(
  row: Pick<Approval, 'kind' | 'needsOwner' | 'nextStep' | 'membership' | 'setting'>,
  canDecide: boolean,
  onLanePage = false,
) {
  if (!row.needsOwner) return row.nextStep.replace(/\s*(?:from|at) the approve link\b/gi, ' below');
  if (!canDecide) return 'Only the project owner can approve or decline this request.';
  if (row.membership) return 'Approve or decline the membership change below.';
  if (row.setting?.origin === 'github-connect') return 'Allow on GitHub or decline below.';
  if (row.kind === 'setting') return 'Approve or decline the settings change below.';
  if (row.kind === 'fork') return 'Approve or decline the check run for this pull request below.';
  return onLanePage
    ? 'Approve or decline below; approving lets the Lane land.'
    : 'Review the Lane to approve or decline; approving lets it land.';
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
