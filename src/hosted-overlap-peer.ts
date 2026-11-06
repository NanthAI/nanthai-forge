// SPDX-License-Identifier: Apache-2.0
// Pure: runs in the Convex non-Node runtime and in test fixtures.
import type { OverlapChange, OverlapLane } from './hosted-overlap.js';
import { symbolFacts } from './hosted-overlap-symbol-notes.js';

/** What an overlap row holds before its large `changes` evidence is dropped. */
export type OverlapPeerSource<P = string, L = string> = {
  projectId: P;
  laneId: string;
  intentId: string;
  actor: string;
  agent?: string;
  intent: string;
  head: string;
  baseHead: string;
  resolutionLeft?: string;
  recordVersion: number;
  lifecyclePlanId?: L;
  open: boolean;
  superseded?: { laneHead: string };
  complete: boolean;
  lastActivityAt?: number;
  presenceRow?: { at: number };
  changes: string;
};

/** 32-bit FNV-1a of a path as 8 hex digits. A fingerprint match only says "may share this path" and
 * sends the read to the full row; a mismatch is exact. */
export function pathHash(path: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Whether a peer's fingerprints (8 hex digits per saved path) may hold one of these paths' hashes. */
export function mayShareOverlapPath(pathHashes: string, wanted: ReadonlySet<string>) {
  for (let at = 0; at < pathHashes.length; at += 8) if (wanted.has(pathHashes.slice(at, at + 8))) return true;
  return false;
}

/** The slim peer row of one overlap row (Issue 5471e31c): everything `hostedOverlapAdvice` reads of a
 * peer except the per-path evidence, plus saved-path fingerprints and cross-file symbol facts. A pure function
 * of the overlap row, written in the same transaction as every write of that row, so the two never
 * differ. A peer read then loads the full row only for peers that share a path with the caller. */
export function overlapPeerOf<P, L>(row: OverlapPeerSource<P, L>) {
  const changes = JSON.parse(row.changes) as OverlapChange[];
  const facts = symbolFacts(changes);
  return {
    projectId: row.projectId,
    laneId: row.laneId,
    intentId: row.intentId,
    actor: row.actor,
    ...(row.agent ? { agent: row.agent } : {}),
    intent: row.intent,
    head: row.head,
    baseHead: row.baseHead,
    ...(row.resolutionLeft !== undefined ? { resolutionLeft: row.resolutionLeft } : {}),
    recordVersion: row.recordVersion,
    ...(row.lifecyclePlanId ? { lifecyclePlanId: row.lifecyclePlanId } : {}),
    open: row.open,
    ...(row.superseded ? { supersededHead: row.superseded.laneHead } : {}),
    complete: row.complete,
    ...(row.lastActivityAt !== undefined ? { lastActivityAt: row.lastActivityAt } : {}),
    ...(row.presenceRow ? { presenceAt: row.presenceRow.at } : {}),
    pathHashes: changes.map(change => pathHash(change.path)).join(''),
    ...(facts.exports.size ? { exports: [...facts.exports] } : {}),
    ...(facts.refs.length ? { refs: facts.refs.map(ref => [...ref]) } : {}),
  };
}

/** A peer as `hostedOverlapAdvice` reads it. `changes` is empty until the full evidence is attached. */
export function overlapPeerLane<L>(
  row: Omit<ReturnType<typeof overlapPeerOf<unknown, L>>, 'projectId'>,
): OverlapLane & { recordVersion: number; lifecyclePlanId?: L; pathHashes: string } {
  return {
    laneId: row.laneId,
    intentId: row.intentId,
    intent: row.intent,
    actor: row.actor,
    ...(row.agent ? { agent: row.agent } : {}),
    head: row.head,
    baseHead: row.baseHead,
    baseSequence: null,
    open: row.open,
    ...(row.resolutionLeft !== undefined ? { resolutionLeft: row.resolutionLeft } : {}),
    changes: '[]',
    complete: row.complete,
    ...(row.lastActivityAt !== undefined ? { lastActivityAt: row.lastActivityAt } : {}),
    ...(row.presenceAt !== undefined ? { presenceRow: { at: row.presenceAt } } : {}),
    ...(row.supersededHead !== undefined ? { superseded: { laneHead: row.supersededHead } } : {}),
    recordVersion: row.recordVersion,
    ...(row.lifecyclePlanId ? { lifecyclePlanId: row.lifecyclePlanId } : {}),
    pathHashes: row.pathHashes,
    symbolFacts: {
      exports: new Set(row.exports ?? []),
      refs: (row.refs ?? []).map(ref => [ref[0]!, ref[1]!] as [string, string]),
    },
  };
}
