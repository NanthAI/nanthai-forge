// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readlinkSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { readLaneEntry } from './lane-registry.js';
import { markerIdentity } from './lane-prune.js';
import { checkoutPathExists } from './hosted-checkout-files.js';

/** `start` from a checkout ROOT opens the new Lane in ROOT.forge-client/lanes/<id>. A later `open`
 * at another path moves that copy there instead of downloading a second tree, so a Lane has one
 * root per machine. Returns the old path when it moved; null leaves the caller's normal checkout.
 * Never moves a copy in use (its client lock is held) or one on another volume. */
export function adoptNestedLaneCopy(
  root: string,
  laneId: string,
  address: { url: string; projectId: string },
): string | null {
  root = resolve(root);
  if (checkoutPathExists(root)) return null;
  const entry = readLaneEntry(laneId);
  if (!entry || entry.url !== address.url || entry.projectId !== address.projectId) return null;
  const copy = resolve(entry.root);
  if (copy === root || !copy.endsWith(`.forge-client${sep}lanes${sep}${laneId}`)) return null;
  const identity = markerIdentity(copy);
  if (identity?.laneId !== laneId || identity.projectId !== address.projectId) return null;
  if (checkoutPathExists(`${copy}.forge-client/lock`)) return null;
  // `start` linked shared dependencies into the copy; `open` links them again at the new root.
  const modules = join(copy, 'node_modules');
  try {
    if (lstatSync(modules).isSymbolicLink() && readlinkSync(modules)) rmSync(modules);
  } catch {
    /* no dependency link */
  }
  try {
    renameSync(copy, root);
  } catch {
    return null;
  }
  // The copy's own client directory held only its checkout receipts; objects live in the shared store.
  rmSync(`${copy}.forge-client`, { recursive: true, force: true });
  rmSync(`${copy}.forge-metrics.jsonl`, { force: true });
  return copy;
}
