// SPDX-License-Identifier: Apache-2.0
'use node';
import type { Id } from './_generated/dataModel';
import type { ExchangeObjectReader } from './projectExchangeReader';
import type { WorkData } from '../src/work-types';
import { parseNativeState } from '../src/native-source';
import { reviewPaths } from '../src/native-source-review';
import { COORDINATION_LIMITS } from '../src/coordination-types';

const MAX_LANES = 20,
  PATH_DIFF_LANES = 4;
type Manifest = { files: { path: string; sha256: string; size: number }[] };
export type ReturnChange = {
  intentId: string;
  laneId: string;
  head: string;
  paths?: string[];
  pathCount?: number;
};

/**
 * Lanes whose head moved since hosted Work last saw them, with changed paths for the first few
 * native Lanes. Advisory: any failure to read States only omits paths (unknown), never the return.
 */
export async function returnChanges(
  reader: ExchangeObjectReader,
  projectId: Id<'hostedProjects'>,
  owner: string,
  before: WorkData,
  after: WorkData,
  manifest: Manifest,
): Promise<ReturnChange[]> {
  const previous = new Map(before.lanes.map(lane => [lane.id, lane.head]));
  const sizes = new Map(
    manifest.files
      .filter(file => file.path === `objects/${file.sha256}`)
      .map(file => [file.sha256, file.size]),
  );
  const moved = after.lanes.filter(lane => previous.get(lane.id) !== lane.head).slice(0, MAX_LANES);
  const changes: ReturnChange[] = [];
  for (const [index, lane] of moved.entries()) {
    const change: ReturnChange = { intentId: lane.intentId, laneId: lane.id, head: lane.head };
    const from = previous.get(lane.id) ?? lane.base,
      a = sizes.get(from),
      b = sizes.get(lane.head);
    if (index < PATH_DIFF_LANES && a !== undefined && b !== undefined)
      try {
        const [old, next] = await reader.read(projectId, owner, [
          { sha256: from, size: a },
          { sha256: lane.head, size: b },
        ]);
        const paths = reviewPaths(parseNativeState(old!).files, parseNativeState(next!).files)
          .filter(item => item.status !== 'unchanged')
          .map(item => item.path);
        change.paths = paths.slice(0, COORDINATION_LIMITS.changePaths);
        change.pathCount = paths.length;
      } catch {
        // Paths stay unknown; the Lane, Intent and head are still reported.
      }
    changes.push(change);
  }
  return changes;
}
