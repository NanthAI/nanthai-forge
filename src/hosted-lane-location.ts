// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import { ForgeError } from './errors.js';
import { retainedHostedOperation } from './hosted-agent-journal.js';
import { laneResolutions, readLaneEntry } from './lane-registry.js';
import { markerAt } from './hosted-apply-recovery-records.js';
import { inPlaceResolution } from './hosted-conflict-precheck.js';

/** Where this machine already has the Lane open, when that is not `session.root`. Only a
 * registered root whose checkout marker names the same Lane, URL and project counts. */
export function openLaneRoot(
  session: { root: string; address: { url: string; projectId: string } },
  laneId: string | undefined,
): string | null {
  const entry = laneId ? readLaneEntry(laneId) : null;
  if (!laneId || !entry || entry.root === session.root) return null;
  const local = markerAt(entry.root);
  return local &&
    local.selection.laneId === laneId &&
    local.url === session.address.url &&
    local.selection.projectId === session.address.projectId
    ? entry.root
    : null;
}

/** The resolution Lane that took over LANE_ID's folder in place after a sync conflict (9bc3775b),
 * following a chain of such resolutions (0f76b07e: a middle Lane's own entry is gone once the next
 * one took its folder), when this machine has it open. Local files only: one small successor index,
 * then one registry entry and checkout marker per hop. */
export function laneSuccessor(
  session: { root: string; address: { url: string; projectId: string } },
  laneId: string | undefined,
): { laneId: string; root: string } | null {
  if (!laneId || openLaneRoot(session, laneId)) return null;
  const local = markerAt(session.root);
  if (local?.selection.laneId === laneId) return null;
  const successors = laneResolutions();
  let found: { laneId: string; root: string } | null = null;
  for (let from = laneId, hops = 0; hops < 8 && successors[from]; hops++) {
    from = successors[from]!;
    const entry = readLaneEntry(from);
    if (
      !entry ||
      entry.state ||
      entry.url !== session.address.url ||
      entry.projectId !== session.address.projectId
    )
      continue;
    if (markerAt(entry.root)?.selection.laneId === from) found = { laneId: from, root: entry.root };
  }
  return found;
}

/** The live resolution Lane that carries LANE_ID's work on this machine (0f76b07e): this folder,
 * when it became LANE_ID's resolution in place (its own conflict record names the origin), else
 * the registered chain of in-place resolutions. Local files only; null when LANE_ID is still its
 * own Lane here or nothing on this machine continues it. */
export function resolutionFollow(
  session: { root: string; address: { url: string; projectId: string } },
  laneId: string | undefined,
): { laneId: string; root: string } | null {
  if (!laneId) return null;
  const local = markerAt(session.root);
  if (local?.selection.laneId === laneId) return null;
  const here = local ? inPlaceResolution(session.root, laneId, true) : undefined;
  if (
    here &&
    local?.selection.laneId === here.laneId &&
    local.url === session.address.url &&
    local.selection.projectId === session.address.projectId
  )
    return { laneId: here.laneId, root: session.root };
  return laneSuccessor(session, laneId);
}

/** True when OPERATION_ID is a retained operation that began on NAMED itself (it started before the
 * Lane moved): its replay keeps that request. A retained one that began on the followed Lane (its
 * reply was lost, and the retry repeats the old id) is followed again, so it replays unchanged. */
export function keepsRetainedLane(root: string, operationId: unknown, key: string, named: string) {
  if (typeof operationId !== 'string') return false;
  const retained = retainedHostedOperation(root, operationId);
  return Boolean(retained && retained.command[key] === named);
}

/** Actions whose `laneId` (or wait's `peer`) follows an old Lane id to its live resolution Lane. */
const FOLLOW_ACTIONS = new Set(['save', 'checkpoint', 'preflight', 'resolve', 'withdraw', 'wait']);

/** Run a command that names a Lane a sync conflict moved into a resolution Lane on that resolution
 * Lane instead of refusing (HOSTED_CHECKOUT_REQUIRED, LANDING_NOT_LIVE) or waiting on a Lane whose
 * head can no longer move (0f76b07e). Stderr says so once. A replay of a retained operation keeps
 * the request it began with. Local files only: no server call. */
export function followResolutionLane(
  where: () => { root: string; address: { url: string; projectId: string } },
  action: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!FOLLOW_ACTIONS.has(action)) return input;
  const key = action === 'wait' ? 'peer' : 'laneId';
  const named = input[key];
  if (typeof named !== 'string' || !z.uuid().safeParse(named).success) return input;
  const session = where();
  if (keepsRetainedLane(session.root, input.operationId, key, named)) return input;
  const moved = resolutionFollow(session, named);
  // A command on a checkout elsewhere still refuses with the folder to use (checkoutRequired).
  if (!moved || (CHECKOUT_ACTIONS.has(action) && moved.root !== session.root)) return input;
  process.stderr.write(
    `Lane ${named} continues as resolution Lane ${moved.laneId} in ${moved.root} after a sync conflict; ${action} runs on ${moved.laneId}. Use that id from now on.\n`,
  );
  return { ...input, [key]: moved.laneId };
}

/** Actions on the files of a Lane folder: an old Lane id names its in-place resolution there. */
export const FOLDER_ACTIONS = new Set(['save', 'checkpoint', 'preflight']);

/** Actions that change a Lane through its checkout. */
const CHECKOUT_ACTIONS = new Set([
  'save',
  'checkpoint',
  'candidate',
  'sync',
  'preflight',
  'ack',
  'finish',
  'complete',
  'abandon',
  'withdraw',
  'undo',
]);
/** The folder a CLI command runs in when ROOT is not the named Lane's checkout (usually the project
 * folder, as the start receipt invites) but this machine has that Lane open: its own checkout, so the
 * command runs instead of refusing with HOSTED_CHECKOUT_REQUIRED (Issue 681ee3d4). Local files only;
 * reads such as status, wait or diff keep ROOT, since their laneId may name a peer. */
export function laneCheckoutRoot(
  root: string,
  action: string,
  laneId: unknown,
  address: { url: string; projectId: string },
): string | null {
  if (!CHECKOUT_ACTIONS.has(action) || typeof laneId !== 'string') return null;
  const own = openLaneRoot({ root, address }, laneId);
  // land with the old id runs in the folder, where it lands the resolution (hosted-land-resolution);
  // withdraw there withdraws the resolution Lane's landing (0f76b07e).
  if (own || (!FOLDER_ACTIONS.has(action) && action !== 'finish' && action !== 'withdraw')) return own;
  return laneSuccessor({ root, address }, laneId)?.root ?? null;
}

/** One wording for "this command needs a Lane" (w30: weaker models passed the project folder and an empty body). */
export const SELECT_LANE =
  'This command needs a Lane: pass {"laneId":"LANE_ID"}, or use the Lane folder printed by start as ROOT.';

/** HOSTED_CHECKOUT_REQUIRED that names the Lane's own checkout when it is open elsewhere, so a
 * caller who passed the project folder as ROOT re-runs with that path instead of hunting for it. */
export function checkoutRequired(
  session: { root: string; address: { url: string; projectId: string } },
  laneId: string | undefined,
  message: string,
) {
  const root = openLaneRoot(session, laneId);
  const successor = root ? null : resolutionFollow(session, laneId);
  if (successor)
    return new ForgeError(
      'HOSTED_CHECKOUT_REQUIRED',
      `${message} Lane ${laneId} continues as resolution Lane ${successor.laneId} in its folder ${successor.root} after a sync conflict: run the same command with {"laneId":"${successor.laneId}"} and that path as ROOT.`,
      undefined,
      { root: successor.root, laneId: successor.laneId, resolutionOf: laneId },
    );
  return new ForgeError(
    'HOSTED_CHECKOUT_REQUIRED',
    root ? `${message} This Lane is open at ${root}: run the same command with that path as ROOT.` : message,
    undefined,
    root ? { root, laneId } : undefined,
  );
}
