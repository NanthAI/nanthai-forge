// SPDX-License-Identifier: Apache-2.0
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { z } from 'zod';
import { clientCacheRoot } from './root-paths.js';
import { hostedRootLanePath, openHostedRootLane } from './hosted-root-checkout.js';
import { rebaseHostedCheckout } from './hosted-save-rebase.js';
import { markerAt } from './hosted-apply-recovery-records.js';
import { forgetLane, readLaneEntry } from './lane-registry.js';
import { pendingConflictPaths } from './hosted-conflict-precheck.js';
import type { syncResultSchema } from './hosted-sync.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';
import type { HostedLaneSelection } from './hosted-lane.js';

/** Where the agent resolves. The conflict was made from this folder's own saved Lane head:
 * the folder itself becomes the resolution Lane (its marker and conflict record name it and
 * the origin), keeping unsaved edits and every path, wait and handoff the agent already has.
 * Otherwise the whole tree opens as a sibling folder, never nested. One line says which. */
export async function placeResolution(
  session: HostedAgentSession,
  source: z.infer<typeof syncResultSchema>,
  /** The caller's fresh read of the resolution Lane, reused by an in-place rebase. */
  selection?: HostedLaneSelection,
) {
  const laneId = source.lane.laneId,
    origin = source.resolution?.origin,
    marker = markerAt(session.root);
  const ours =
    marker?.url === session.address.url && marker.selection.projectId === session.address.projectId;
  if (ours && marker.selection.laneId === laneId) {
    // A rerun after the folder already became the resolution (a crash before the reply): the copies
    // set aside earlier are still named, from the folder itself.
    const kept = keptCopies(session.root, laneId);
    return {
      root: session.root,
      inPlace: true,
      ...(kept ? { kept } : {}),
      workIn: workInLine(session.root, laneId, true, kept, undefined, origin?.head),
    };
  }
  // A folder still holding an unresolved draft keeps it: a second, explicit draft opens beside.
  const draftHere = ours && pendingConflictPaths(session.root, marker.selection.laneId).length > 0;
  if (
    ours &&
    !draftHere &&
    origin &&
    marker.selection.laneId === origin.laneId &&
    marker.selection.head === origin.head &&
    marker.selection.sourceVersion === origin.sourceVersion
  ) {
    const rebased = await rebaseHostedCheckout(session.root, session.exchange, { laneId, origin }, selection);
    // The folder now belongs to the resolution; the original Lane keeps no local root of its own.
    if (readLaneEntry(origin.laneId)?.root === session.root) forgetLane(origin.laneId);
    // The set-aside copies as the folder holds them (an earlier crashed run's too), not only this run's.
    const kept = keptCopies(session.root, laneId);
    const restored = rebased?.deletedLocally?.length ? rebased.deletedLocally : undefined;
    return {
      root: session.root,
      inPlace: true,
      origin: origin.laneId,
      kept,
      ...(restored ? { restored } : {}),
      workIn: workInLine(session.root, laneId, true, kept, undefined, origin.head, restored),
    };
  }
  // The whole tree, beside the original Lane: the agent reads the helpers a hunk
  // uses and runs checks there, as in any Lane (objects come from the shared cache).
  const opened = await openHostedRootLane(
    session.root,
    session.address,
    session.exchange,
    {
      operationId: await session.journal.id('conflict-checkout'),
      laneId,
      expected: {
        head: source.lane.head,
        version: source.lane.version,
        sourceVersion: source.lane.sourceVersion,
      },
    },
    hostedRootLanePath(session.root, session.address, laneId),
  );
  const why = !marker
    ? 'this folder is not a Lane checkout'
    : draftHere
      ? 'this folder holds another unresolved draft'
      : marker.selection.laneId === origin?.laneId
        ? 'this folder was saved again after the conflict, so its newer work stays here'
        : 'this folder holds another Lane';
  return {
    root: opened.root,
    inPlace: false,
    workIn: workInLine(opened.root, laneId, false, undefined, why),
  };
}
function workInLine(
  root: string,
  laneId: string,
  inPlace: boolean,
  kept?: { paths: string[]; at: string },
  why?: string,
  /** The saved Lane head the conflict was made from; says what the sync merged (ad80e037). */
  savedHead?: string,
  /** Unsaved deletions the merge changed: the file is back with the merged bytes. */
  restored?: string[],
) {
  const list = (paths: string[]) =>
    `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` and ${paths.length - 3} more` : ''}`;
  const savedNote = savedHead
    ? ` Saved: the Lane's saved head ${savedHead.slice(0, 12)} is what main was merged into; sync saves nothing new.`
    : '';
  const keptNote = kept
    ? ` NOT saved: unsaved edits to ${list(kept.paths)} also changed on main; copies are in ${kept.at}. Merge each back into the same path before resolve.`
    : '';
  const restoredNote = restored?.length
    ? ` Restored: the unsaved deletion of ${list(restored)} was undone (main changed the file); delete it again if you still want it gone.`
    : '';
  const restNote = savedHead || kept ? ' Other unsaved edits stay in place, still unsaved.' : '';
  return inPlace
    ? `WORK IN ${root} (same folder): it is now resolution Lane ${laneId}; resolve and land from here.${savedNote}${keptNote}${restoredNote}${restNote}`
    : `WORK IN ${root} (new folder for resolution Lane ${laneId}): ${why}.`;
}
/** Copies of unsaved edits an in-place resolution set aside for this Lane, read from the folder that
 * holds them (rebaseHostedCheckout's keptAt), at most 100 paths. Undefined when there are none. */
export function keptCopies(root: string, laneId: string) {
  const at = join(clientCacheRoot(root), 'resolution-kept', laneId);
  let entries;
  try {
    entries = readdirSync(at, { recursive: true, withFileTypes: true });
  } catch {
    return undefined;
  }
  const paths = entries
    .filter(entry => !entry.isDirectory())
    .map(entry => relative(at, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .sort()
    .slice(0, 100);
  return paths.length ? { paths, at } : undefined;
}
