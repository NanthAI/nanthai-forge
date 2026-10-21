// SPDX-License-Identifier: Apache-2.0
import { alignRegions, type Region, type RegionSummary } from './agent-region-summary.js';
import type { ContractSource } from './contract-deps.js';
import type { PeersCache } from './agent-peers-cache.js';
import type { Lane } from './work-types.js';

export const REGION_ADJACENCY = 3;
export type PredictiveOverlap = {
  lane: string;
  intent?: string;
  head: string;
  file: string;
  risk: 'high' | 'low' | 'unknown';
  reason: 'regions' | 'export' | 'disjoint' | 'unavailable';
  mine: Region[] | null;
  peer: Region[] | null;
  /** Peer ranges in my base coordinates; original peer ranges remain above. */
  alignedPeer?: Region[];
  symbols?: string[];
  first: string;
  orderReason: 'ready' | 'smaller' | 'started-first';
  more?: number;
};

export function regionsNear(a: Region, b: Region, adjacency = REGION_ADJACENCY) {
  const end = (r: Region) => r.start + Math.max(1, r.lines) - 1;
  return a.start <= end(b) + adjacency && b.start <= end(a) + adjacency;
}

export function predictiveOverlaps(
  source: ContractSource,
  cache: PeersCache,
  lane: Lane,
  mine: RegionSummary,
  peer: Lane,
  theirs: RegionSummary,
): PredictiveOverlap[] {
  const ready = lane.state === 'ready',
    peerReady = peer.state === 'ready';
  const orderReason = ready !== peerReady ? 'ready' : mine.size !== theirs.size ? 'smaller' : 'started-first';
  const first =
    ready !== peerReady
      ? ready
        ? lane
        : peer
      : mine.size !== theirs.size
        ? mine.size < theirs.size
          ? lane
          : peer
        : `${lane.startedAt}:${lane.id}` < `${peer.startedAt}:${peer.id}`
          ? lane
          : peer;
  const otherFiles = new Map(theirs.files.map(file => [file.path, file]));
  return mine.files.flatMap(file => {
    const other = otherFiles.get(file.path);
    if (!other) return [];
    const aligned = alignRegions(source, cache, other, file);
    const symbols = mine.contracts
      .filter(
        change =>
          change.file === file.path &&
          theirs.contracts.some(item => item.file === change.file && item.export === change.export),
      )
      .map(change => change.export);
    const high =
      symbols.length > 0 ||
      file.structural ||
      other.structural ||
      !!file.regions?.some(a => aligned?.some(b => regionsNear(a, b)));
    const unknown = !file.regions || !aligned;
    const matchingMine = file.regions?.filter(a => aligned?.some(b => regionsNear(a, b))) ?? [];
    const matchingIndices =
      aligned?.flatMap((b, index) => (file.regions?.some(a => regionsNear(a, b)) ? [index] : [])) ?? [];
    const selected = high && matchingMine.length && !file.structural && !other.structural;
    return [
      {
        lane: peer.id,
        head: peer.head,
        file: file.path,
        risk: high ? ('high' as const) : unknown ? ('unknown' as const) : ('low' as const),
        reason: symbols.length
          ? ('export' as const)
          : high
            ? ('regions' as const)
            : unknown
              ? ('unavailable' as const)
              : ('disjoint' as const),
        mine: selected ? matchingMine : file.regions,
        peer: selected ? matchingIndices.map(index => other.regions![index]!) : other.regions,
        ...(file.before !== other.before && aligned
          ? {
              alignedPeer: selected ? matchingIndices.map(index => aligned[index]!) : aligned,
            }
          : {}),
        ...(symbols.length ? { symbols } : {}),
        first: first.id,
        orderReason,
      },
    ];
  });
}

const clean = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120);
const ranges = (value: Region[] | null) =>
  value?.length
    ? value
        .slice(0, 2)
        .map(r => (r.lines ? `${r.start}-${r.start + r.lines - 1}` : `before ${r.start}`))
        .join(',')
    : '?';
/** CLI advice goes to stderr, preserving the JSON-only stdout protocol. */
export function overlapLines(items: PredictiveOverlap[]) {
  return items
    .filter(item => item.risk === 'high')
    .slice(0, 3)
    .map(
      item =>
        `Overlap ${item.lane.slice(0, 8)}${item.intent ? ` (${clean(item.intent)})` : ''}: ${clean(item.file)} ${item.symbols?.length ? clean(item.symbols.slice(0, 2).join(',')) : `base ${ranges(item.mine)} / ${item.alignedPeer ? 'aligned peer' : 'peer base'} ${ranges(item.alignedPeer ?? item.peer)}`} — land ${item.first.slice(0, 8)} first (${item.orderReason}); sync after it lands.`,
    );
}
