// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import { listLanes, readLaneEntry } from './lane-registry.js';
import { markerAt } from './hosted-apply-recovery-records.js';

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
 * following a chain of such resolutions, when this machine has it open. Local files only: the
 * registry is listed only when LANE_ID has no checkout of its own here. */
export function laneSuccessor(
  session: { root: string; address: { url: string; projectId: string } },
  laneId: string | undefined,
): { laneId: string; root: string } | null {
  if (!laneId || openLaneRoot(session, laneId)) return null;
  const local = markerAt(session.root);
  if (local?.selection.laneId === laneId) return null;
  let found: { laneId: string; root: string } | null = null;
  const lanes = listLanes().filter(
    entry =>
      entry.resolutionOf &&
      !entry.state &&
      entry.url === session.address.url &&
      entry.projectId === session.address.projectId,
  );
  for (let from = laneId, hops = 0; hops < 8; hops++) {
    const next = lanes.find(entry => entry.resolutionOf === from);
    if (!next) break;
    const marker = markerAt(next.root);
    if (marker?.selection.laneId === next.laneId) found = { laneId: next.laneId, root: next.root };
    from = next.laneId;
  }
  return found;
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
  // land with the old id runs in the folder, where it lands the resolution (hosted-land-resolution).
  if (own || (!FOLDER_ACTIONS.has(action) && action !== 'finish')) return own;
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
  const successor = root ? null : laneSuccessor(session, laneId);
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
