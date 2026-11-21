// SPDX-License-Identifier: Apache-2.0
// The one rule for what waits on a person (Items 12fde646, 48049998), shared by the shell's "Needs you" count and the
// Needs me page so the two never disagree. A held Lane waits on a person only when that person has an action: an
// approval Forge enforces, or a person's own Lane that is stuck (choose an order, retry, update, set aside). An agent's
// conflict, failed check or moved main is its agent's next step; a refusal, a withdrawn landing and a Lane waiting
// for the one it depends on ask nobody. Those go to FYI. A question with choices addressed to the reader waits on
// the reader, and so does a Lane parked for the reader (Item e1633718). Pure and small: the frame imports it eagerly.
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
  laneId: string;
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
};
export type NeedsRead = {
  held: readonly HeldLane[];
  more: number;
  moreIsLowerBound: boolean;
  approvals: string;
  canDecide: boolean;
  asks?: readonly Ask[];
  parked?: readonly ParkedLane[];
  parkedMore?: boolean;
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

/** Lane ids with an open Lane approval request in the approvals payload. */
export function laneRequests(payload: string): ReadonlySet<string> {
  try {
    const parsed = JSON.parse(payload) as { requests?: { kind: string; laneId: string }[] };
    return new Set((parsed.requests ?? []).filter(r => r.kind === 'lane').map(r => r.laneId));
  } catch {
    return new Set();
  }
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
  const held = read.held.filter(lane => waitsOnPerson(lane, asked.has(lane.laneId), read.canDecide)).length;
  const parked = (read.parked ?? []).filter(row => parkShown(row, now)).length;
  return { n: held + (read.asks?.length ?? 0) + parked, atLeast: read.more > 0 || read.parkedMore === true };
}
