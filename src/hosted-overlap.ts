// SPDX-License-Identifier: Apache-2.0
import { classifyOverlap, type OverlapEvidence, type OverlapClass } from './hosted-overlap-evidence.js';
import { digest } from './portable-hash.js';

export const OVERLAP_METADATA_BYTES = 128 * 1024;
export type OverlapFile = { blob: string; mode: string } | null;
export type OverlapChange = {
  path: string;
  before: OverlapFile;
  after: OverlapFile;
  evidence?: OverlapEvidence;
};
export type OverlapLane = {
  laneId: string;
  intentId: string;
  intent: string;
  actor: string;
  head: string;
  baseHead: string;
  baseSequence: number | null;
  open: boolean;
  changes: string;
  complete: boolean;
};
export type OverlapMain = {
  sequence: number;
  coverageAfter: number;
  changes: string;
};
const same = (a: OverlapFile, b: OverlapFile) =>
  a === null || b === null ? a === b : a.blob === b.blob && a.mode === b.mode;

/** A display projection budget, never a source/save limit. Missing coverage is explicit. */
export function boundOverlapChanges(changes: OverlapChange[], complete = true) {
  const selected: OverlapChange[] = [];
  let bytes = 2;
  for (const change of changes) {
    const value = {
      path: change.path,
      ...(change.evidence ? { evidence: change.evidence } : {}),
      before: change.before && { blob: change.before.blob, mode: change.before.mode },
      after: change.after && { blob: change.after.blob, mode: change.after.mode },
    };
    const size = new TextEncoder().encode(JSON.stringify(value)).length + 1;
    if (bytes + size > OVERLAP_METADATA_BYTES) {
      complete = false;
      continue;
    }
    selected.push(value);
    bytes += size;
  }
  return { changes: JSON.stringify(selected), complete };
}

/** Keep the first baseline bytes so edits reverted to the base stop overlapping. */
export function mergeOverlapChanges(previous: OverlapChange[], delta: OverlapChange[], complete = true) {
  const paths = new Map(previous.map(change => [change.path, change]));
  for (const change of delta) {
    const before = paths.get(change.path)?.before ?? change.before;
    // A missing baseline file is significant; do not replace null via ??.
    const original = paths.has(change.path) ? paths.get(change.path)!.before : before;
    if (same(original, change.after)) paths.delete(change.path);
    else paths.set(change.path, { ...change, before: original });
  }
  return boundOverlapChanges(
    [...paths.values()].sort((a, b) => a.path.localeCompare(b.path)),
    complete,
  );
}

/** Latest main touch per path replaces a walk through acceptance history. */
export function advanceOverlapMain(
  previous: OverlapMain | null,
  sequence: number,
  paths: string[] | null,
): OverlapMain {
  const changes = new Map<string, number>(previous ? JSON.parse(previous.changes) : []);
  let coverageAfter = previous?.coverageAfter ?? sequence - 1;
  if (paths === null) coverageAfter = sequence;
  for (const path of paths ?? []) changes.set(path, sequence);
  const ordered = [...changes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const selected: [string, number][] = [];
  let bytes = 2;
  for (const entry of ordered) {
    const size = new TextEncoder().encode(JSON.stringify(entry)).length + 1;
    if (bytes + size > OVERLAP_METADATA_BYTES) {
      coverageAfter = Math.max(coverageAfter, entry[1]);
      continue;
    }
    selected.push(entry);
    bytes += size;
  }
  return { sequence, coverageAfter, changes: JSON.stringify(selected) };
}

/** Saved range/symbol advice. Actual text conflicts are still decided by composition. */
export function hostedOverlapAdvice(
  mine: OverlapLane,
  peers: OverlapLane[],
  main: OverlapMain | null,
  current: { head: string; sourceRevision: number },
  answered: Set<string>,
  complete = true,
  maxItems = 5,
) {
  const mineChanges = new Map(
    (JSON.parse(mine.changes) as OverlapChange[]).map(change => [change.path, change]),
  );
  const paths = new Set(mineChanges.keys());
  complete &&= mine.complete;
  const items: {
    noticeId: string;
    class: OverlapClass;
    reason: string;
    file: string;
    lanes: string[];
    text: string;
    participants: { lane: string; actor: string; intent: string }[];
  }[] = [];
  let count = 0,
    blockingCount = 0,
    advisoryCount = 0;
  for (const peer of peers) {
    if (!peer.open || peer.laneId === mine.laneId) continue;
    complete &&= peer.complete;
    const lanes = [mine.laneId, peer.laneId].sort();
    for (const change of JSON.parse(peer.changes) as OverlapChange[]) {
      const { path } = change,
        mineChange = mineChanges.get(path);
      if (!mineChange) continue;
      const classification = classifyOverlap(mineChange, change);
      const priority = classification.class === 'blocking';
      // Without answers there is no need to hash every omitted display item.
      const noticeId =
        answered.size ||
        items.length < maxItems ||
        (priority && items.some(item => item.class === 'advisory'))
          ? digest(JSON.stringify([priority ? 'first-write' : 'first-write-advisory', lanes, path]))
          : '';
      if (answered.has(noticeId)) continue;
      count++;
      if (priority) blockingCount++;
      else advisoryCount++;
      if (items.length === maxItems && (!priority || items.every(item => item.class === 'blocking')))
        continue;
      const item = {
        noticeId,
        ...classification,
        file: path,
        lanes,
        participants: [mine, peer].map(lane => ({
          lane: lane.laneId,
          actor: lane.actor,
          intent: lane.intent,
        })),
        text: `${classification.class} overlap: ${path}; Lane ${peer.laneId} (${peer.intent.slice(0, 160)}); ${classification.reason}.`.slice(
          0,
          400,
        ),
      };
      if (priority) items.splice(items.findIndex(item => item.class === 'advisory') >>> 0, 0, item);
      else items.push(item);
      if (items.length > maxItems) items.pop();
    }
  }
  const knownBase = mine.baseSequence !== null;
  const behind = knownBase ? Math.max(0, current.sourceRevision - mine.baseSequence!) : null;
  const mainComplete =
    current.head === mine.baseHead ||
    (knownBase &&
      main !== null &&
      main.sequence === current.sourceRevision &&
      mine.baseSequence! >= main.coverageAfter);
  const conflicts =
    main && knownBase && current.head !== mine.baseHead
      ? (JSON.parse(main.changes) as [string, number][])
          .filter(([path, sequence]) => sequence > mine.baseSequence! && paths.has(path))
          .map(([path]) => path)
          .sort()
      : [];
  return {
    unacknowledgedOverlaps: {
      laneId: mine.laneId,
      head: mine.head,
      count,
      blockingCount,
      advisoryCount,
      items,
      coverage: complete ? 'hosted' : 'hosted-incomplete',
    },
    behindMain: {
      head: current.head,
      baseHead: mine.baseHead,
      baseSequence: mine.baseSequence,
      commits: behind,
      conflictingPaths: conflicts.slice(0, 10),
      more: Math.max(0, conflicts.length - 10),
      coverage: mainComplete && mine.complete ? 'hosted' : 'hosted-incomplete',
    },
  };
}
