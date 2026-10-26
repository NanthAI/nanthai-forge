// SPDX-License-Identifier: Apache-2.0
'use node';
import type { Id } from './_generated/dataModel';
import type { ExchangeObjectReader } from './projectExchangeReader';
import type { WorkData } from '../src/work-types';
import type { OwnerDerived } from '../src/owner-derived';
import { COORDINATION_LIMITS } from '../src/coordination-types';
import { invariant } from '../src/errors';
import { safeRelative } from '../src/files';
export type ReturnChange = {
  intentId: string;
  laneId: string;
  head: string;
  paths?: string[];
  pathCount?: number;
};
/** Coordination display paths are owner supplied, never read from source objects. */
export async function returnChanges(
  _reader: ExchangeObjectReader,
  _projectId: Id<'hostedProjects'>,
  _owner: string,
  before: { lanes: { id: string; head: string }[] },
  after: WorkData,
  _manifest: { kind?: string; files: { path: string; sha256: string; size: number }[] },
  metadata?: OwnerDerived,
): Promise<ReturnChange[]> {
  const previous = new Map(before.lanes.map(lane => [lane.id, lane.head]));
  return after.lanes
    .filter(l => previous.get(l.id) !== l.head)
    .slice(0, 20)
    .map((lane, index) => {
      const change: ReturnChange = { intentId: lane.intentId, laneId: lane.id, head: lane.head };
      if (index >= 4 || _manifest.kind === 'forge-source-and-work') return change;
      const supplied = metadata?.changes.find(
        row =>
          row.laneId === lane.id &&
          row.from === (previous.get(lane.id) ?? lane.base) &&
          row.head === lane.head,
      );
      invariant(
        supplied &&
          supplied.paths.length <= COORDINATION_LIMITS.changePaths &&
          supplied.pathCount >= supplied.paths.length &&
          supplied.paths.every(safeRelative),
        'INVALID_OWNER_DATA',
        'Owner coordination paths are missing or invalid. Prepare them locally with nforge.',
      );
      return { ...change, paths: supplied.paths, pathCount: supplied.pathCount };
    });
}
