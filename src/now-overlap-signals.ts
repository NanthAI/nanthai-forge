// SPDX-License-Identifier: Apache-2.0
import { digest } from './portable-hash.js';
import type { OverlapChange, OverlapLane, OverlapMain } from './hosted-overlap.js';

export type DetectedOverlap = { laneId: string; noticeId: string; file: string; lanes: string[] };
export type NowOverlapSignals = {
  notices: DetectedOverlap[];
  edits: { laneId: string; head: string; paths: string[] }[];
  behindMain: { laneId: string; head: string; paths: string[] }[];
  complete: boolean;
};
/** One bounded project window; current detections are never delivery receipts. */
export function nowOverlapSignals(
  lanes: readonly OverlapLane[],
  main: OverlapMain | null,
  current: { head: string; sourceRevision: number } | null,
  complete: boolean,
): NowOverlapSignals {
  const result: NowOverlapSignals = { notices: [], edits: [], behindMain: [], complete };
  const byPath = new Map<string, OverlapLane[]>();
  const touched = new Map<string, number>(main ? JSON.parse(main.changes) : []);
  let bytes = 0;
  for (const lane of lanes) {
    if (!lane.open) continue;
    const paths = (JSON.parse(lane.changes) as OverlapChange[]).map(change => change.path);
    bytes += new TextEncoder().encode(JSON.stringify(paths)).length;
    if (bytes > 128 * 1024) {
      result.complete = false;
      break;
    }
    result.complete &&= lane.complete;
    result.edits.push({ laneId: lane.laneId, head: lane.head, paths });
    for (const path of paths) {
      const peers = byPath.get(path) ?? [];
      peers.push(lane);
      byPath.set(path, peers);
    }
    const known =
      lane.baseSequence !== null &&
      main &&
      current &&
      main.sequence === current.sourceRevision &&
      lane.baseSequence >= main.coverageAfter;
    if (current?.head !== lane.baseHead && !known) result.complete = false;
    if (known)
      result.behindMain.push({
        laneId: lane.laneId,
        head: lane.head,
        paths: paths.filter(path => (touched.get(path) ?? -1) > lane.baseSequence!),
      });
  }
  const counts = new Map<string, number>();
  for (const [file, peers] of byPath) {
    for (let i = 0; i < peers.length; i++)
      for (let j = i + 1; j < peers.length; j++) {
        const lanes = [peers[i]!.laneId, peers[j]!.laneId].sort();
        if (lanes.every(laneId => (counts.get(laneId) ?? 0) >= 20)) {
          result.complete = false;
          continue;
        }
        const noticeId = digest(JSON.stringify(['first-write', lanes, file]));
        for (const laneId of lanes) {
          const count = counts.get(laneId) ?? 0;
          if (count === 20) {
            result.complete = false;
            continue;
          }
          result.notices.push({ laneId, noticeId, file, lanes });
          counts.set(laneId, count + 1);
        }
      }
  }
  return result;
}
