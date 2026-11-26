// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The one rule for what waits on a person (Items 12fde646, 48049998), shared by the shell's "Needs you" count and the
// Needs me page so the two never disagree. A held Lane waits on a person only when that person has an action: an
// approval Forge enforces, or a person's own Lane that is stuck (choose an order, retry, update, set aside). An agent's
// conflict, failed check or moved main is its agent's next step; a refusal, a withdrawn landing and a Lane waiting
// for the one it depends on ask nobody. Those go to FYI. A question with choices addressed to the reader waits on
// the reader, and so does a Lane parked for the reader (Item e1633718); work reverted from main and a stopped mirror
// are shared-state decisions (Item 12fde646). Pure and small: the frame imports it eagerly.
import type { DeployStatusRead } from '../../../../src/deploy-status';
import type { Id } from '../../../../convex/_generated/dataModel';
import { makeFunctionReference } from 'convex/server';

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
export type Park = { to?: string; named: boolean; reason: string; at: number; by: string };
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
export const parkShown = (row: Pick<ParkedLane, 'park' | 'at'>, now: number) =>
  row.park.named || now - row.at >= PARK_UNNAMED_AFTER_MS;
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
  handBack?: { head: string; left: string; to: string };
  recipientSession?: string;
  to?: string;
  recipientEnded?: true;
};
/** A shared-state decision a person settles (convex/projectNeedsMe.ts `notices`, Items 12fde646, 8b6efb50): work
 * reverted from main, work that still needs a fix, a GitHub mirror that stopped, or a failed deploy / post-deploy smoke.
 * It stays until the state changes. */
export type Notice = {
  kind: 'reverted' | 'needs-fix' | 'mirror' | 'deploy' | 'secrets';
  /** The reverted Intent's id, `mirror`, or `deploy:<target>`. */
  id: string;
  summary: string;
  next: string | null;
  /** A revert somebody ran, offered to the Lane's owner (J08): never a hold on work. */
  taken?: Taken;
};
/** Which Lane was taken out of main, by whom and when (convex/projectHostedRevertNotice.ts); the card is worded from it. */
export type Taken = { laneId: string; title: string | null; by: string; agent: string | null; at: number };
export type NeedsRead = {
  held: readonly HeldLane[];
  more: number;
  moreIsLowerBound: boolean;
  approvals: string;
  canDecide: boolean;
  asks?: readonly Ask[];
  asksMore?: true;
  parked?: readonly ParkedLane[];
  parkedMore?: boolean;
  notices?: readonly Notice[];
  deployStatus?: DeployStatusRead;
  noticesMore?: true;
  /** What waits on a person in sealed secrets (convex/projectNeedsMe.ts `secrets`); write members only. */
  secrets?: number;
  /** Reverts the reader ran themselves (J08): FYI, never counted. `id` is the reverted Intent. */
  tookOut?: readonly (Taken & { id: string })[];
};

export const needsRead = makeFunctionReference<'query', { projectId: Id<'hostedProjects'> }, NeedsRead>(
  'projectNeedsMe:read',
);

/** Whether a held Lane waits on this reader: only a decision they can make here (owner dogfood 2026-11-17). An
 * approval request or a landing held for review waits on the person who decides it; a failed check, a conflict, a
 * refusal or a wait is the Lane owner's to fix (FYI, with its next step), whoever owns it, since Needs you offers no
 * button for it. `canDecide`: the reader decides approvals in this project. */
export function waitsOnPerson(lane: Pick<HeldLane, 'why'>, approval: boolean, canDecide: boolean) {
  return canDecide && (approval || lane.why === 'review');
}

/** Item 12fde646: open settings and GitHub-connect requests an agent is blocked on right now (its waiter marked
 * `waitUntil` ahead of `now`). They wait on the person, so they count; a request no agent waits on stays asked
 * ahead. Read from the approvals payload the read already holds, compared at draw time (no timer, no call). */
export function blockedRequestIds(payload: string, now: number, canDecide: boolean): ReadonlySet<string> {
  if (!canDecide) return new Set();
  try {
    const parsed = JSON.parse(payload) as {
      requests?: { kind: string; laneId: string; needsOwner?: boolean; waitUntil?: number }[];
    };
    return new Set(
      (parsed.requests ?? [])
        .filter(
          r => r.kind === 'setting' && r.needsOwner && typeof r.waitUntil === 'number' && r.waitUntil > now,
        )
        .map(r => r.laneId),
    );
  } catch {
    return new Set();
  }
}

/** The approvals read stopped at its bound: a blocked request may be missing, so a count is a lower bound. */
export function approvalsTruncated(payload: string): boolean {
  try {
    return (JSON.parse(payload) as { complete?: boolean }).complete === false;
  } catch {
    return true;
  }
}

/** Lane ids with an open Lane approval request in the approvals payload. */
export function laneRequests(payload: string): ReadonlySet<string> {
  try {
    const parsed = JSON.parse(payload) as { requests?: { kind: string; laneId: string }[] };
    return new Set((parsed.requests ?? []).filter(r => r.kind === 'lane').map(r => r.laneId));
  } catch {
    return new Set();
  }
}

export function deployRequests(read: NeedsRead, now: number): Notice[] {
  return (read.deployStatus?.targets ?? []).flatMap(target => {
    const failure = target.failure;
    if (failure?.attentionAt === undefined || failure.attentionAt > now) return [];
    return [
      {
        kind: 'deploy',
        id: target.target,
        summary: `Find someone to look at the ${target.label} deploy in ${target.environment}.`,
        next: `It has been failing for at least ${failure.attentionMinutes} minutes.`,
      },
    ];
  });
}

/** The "Needs you" count: held Lanes that wait on a person, questions for the reader and Lanes parked for the
 * reader that show at `now`. Held or parked Lanes past the read's limit are not classified, so with any the count is
 * a lower bound. */
export function needsCount(
  read: NeedsRead | undefined,
  now = Date.now(),
): { n: number; atLeast: boolean } | undefined {
  if (!read) return undefined;
  const asked = laneRequests(read.approvals);
  const held = read.held.filter(lane =>
    waitsOnPerson(lane, asked.has(lane.laneId ?? ''), read.canDecide),
  ).length;
  const parked = (read.parked ?? []).filter(row => parkShown(row, now)).length;
  const asks = (read.asks ?? []).filter(row => !row.ahead && !row.recipientSession).length;
  const blocked = blockedRequestIds(read.approvals, now, read.canDecide).size;
  return {
    n:
      held +
      asks +
      parked +
      blocked +
      (read.notices?.filter(notice => notice.kind !== 'deploy').length ?? 0) +
      deployRequests(read, now).length +
      (read.secrets ?? 0),
    atLeast:
      read.more > 0 ||
      read.parkedMore === true ||
      read.asksMore === true ||
      read.noticesMore === true ||
      approvalsTruncated(read.approvals),
  };
}

/** The open Lanes that wait on the reader, by the rule above: held for a decision this reader makes, or parked for
 * them and shown now. Every screen that marks a held Lane (the top bar's line and F, the yard, the flow) takes it from
 * here, never its own rule, so they cannot disagree with the count (Item 9b9057a9). Undefined while the read is out. */
export type NeedsYou = { lanes: ReadonlySet<string>; known: 'all' | 'partial' | 'unknown' };
export function needsYouLanes(read: NeedsRead | undefined, now: number): NeedsYou | undefined {
  if (!read) return undefined;
  const asked = laneRequests(read.approvals);
  const out = new Set<string>();
  for (const lane of read.held) {
    if (!waitsOnPerson(lane, asked.has(lane.laneId ?? ''), read.canDecide)) continue;
    if (lane.laneId) out.add(lane.laneId);
    for (const id of lane.laneIds ?? []) out.add(id);
  }
  for (const row of read.parked ?? []) if (parkShown(row, now)) out.add(row.laneId);
  return { lanes: out, known: read.more > 0 || read.parkedMore === true ? 'partial' : 'all' };
}
/** Needs me's read failed: no held Lane is known to wait on the reader, and the page says it could not tell. */
export const NEEDS_UNKNOWN: NeedsYou = { lanes: new Set(), known: 'unknown' };
/** The Lanes known to wait on the reader, for a screen that marks held Lanes: only when every held Lane was
 * classified. Otherwise undefined, and the screen falls back to the line's own `fix` flag. */
export const waitingLanes = (needs: NeedsYou | undefined): ReadonlySet<string> | undefined =>
  needs?.known === 'all' ? needs.lanes : undefined;
