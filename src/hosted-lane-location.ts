// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import { readLaneEntry } from './lane-registry.js';
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
  return openLaneRoot({ root, address }, laneId);
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
  return new ForgeError(
    'HOSTED_CHECKOUT_REQUIRED',
    root ? `${message} This Lane is open at ${root}: run the same command with that path as ROOT.` : message,
    undefined,
    root ? { root, laneId } : undefined,
  );
}
