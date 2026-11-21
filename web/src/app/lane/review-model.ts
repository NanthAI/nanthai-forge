// SPDX-License-Identifier: Apache-2.0
// The Lane review reply (convex/projectLaneReview.ts) and what the screen derives from it, with no reads: each file's
// group and observed reason (src/review-order.ts, shared with the agent's diff summary), the crossing lines from the
// Lane's open conflict notices, and the stop the Lane is at.
import { documentationPath } from '../../../../src/prose-paths';
import { reviewEntry, type ReviewEntry, type ReviewFacts } from '../../../../src/review-order';
import type { LineFeed, LineStage } from '../Line';
import type { Park } from '../needs/count';
import { uniqueBy } from '../../ui/unique';

export type Side = { blob: string; mode: string } | null;
export type ReviewFile = {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  before: Side;
  after: Side;
  /** Lines added and removed, recorded once at save (Item c2388099); absent on older saves. */
  lines?: [number, number];
  protected?: true;
};
export type Peer = {
  laneId: string;
  actor: string | null;
  agent: string | null;
  goal: string | null;
  head?: string;
  baseHead?: string;
  complete?: boolean;
  landed?: unknown;
  files?: { path: string; before: Side; after: Side }[];
};
export type Conflict = {
  with: string;
  goal?: string;
  flaggedAt: string;
  files: { path: string; mine: [number, number][]; theirs: [number, number][]; reason?: string }[];
  earlyResolution?: { predecessor?: { submissionId: string; head: string; receiptId: string } };
};
export type EarlyResolution = {
  predecessor: { submissionId: string; head: string; receiptId: string };
  laneId: string;
  originalHead: string;
  startedAt: string;
  resolvedAt?: string;
};
export type Reply = {
  lane: {
    laneId: string;
    intentId: string;
    goal: string | null;
    actor: string | null;
    agent: string | null;
    agentAuthored?: boolean;
    agentClient?: string;
    state: 'active' | 'completed' | 'abandoned';
    head: string;
    base: { head: string };
    landed: {
      receiptId: string;
      commit: string;
      at: string;
      revertedBy?: { receiptId: string; at: string };
      /** Seconds from "land" to on main and at each stop; null when not recorded (convex/projectLaneTiming.ts). */
      timing?: {
        toMain: number | null;
        queue: number | null;
        check: number | null;
        land: number | null;
      } | null;
    } | null;
    earlyResolution?: EarlyResolution;
    ahead?: string | null;
    /** Parked (Item e1633718): who it waits on (a handle, `handle/run`, or none named), why and since when. */
    park?: Park;
    resolution?: { status: string; origin: string | null };
  };
  supervised: boolean;
  protectedRules: number;
  files: {
    current: boolean;
    complete: boolean;
    total: number;
    offset: number;
    nextOffset: number | null;
    items: ReviewFile[];
  };
  conflicts: Conflict[];
  peers: Peer[];
};

/** A Lane as a person reads it: its public handle, with the agent's word slug when it has one. */
export const handleOf = (who: { actor: string | null; agent: string | null }, fallback: string) =>
  who.actor ? (who.agent ? `${who.actor}/${who.agent}` : who.actor) : fallback;

export const span = ([from, to]: [number, number]) => (from === to ? `${from}` : `${from}-${to}`);

export type Entry = ReviewEntry & { file: ReviewFile };

/** Every listed file with its group and reason. Crossing lines come from the open conflict notices only. */
export function entriesOf(reply: Reply, files: readonly ReviewFile[]): Entry[] {
  const label = new Map(reply.peers.map(peer => [peer.laneId, handleOf(peer, peer.laneId.slice(0, 8))]));
  const crossing = new Map<string, { with: string; lines: string }[]>();
  for (const conflict of reply.conflicts)
    for (const file of conflict.files) {
      const list = crossing.get(file.path) ?? [];
      list.push({
        with: conflict.with === 'main' ? 'main' : (label.get(conflict.with) ?? conflict.with.slice(0, 8)),
        lines: file.mine.map(span).join(', ') || 'whole file',
      });
      crossing.set(file.path, list);
    }
  // Files are read in pages at offsets, so a save made between two reads can send one path twice; it lists once
  // (f9309eec). The caller's next offset still counts every row it read.
  return uniqueBy(files, file => file.path).map(file => {
    const facts: ReviewFacts = {
      path: file.path,
      doc: documentationPath(file.path),
      status: file.status,
      before: file.before?.mode ?? null,
      after: file.after?.mode ?? null,
      ...(file.protected ? { protected: true } : {}),
      ...(crossing.has(file.path) ? { crossing: crossing.get(file.path)! } : {}),
    };
    return { ...reviewEntry(facts), file };
  });
}

export const STOPS: readonly { stage: LineStage | 'main'; label: string }[] = [
  { stage: 'editing', label: 'Editing' },
  { stage: 'saved', label: 'Saved' },
  { stage: 'queued', label: 'In queue' },
  { stage: 'checking', label: 'Checking' },
  { stage: 'ready', label: 'Ready to land' },
  { stage: 'main', label: 'main' },
];

/** The stop this Lane is at: the live line's own stage when the feed carries it, else what the record says. */
export function laneStop(reply: Reply, feed: LineFeed | undefined) {
  const live = feed?.lanes.find(lane => lane.laneId === reply.lane.laneId);
  if (reply.lane.landed) return { stage: 'main' as const, held: false, overlap: false };
  if (live) return { stage: live.stage, held: live.held, overlap: live.overlap };
  if (reply.lane.state !== 'active') return null;
  return {
    stage: reply.lane.head === reply.lane.base.head ? 'editing' : 'saved',
    held: false,
    overlap: false,
  } as const;
}
