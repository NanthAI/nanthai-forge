// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import { hostedRootLanePath, openHostedRootLane } from './hosted-root-checkout.js';
import { rebaseHostedCheckout } from './hosted-save-rebase.js';
import { markerAt } from './hosted-apply-recovery-records.js';
import { forgetLane, readLaneEntry } from './lane-registry.js';
import { pendingConflictPaths } from './hosted-conflict-precheck.js';
import type { syncResultSchema } from './hosted-sync.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';

/** Where the agent resolves. The conflict was made from this folder's own saved Lane head:
 * the folder itself becomes the resolution Lane (its marker and conflict record name it and
 * the origin), keeping unsaved edits and every path, wait and handoff the agent already has.
 * Otherwise the whole tree opens as a sibling folder, never nested. One line says which. */
export async function placeResolution(session: HostedAgentSession, source: z.infer<typeof syncResultSchema>) {
  const laneId = source.lane.laneId,
    origin = source.resolution?.origin,
    marker = markerAt(session.root);
  const ours =
    marker?.url === session.address.url && marker.selection.projectId === session.address.projectId;
  if (ours && marker.selection.laneId === laneId)
    return { root: session.root, inPlace: true, workIn: workInLine(session.root, laneId, true) };
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
    const rebased = await rebaseHostedCheckout(session.root, session.exchange, { laneId, origin });
    // The folder now belongs to the resolution; the original Lane keeps no local root of its own.
    if (readLaneEntry(origin.laneId)?.root === session.root) forgetLane(origin.laneId);
    const kept = rebased?.kept?.length ? { paths: rebased.kept, at: rebased.keptAt! } : undefined;
    return {
      root: session.root,
      inPlace: true,
      origin: origin.laneId,
      kept,
      workIn: workInLine(session.root, laneId, true, kept),
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
) {
  const keptNote = kept
    ? ` Your unsaved edits to ${kept.paths.slice(0, 3).join(', ')}${kept.paths.length > 3 ? ` and ${kept.paths.length - 3} more` : ''} also changed on main; they are copied to ${kept.at} for you to merge back.`
    : '';
  return inPlace
    ? `WORK IN ${root} (same folder): it is now resolution Lane ${laneId}; resolve and land from here.${keptNote}`
    : `WORK IN ${root} (new folder for resolution Lane ${laneId}): ${why}.`;
}
