// SPDX-License-Identifier: Apache-2.0
// Needs me, as data (Items 9e748e41, 12fde646): what holds work comes first, longest held first, one row per
// held Lane so the count is the top bar's "Needs you" number; requests asked ahead are listed apart and never
// counted (DESIGN.md rules 15, 16, 41). Pure: the screen draws it, tests/app-needs-me.test.mjs pins it.
import type { StateWord } from '../../ds';
import type { LineFeed } from '../Line';

export type HeldWhy =
  | 'conflict'
  | 'check-failed'
  | 'infra'
  | 'stale-head'
  | 'rejected'
  | 'review'
  | 'dependency'
  | 'unknown';
/** One held Lane as projectNeedsMe:read returns it (convex/projectNeedsMe.ts `needsMeResult`). */
export type HeldLane = {
  laneId: string;
  title: string | null;
  actor: string | null;
  agent: string | null;
  why: HeldWhy;
  note: string | null;
  submissionId: string | null;
  since: number;
};
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
};
export type NeedsRead = {
  held: readonly HeldLane[];
  more: number;
  moreIsLowerBound: boolean;
  approvals: string;
  canDecide: boolean;
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
};
export type AheadRow = Approval & { word: StateWord; tag: string; head: string; who: string | null };
export type NeedsView = {
  now: NowRow[];
  ahead: AheadRow[];
  /** Held Lanes: the shown rows plus those past the read's limit. The same number as the top bar. */
  count: number;
  /** True when `count` is a lower bound (the read stopped at its limit). */
  atLeast: boolean;
  /** False when the approvals read hit its bound: a missing request is "can't confirm", never "none". */
  approvalsComplete: boolean;
};

const words: Record<HeldWhy, StateWord> = {
  conflict: 'Conflict',
  'check-failed': 'Check failed',
  infra: 'Not run',
  'stale-head': 'Needs you',
  rejected: 'Needs you',
  review: 'Needs you',
  dependency: 'Waiting its turn',
  unknown: 'Needs you',
};
const tags: Record<HeldWhy, string> = {
  conflict: 'Conflict',
  'check-failed': 'Check failed',
  infra: 'Not run',
  'stale-head': 'Main moved',
  rejected: 'Refused',
  review: 'Approval',
  dependency: 'Waiting its turn',
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
  unknown: title => `${title} is held. Why: not reported.`,
};

/** `person/agent` for an agent, `@person` for a person, nothing when the reader may not see people. */
export function whoOf(actor: string | null | undefined, agent: string | null | undefined) {
  if (!actor) return null;
  const handle = actor.replace(/^@/, '');
  return agent ? `${handle}/${agent}` : `@${handle}`;
}

export function laneTitle(lane: Pick<HeldLane, 'title' | 'laneId'>) {
  const title = lane.title?.replace(/\s+/g, ' ').trim();
  return title || `Lane ${lane.laneId.slice(0, 8)}`;
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

export function needsView(read: NeedsRead): NeedsView {
  const { requests, complete } = approvalsOf(read.approvals);
  const laneApprovals = new Map(
    requests.filter(request => request.kind === 'lane').map(request => [request.laneId, request]),
  );
  const now = read.held
    .map(lane => {
      const approval = laneApprovals.get(lane.laneId) ?? null;
      const why: HeldWhy = lane.why === 'unknown' && approval ? 'review' : lane.why;
      return {
        ...lane,
        why,
        word: words[why],
        tag: tags[why],
        head: questions[why](laneTitle(lane)),
        who: whoOf(lane.actor, lane.agent),
        approval,
      };
    })
    // Longest held first (Item 9e748e41, I41); ties keep the read's order.
    .sort((a, b) => a.since - b.since);
  // A Lane request holds that Lane's landing, so it is drawn on the held row, never twice (rule 9).
  const ahead = requests
    .filter(request => request.kind !== 'lane')
    .map(request => ({
      ...request,
      word: aheadWord(request),
      tag: request.membership
        ? 'Access'
        : request.kind === 'setting'
          ? 'Setting'
          : request.kind === 'fork'
            ? 'Fork run'
            : 'Request',
      head: aheadHead(request),
      who: whoOf(request.requester, request.agent),
    }));
  return {
    now,
    ahead,
    count: read.held.length + read.more,
    atLeast: read.moreIsLowerBound,
    approvalsComplete: complete,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The page sentence: the answer first, then at most one more clause (DESIGN.md rule 45). */
export function needsSentence(view: NeedsView): { bold: string; rest: string } {
  const lanes = `${view.atLeast ? 'At least ' : ''}${plural(view.count, 'Lane')}`;
  const ahead = view.ahead.length
    ? `${plural(view.ahead.length, 'request')} asked ahead ${view.ahead.length === 1 ? 'holds' : 'hold'} nothing yet.`
    : '';
  if (view.count)
    return { bold: `${lanes} ${view.count === 1 ? 'is' : 'are'} held until you decide.`, rest: ahead };
  return {
    bold: 'Nothing needs you.',
    rest: ahead || 'Nothing is held and no agent is waiting for an answer.',
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

export type Moving = { total: number; parts: string; more: number; moreIsLowerBound: boolean };
/** Lanes moving without the reader: the line's marks that are not held, by stop. */
export function moving(feed: LineFeed | undefined): Moving | null {
  if (!feed) return null;
  const free = feed.lanes.filter(lane => !lane.held);
  const at = (stage: string) => free.filter(lane => lane.stage === stage).length;
  const parts = (
    [
      ['editing', 'editing'],
      ['saved', 'saved'],
      ['checking', 'checking'],
      ['ready', 'ready to land'],
    ] as const
  )
    .map(([stage, word]) => [at(stage), word] as const)
    .filter(([n]) => n)
    .map(([n, word]) => `${n.toLocaleString()} ${word}`)
    .join(', ');
  return { total: free.length, parts, more: feed.more, moreIsLowerBound: feed.moreIsLowerBound };
}

/** Item counts from the planning index (projectWorkIndex:records with counts). Left is planned work not started. */
export type ItemCounts = {
  done: number;
  inProgress: number;
  left: number;
  proposed: number;
  complete: boolean;
};
export function itemCounts(
  page: { counts?: Record<string, number>; isDone: boolean; coverage?: string } | undefined,
): ItemCounts | null {
  if (!page?.counts) return null;
  const n = (status: string) => page.counts![status] ?? 0;
  return {
    done: n('closed'),
    inProgress: n('in-progress'),
    left: n('open'),
    proposed: n('proposed'),
    complete: page.isDone && !page.coverage,
  };
}
