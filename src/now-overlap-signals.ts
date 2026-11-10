// SPDX-License-Identifier: Apache-2.0
import type { OverlapChange, OverlapLane, OverlapMain } from './hosted-overlap.js';

export type NowOverlapSignals = {
  edits: { laneId: string; head: string; paths: string[] }[];
  /** `more`: paths left out of a capped view (src/now-overlap-view.ts). */
  behindMain: { laneId: string; head: string; paths: string[]; more?: number }[];
  complete: boolean;
};
/** One bounded project window: each open Lane's saved paths and the paths main changed since its base. */
export function nowOverlapSignals(
  lanes: readonly OverlapLane[],
  main: OverlapMain | null,
  current: { head: string; sourceRevision: number } | null,
  complete: boolean,
): NowOverlapSignals {
  const result: NowOverlapSignals = { edits: [], behindMain: [], complete };
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
  return result;
}
