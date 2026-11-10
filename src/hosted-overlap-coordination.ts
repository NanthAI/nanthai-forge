// SPDX-License-Identifier: Apache-2.0
// Coordination before the queue (Issue 1eb42254, D2). Pure: Convex (V8) and the CLI both import it.
// Everything here rides on the overlap read that start, save, sync and the first-write hook already
// make: no added call, and no read at all for a Lane whose items name no peer.
import { digest } from './state/hash.js';

/** A file or directory saved by this many open Lanes (the caller's included) is hot. */
export const HOT_FILE_LANES = 3;
/** Hot-file items per overlap read, most-shared first; the rest are counted, not listed. */
export const HOT_FILE_ITEMS = 2;
/** Declared scope entries one start may send; each at most this many characters. */
export const SCOPE_PATHS = 50;
export const SCOPE_PATH_CHARS = 300;
/** Peers whose landing phase one overlap read looks up (each a bounded indexed lookup). */
export const PEER_PHASE_READS = 3;
/** Project setting (agentDefaults.stacking): how a Lane that collides with an admitted peer stacks. */
export type StackingMode = 'offer' | 'auto';

/** A declared scope entry matches a file: exact path, or every file below an entry ending in `/`. */
export const inScope = (scope: readonly string[], path: string) =>
  scope.some(entry => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));

/** Paths several open Lanes saved. `lanes` maps each path the caller cares about to the peers that
 * saved it (the caller is not in the set). Ranked by Lane count, then path. */
export function hotFiles(laneId: string, lanes: Map<string, Set<string>>) {
  const hot = [...lanes]
    .filter(([, peers]) => peers.size + 1 >= HOT_FILE_LANES)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .map(([path, peers]) => ({
      noticeId: digest(JSON.stringify(['hot-file', laneId, path])),
      path,
      peers: [...peers].sort(),
    }));
  return {
    count: hot.length,
    items: hot.slice(0, HOT_FILE_ITEMS).map(entry => ({
      noticeId: entry.noticeId,
      class: 'advisory' as const,
      reason: 'hot-file',
      file: entry.path,
      lanes: entry.peers.slice(0, 5),
      participants: [] as { lane: string; actor: string; intent: string }[],
      text: hotFileText(entry.path, entry.peers),
    })),
  };
}

export const hotFileText = (path: string, peers: string[]) =>
  `advisory: ${path} is in ${peers.length + 1} open Lanes (yours and ${peers
    .slice(0, 3)
    .map(id => id.slice(0, 8))
    .join(', ')}${peers.length > 3 ? ', ...' : ''}); consider a per-Issue file or landing it first.`.slice(
    0,
    400,
  );

export type PeerLanding = {
  submissionId: string;
  phase: 'composing' | 'queued' | 'checking' | 'ready';
  /** Approximate minutes until it lands, from the queue's recent service time; null when unknown. */
  etaMinutes: number | null;
};

/** The stack-on-pending-head offer: a Lane colliding with an admitted peer (check passed, so it
 * very likely lands) can build on the peer's head now instead of repairing a conflict later.
 * Only for an open, unstacked Lane that is not itself landing; the first admitted peer wins. */
export function stackOffer(input: {
  laneId: string;
  stacked: boolean;
  landing: boolean;
  mode: StackingMode;
  peers: { laneId: string; landing: PeerLanding | null }[];
}) {
  if (input.stacked || input.landing) return null;
  const peer = input.peers.find(entry => entry.landing?.phase === 'ready');
  if (!peer) return null;
  const body = JSON.stringify({ laneId: input.laneId, stackOn: peer.laneId });
  return {
    peerLaneId: peer.laneId,
    submissionId: peer.landing!.submissionId,
    mode: input.mode,
    command: `nforge agent . sync '${body}'`,
    text:
      input.mode === 'auto'
        ? `Lane ${peer.laneId.slice(0, 8)} touches your files and is admitted; your next sync stacks this Lane on its pending head (project setting stacking:auto). If it fails, your next land re-pins to main and checks once.`
        : `Lane ${peer.laneId.slice(0, 8)} touches your files and is admitted: build on its pending head now instead of repairing a conflict later. If it fails, your next land re-pins to main and checks once.`,
  };
}
