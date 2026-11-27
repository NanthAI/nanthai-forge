// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The one rule for what waits on a person (Items 12fde646, 48049998), shared by the shell's "Needs you" count and the
// Needs me page so the two never disagree. A held Lane waits on a person only when that person has an action: an
// approval Forge enforces, or a person's own Lane that is stuck (choose an order, retry, update, set aside). An agent's
// conflict, failed check or moved main is its agent's next step; a refusal, a withdrawn landing and a Lane waiting
// for the one it depends on ask nobody. Those go to FYI. A question with choices addressed to the reader waits on
// the reader, and so does a Lane parked for the reader (Item e1633718); work reverted from main and a stopped mirror
// are shared-state decisions (Item 12fde646). Pure and small: the frame imports it eagerly.
import type { DeployStatusRead } from './deploy-status.js';
import { noticeAttention } from './needs-notice-attention.js';

export type HeldWhy =
  | 'conflict'
  | 'check-failed'
  | 'infra'
  | 'stale-head'
  | 'rejected'
  | 'review'
  | 'dependency'
  | 'withdrawn'
  | 'unknown';

/** One held Lane as projectNeedsMe:read returns it (convex/projectNeedsMe.ts `needsMeResult`). */
export type HeldLane = {
  laneId: string | null;
  intentId?: string | null;
  title: string | null;
  actor: string | null;
  agent: string | null;
  agentClient?: string;
  agentAuthored?: true;
  why: HeldWhy;
  note: string | null;
  submissionId: string | null;
  /** The held attempt of a landing held for review (the owner decides that exact attempt). */
  attemptId?: string;
  reviewCheck?: 'ran' | 'pending' | 'none' | 'not-configured';
  /** A review of several Lanes: every Lane of its one submission (they all wait on the reader). */
  laneIds?: readonly string[];
  url?: string | null;
  since: number;
  /** A Lane held for a dependency: the Lane it lands after, when the records name it. */
  dependsOn?: { laneId: string; title: string | null };
};
/** A Lane's park (Item e1633718, src/hosted-records.ts laneParkSchema): `to` is the holder's handle (`handle/run` for an agent run),
 * absent when no one is named; `by` who parked it; `at` when (ms). */
export type Park = { to?: string; named: boolean; toAgent?: true; reason: string; at: number; by: string };
/** Who a park waits on, as every screen names it: `@handle`, `handle/run`, a member the reader may not see, or no
 * one (null). */
export function parkHolder(park: Pick<Park, 'to' | 'named'>) {
  if (!park.named) return null;
  if (!park.to) return 'a member';
  return park.to.includes('/') ? park.to : `@${park.to.replace(/^@/, '')}`;
}
/** The words beside a parked Lane on the yard row and the Lane page. */
export const parkWords = (park: Pick<Park, 'to' | 'named'>) => {
  const holder = parkHolder(park);
  return holder ? `parked for ${holder}` : 'parked, no one named';
};
/** One open Lane parked for the reader (convex/projectNeedsMe.ts `parked`); `at` is its last activity (ms). */
export type ParkedLane = {
  laneId: string;
  intentId: string;
  title: string | null;
  actor: string;
  agent: string | null;
  park: Park;
  at: number;
};
/** Owner decision (Item e1633718, 2026-11-18): a Lane parked with no one named shows in its starter's Needs me after
 * this long with no activity; a named holder sees it at once. */
export const PARK_UNNAMED_AFTER_MS = 4 * 60 * 60_000;
/** Whether a parked Lane shows now: compared when the view is drawn against the activity time the read holds, so
 * nothing ticks and an idle tab reads nothing. */
const parkAttention = (row: ParkedLane, now: number) => {
  if (row.park.named) return row.park.toAgent || row.park.to?.includes('/') ? 'fyi' : 'viewer';
  return now - row.at >= PARK_UNNAMED_AFTER_MS ? 'viewer' : 'ahead';
};
/** One question with choices addressed to the reader (convex/projectNeedsFyi.ts `messagesTo`). */
export type Ask = {
  id: string;
  at: number;
  actor: string;
  agent: string | null;
  text: string;
  choices: string[];
  laneId: string | null;
  planningItemId?: string;
  ahead?: true;
  handBack?: {
    head: string;
    left: string;
    to: string;
    savedWork?: { title?: string; saves?: number; files?: number; lastSaveAt?: number };
  };
  recipientSession?: string;
  to?: string;
  recipientEnded?: true;
};
/** An open approval request from projectHostedApprovals `openApprovalRequests`. */
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
  /** Until when an agent's wait holds this settings request. */
  waitUntil?: number;
};

/** Shared-state evidence that stays until its condition clears. */
export type Notice = {
  kind: 'reverted' | 'needs-fix' | 'mirror' | 'deploy' | 'secrets' | 'source-proof';
  /** The reverted Intent's id, `mirror`, or `deploy:<target>`. */
  id: string;
  summary: string;
  next: string | null;
  since?: number;
  version?: string;
  receiptId?: string;
  tests?: readonly string[];
  moreTests?: number;
  who?: string;
  repair?: Pick<HeldLane, 'laneId' | 'title' | 'actor' | 'agent'>;
  laneId?: string;
  /** A revert somebody ran, offered to the Lane's owner (J08): never a hold on work. */
  taken?: Taken;
};
/** Which Lane was taken out of main, by whom and when (convex/projectHostedRevertNotice.ts); the card is worded from it. */
export type Taken = { laneId: string; title: string | null; by: string; agent: string | null; at: number };
export type NeedsRead = {
  held: readonly HeldLane[];
  more: number;
  moreIsLowerBound: boolean;
  reviewsMore?: true;
  approvals: string;
  canDecide: boolean;
  asks?: readonly Ask[];
  asksMore?: true;
  parked?: readonly ParkedLane[];
  parkedMore?: boolean;
  notices?: readonly Notice[];
  deployStatus?: DeployStatusRead;
  noticesMore?: true;
  noticesMoreSince?: number;
  /** What waits on a person in sealed secrets (convex/projectNeedsMe.ts `secrets`); write members only. */
  secrets?: number;
  /** Reverts the reader ran themselves (J08): FYI, never counted. `id` is the reverted Intent. */
  tookOut?: readonly (Taken & { id: string })[];
};

/** Whether a held Lane waits on this reader: only a decision they can make here (owner dogfood 2026-11-17). An
 * approval request or a landing held for review waits on the person who decides it; a failed check, a conflict, a
 * refusal or a wait is the Lane owner's to fix (FYI, with its next step), whoever owns it, since Needs you offers no
 * button for it. `canDecide`: the reader decides approvals in this project. */
function waitsOnPerson(lane: HeldLane, approval: boolean, canDecide: boolean) {
  const review = lane.why === 'review' && (lane.url || lane.laneId || (lane.submissionId && lane.attemptId));
  return canDecide && (approval || Boolean(review));
}

function approvalsOf(payload: string): { requests: Approval[]; complete: boolean } {
  try {
    const parsed = JSON.parse(payload) as { requests?: Approval[]; complete?: boolean };
    if (parsed.requests !== undefined && !Array.isArray(parsed.requests)) {
      return { requests: [], complete: false };
    }
    return { requests: parsed.requests ?? [], complete: parsed.complete !== false };
  } catch {
    return { requests: [], complete: false };
  }
}

/** Classify once by the action the reader can take. The page, badge and Lane marks use the same result. */
export function needsAttention(read: NeedsRead, now: number) {
  const { notices, nextAt: noticeAt, moreDue } = noticeAttention(read, now);
  let nextAt = noticeAt;
  const approvals = approvalsOf(read.approvals);
  const asked = new Set<string>();
  const blocked = new Set<string>();
  for (const request of approvals.requests) {
    if (!request?.needsOwner) continue;
    if (request.kind === 'lane') asked.add(request.laneId);
    if (
      read.canDecide &&
      request.kind === 'setting' &&
      typeof request.waitUntil === 'number' &&
      request.waitUntil > now
    ) {
      blocked.add(request.laneId);
      nextAt = Math.min(nextAt, request.waitUntil);
    }
  }
  const held = new Set(
    read.held.filter(lane => waitsOnPerson(lane, asked.has(lane.laneId ?? ''), read.canDecide)),
  );
  const parked = [];
  const parkedFyi = [];
  for (const lane of read.parked ?? []) {
    const attention = parkAttention(lane, now);
    if (attention === 'viewer') parked.push(lane);
    if (attention === 'fyi') parkedFyi.push(lane);
    if (attention === 'ahead') nextAt = Math.min(nextAt, lane.at + PARK_UNNAMED_AFTER_MS);
  }
  const asks = new Set(
    (read.asks ?? []).filter(row => !row.ahead && !row.recipientSession).map(row => row.id),
  );
  const actionable = notices.filter(notice => notice.action);
  return {
    held,
    parked,
    parkedFyi,
    asks,
    blocked,
    approvals,
    nextAt,
    notices: actionable,
    fyiNotices: notices.filter(notice => !notice.action),
    n:
      held.size +
      asks.size +
      parked.length +
      blocked.size +
      actionable.length +
      (read.secrets ? read.secrets - 1 : 0),
    atLeast:
      read.more > 0 ||
      read.reviewsMore === true ||
      read.parkedMore === true ||
      read.asksMore === true ||
      read.noticesMore === true ||
      moreDue ||
      !approvals.complete,
  };
}

/** A snapshot's time-based changes, not a subscription. The same rules classify each deadline
 * already in this bounded read. No person, message or Lane identifiers leave the account projection. */
export function attentionSchedule(read: NeedsRead, now: number) {
  let previous = needsAttention(read, now);
  const attention = { n: previous.n, atLeast: previous.atLeast };
  const attentionChanges = [];
  while (Number.isFinite(previous.nextAt)) {
    const at = previous.nextAt;
    const next = needsAttention(read, at);
    if (next.n !== previous.n || next.atLeast !== previous.atLeast)
      attentionChanges.push({ at, n: next.n, atLeast: next.atLeast });
    previous = next;
  }
  return { attention, ...(attentionChanges.length ? { attentionChanges } : {}) };
}

export function needsCount(read: NeedsRead | undefined, now = Date.now()) {
  if (!read) return undefined;
  const { n, atLeast } = needsAttention(read, now);
  return { n, atLeast };
}

/** The open Lanes that wait on the reader, by the rule above: held for a decision this reader makes, or parked for
 * them and shown now. Every screen that marks a held Lane (the top bar's line and F, the yard, the flow) takes it from
 * here, never its own rule, so they cannot disagree with the count (Item 9b9057a9). Undefined while the read is out. */
export type NeedsYou = {
  lanes: ReadonlySet<string>;
  known: 'all' | 'partial' | 'unknown';
  covered?: ReadonlySet<string>;
};
export function needsYouLanes(read: NeedsRead | undefined, now: number): NeedsYou | undefined {
  if (!read) return undefined;
  const { held, parked } = needsAttention(read, now);
  const out = new Set<string>();
  for (const lane of held) {
    if (lane.laneId) out.add(lane.laneId);
    for (const id of lane.laneIds ?? []) out.add(id);
  }
  for (const row of parked) out.add(row.laneId);
  if (read.more === 0 && !read.reviewsMore && !read.parkedMore) return { lanes: out, known: 'all' };
  const covered = new Set(out);
  for (const lane of read.held) {
    if (lane.laneId) covered.add(lane.laneId);
    for (const id of lane.laneIds ?? []) covered.add(id);
  }
  for (const lane of read.parked ?? []) covered.add(lane.laneId);
  return { lanes: out, known: 'partial', covered };
}
/** Needs me's read failed: no held Lane is known to wait on the reader, and the page says it could not tell. */
export const NEEDS_UNKNOWN: NeedsYou = { lanes: new Set(), known: 'unknown' };
/** Preserve the shared rule for covered Lanes. Omitted marks can use the line's own flag. */
export function waitingLanes(
  needs: NeedsYou | undefined,
  marks: readonly { laneId: string; held: boolean; fix?: true }[] = [],
): ReadonlySet<string> | undefined {
  if (!needs || needs.known === 'unknown') return undefined;
  if (needs.known === 'all') return needs.lanes;
  const waiting = new Set(needs.lanes);
  for (const mark of marks) {
    if (mark.held && !mark.fix && !needs.covered?.has(mark.laneId)) waiting.add(mark.laneId);
  }
  return waiting;
}
