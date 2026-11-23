// SPDX-License-Identifier: Apache-2.0
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { z } from 'zod';
import { clientCacheRoot } from './root-paths.js';
import { hostedRootLanePath, openHostedRootLane } from './hosted-root-checkout.js';
import { foldLateSyncEdits, rebaseHostedCheckout, type ConflictInputs } from './hosted-save-rebase.js';
import { markerAt } from './hosted-apply-recovery-records.js';
import { forgetLane, readLaneEntry } from './lane-registry.js';
import { pendingConflictPaths } from './hosted-conflict-precheck.js';
import type { syncResultSchema } from './hosted-sync.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';
import type { HostedLaneSelection } from './hosted-lane.js';

type SyncConflict = z.infer<typeof syncResultSchema>;
type Copies = { paths: string[]; at: string };
type Placement = {
  root: string;
  inPlace: boolean;
  origin?: string;
  kept?: Copies | undefined;
  folded?: Copies;
  restored?: string[];
  workIn: string;
};

/** Where the agent resolves. The conflict was made from this folder's own saved Lane head:
 * the folder itself becomes the resolution Lane (its marker and conflict record name it and
 * the origin), keeping unsaved edits and every path, wait and handoff the agent already has.
 * Otherwise the whole tree opens as a sibling folder, never nested. One line says which. */
export async function placeResolution(
  session: HostedAgentSession,
  source: SyncConflict,
  /** The caller's fresh read of the resolution Lane, reused by an in-place rebase. */
  selection: HostedLaneSelection | undefined,
  listed: Promise<{ inputs: ReadonlyMap<string, ConflictInputs> }>,
): Promise<Placement> {
  const laneId = source.lane.laneId,
    origin = source.resolution?.origin,
    marker = markerAt(session.root);
  const ours =
    marker?.url === session.address.url && marker.selection.projectId === session.address.projectId;
  if (ours && marker.selection.laneId === laneId) {
    // A resolution of this folder's own resolution Lane (b5e8e2d5): the server put the new draft in
    // the same Lane, so the folder moves from the exact head the sync merged; a replay finds it placed.
    const from = reusedFrom(source);
    if (!from || marker.selection.head === source.lane.head)
      return inPlaceResolution(session, source, listed);
    const rebased = await rebaseHostedCheckout(
      session.root,
      session.exchange,
      { laneId, origin: from, copies: resolutionCopies(source) },
      selection,
    );
    const restored = rebased?.deletedLocally?.length ? rebased.deletedLocally : undefined;
    return inPlaceResolution(session, source, listed, restored);
  }
  // A folder still holding an unresolved draft keeps it: a second, explicit draft opens beside.
  const draftHere = ours && pendingConflictPaths(session.root, marker.selection.laneId).length > 0;
  // A Candidate resolution names this folder's Lane but merged an older save of it (7351b8d7): its
  // draft does not continue these files, so rebasing here would roll newer saved edits back.
  const stale =
    !!origin &&
    !!source.resolution &&
    source.resolution.left !== origin.head &&
    source.resolution.right !== origin.head;
  if (
    ours &&
    !draftHere &&
    !stale &&
    origin &&
    marker.selection.laneId === origin.laneId &&
    marker.selection.head === origin.head &&
    marker.selection.sourceVersion === origin.sourceVersion
  ) {
    const rebased = await rebaseHostedCheckout(session.root, session.exchange, { laneId, origin }, selection);
    // The folder now belongs to the resolution; the original Lane keeps no local root of its own.
    if (readLaneEntry(origin.laneId)?.root === session.root) forgetLane(origin.laneId);
    const restored = rebased?.deletedLocally?.length ? rebased.deletedLocally : undefined;
    return {
      ...(await inPlaceResolution(session, source, listed, restored)),
      origin: origin.laneId,
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
  const why = stale
    ? 'the conflicted Candidate holds an older save of this Lane than this folder, so its newer saved work stays here'
    : resolutionFolderReason(marker?.selection, origin, draftHere);
  return {
    root: opened.root,
    inPlace: false,
    workIn: workInLine(opened.root, laneId, false, undefined, why, origin?.head, undefined, session.root),
  };
}

async function inPlaceResolution(
  session: HostedAgentSession,
  source: SyncConflict,
  listed: Promise<{ inputs: ReadonlyMap<string, ConflictInputs> }>,
  restored?: string[],
) {
  const { root, exchange } = session,
    { laneId } = source.lane;
  const resolution = source.resolution;
  // The saved head main was merged into: this Lane's own earlier head when it took the draft in place.
  const savedHead = reusedFrom(source)?.head ?? resolution?.origin?.head;
  const copies = resolutionCopies(source);
  const copied = copyPaths(root, copies, 'resolution-kept');
  if (copied && resolution?.candidateId === null && savedHead === resolution.left)
    await foldLateSyncEdits(root, exchange, source.lane, copied, (await listed).inputs, copies);
  const kept = keptCopies(root, copies);
  const folded = boundedCopies(copyPaths(root, copies, 'resolution-folded'));
  return {
    root,
    inPlace: true,
    kept,
    ...(folded ? { folded } : {}),
    ...(restored ? { restored } : {}),
    workIn: workInLine(root, laneId, true, kept, undefined, savedHead, restored, undefined, folded),
  };
}

/** The Lane's own pins before a sync whose conflict draft the server put in that same Lane (a
 * resolution of a resolution, b5e8e2d5); undefined when the draft is a new resolution Lane. */
export function reusedFrom(source: Pick<SyncConflict, 'lane' | 'from'>) {
  const from = source.from;
  return from && from.laneId === source.lane.laneId && from.head !== source.lane.head
    ? { laneId: from.laneId, head: from.head, sourceVersion: from.sourceVersion }
    : undefined;
}

/** The folder name for a draft's kept and folded copies: the Lane id, and for a later draft the
 * same Lane took in place also its head, so an earlier draft's copies (and the paths its receipt
 * named) are never overwritten and never suppress folding into the newer draft. */
export const resolutionCopies = (source: Pick<SyncConflict, 'lane' | 'from'>) =>
  reusedFrom(source) ? `${source.lane.laneId}.${source.lane.head.slice(0, 12)}` : source.lane.laneId;

/** Why the resolution opens in a new folder. Which side moved matters: a folder behind the Lane's
 * save (a save made elsewhere, or one whose reply this folder lost) was not "saved again"; the
 * conflict was made from that newer save (ad80e037). */
export function resolutionFolderReason(
  folder: { laneId: string; sourceVersion: number } | undefined,
  origin: { laneId: string; sourceVersion: number } | undefined,
  draftHere: boolean,
) {
  if (!folder) return 'this folder is not a Lane checkout';
  if (draftHere) return 'this folder holds another unresolved draft';
  if (folder.laneId !== origin?.laneId) return 'this folder holds another Lane';
  return folder.sourceVersion < origin.sourceVersion
    ? `the Lane has a newer save (source version ${origin.sourceVersion}) than this folder holds (${folder.sourceVersion}), made elsewhere or by a save whose reply this folder lost, so the conflict was made from that save, not from these files`
    : 'this folder was saved again after the conflict, so its newer work stays here';
}
export function workInLine(
  root: string,
  laneId: string,
  inPlace: boolean,
  kept?: { paths: string[]; at: string },
  why?: string,
  /** The saved Lane head the conflict was made from; says what the sync merged (ad80e037). */
  savedHead?: string,
  /** Unsaved deletions the merge changed: the file is back with the merged bytes. */
  restored?: string[],
  /** A new folder: the folder the sync ran from, left as it was. */
  from?: string,
  /** Exact copies of late edits already incorporated in the checkout's conflict draft. */
  folded?: Copies,
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
  const foldedNote = folded
    ? ` Late edits to ${list(folded.paths)} are in the conflict draft. Their original copies are in ${folded.at}.`
    : '';
  const restNote = savedHead || kept ? ' Other unsaved edits stay in place, still unsaved.' : '';
  if (inPlace)
    return `WORK IN ${root} (same folder): it is now resolution Lane ${laneId}; resolve and land from here.${savedNote}${foldedNote}${keptNote}${restoredNote}${restNote}`;
  // A new folder holds the saved head merged with main; nothing from the old folder moves (ad80e037).
  const siblingSaved = savedHead
    ? ` Saved: the new folder holds the Lane's saved head ${savedHead.slice(0, 12)} merged with main.`
    : '';
  const left = from
    ? ` NOT carried: ${from} is unchanged and its unsaved edits stay there; copy any the resolution needs into the new folder.`
    : '';
  return `WORK IN ${root} (new folder for resolution Lane ${laneId}): ${why}.${siblingSaved}${left}`;
}
/** Copies of unsaved edits an in-place resolution set aside for this draft (its resolutionCopies
 * name), read from the folder that holds them (rebaseHostedCheckout's keptAt), at most 100 paths.
 * Undefined when there are none. */
export function keptCopies(root: string, copies: string) {
  return boundedCopies(copyPaths(root, copies, 'resolution-kept'));
}
const boundedCopies = (copies: Copies | undefined) =>
  copies && { at: copies.at, paths: copies.paths.slice(0, 100) };

function copyPaths(root: string, laneId: string, directory: string): Copies | undefined {
  const at = join(clientCacheRoot(root), directory, laneId);
  let entries;
  try {
    entries = readdirSync(at, { recursive: true, withFileTypes: true });
  } catch {
    return undefined;
  }
  const paths = entries
    .filter(entry => !entry.isDirectory())
    .map(entry => relative(at, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .sort();
  return paths.length ? { paths, at } : undefined;
}
