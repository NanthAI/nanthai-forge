// SPDX-License-Identifier: Apache-2.0
import { clientCacheRoot } from './root-paths.js';
import { sourceTree } from './source-tree.js';
import { cpSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HostedCheckoutCache } from './hosted-checkout-cache.js';
import { checkoutPathExists, installHostedFile } from './hosted-checkout-files.js';
import {
  hostedLaneCheckoutMarkerSchema,
  readHostedLaneCheckout,
  type HostedLaneCheckoutMarker,
} from './hosted-lane-checkout-marker.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';
import type { HostedLaneSelection } from './hosted-lane.js';
import { parseNativeState, type NativeFile } from './native-state-format.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { durableReplace, syncDirectory } from './native-durability.js';
import { workLocked } from './work-lock.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { finishPendingCheckoutDelta, settlePendingCheckoutDelta } from './hosted-checkout-delta-pending.js';
import { diskShapeMatches } from './source-links.js';

type Exchange = ConstructorParameters<typeof ConvexLaneTransport>[0];
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** One retained save per checkout baseline; its reply may be lost while it publishes. */
export const pendingSavePath = (root: string, marker: unknown) =>
  join(clientCacheRoot(root), `save-baseline-${digest(canonicalPayload(marker))}.json`);

/** The one command that always gets an agent unstuck: keep every unsaved edit
 * in a patch next to the checkout, abandon, and re-apply in a fresh Lane. */
export function keepPatchCommand(root: string, laneId: string) {
  return `nforge agent ${shell(root)} abandon ${shell(JSON.stringify({ laneId, reason: 'Re-apply in a fresh Lane', keepPatch: true }))}`;
}

/** Exact working-tree identity, never following a link target. */
function onDisk(root: string, path: string, file: NativeFile | undefined) {
  const absolute = join(root, path);
  if (!checkoutPathExists(absolute)) return !file;
  if (!file) return false;
  const stat = lstatSync(absolute);
  const bytes = stat.isSymbolicLink()
    ? readlinkSync(absolute, { encoding: 'buffer' })
    : stat.isFile() && stat.nlink === 1
      ? readFileSync(absolute)
      : null;
  return Boolean(bytes && digest(bytes) === file.blob && diskShapeMatches(stat, file.mode));
}

/** Move a checkout whose server Lane moved underneath it (a save that completed
 * after its reply was lost, a sync whose local apply was refused) onto the
 * current server Lane. Only paths the server changed are touched, and only when
 * the working file still equals the old baseline; local edits are never
 * overwritten. One Lane read; a moved head adds one manifest and the changed
 * blobs in page-sized batches. Returns null when the checkout is already current.
 *
 * `onto` rebinds the folder to another Lane instead: the conflict resolution Lane made
 * from this exact saved head. Unsaved edits on paths it does not change stay in place;
 * an unsaved edit on a path it changes is copied to `keptAt` (outside the source tree)
 * before that path takes the resolution's bytes, so nothing is lost or left behind. */
export async function rebaseHostedCheckout(
  root: string,
  exchange: Exchange,
  onto?: { laneId: string; origin: { laneId: string; head: string; sourceVersion: number } },
  /** A Lane read the caller just made of the same Lane; saves this function's own read. */
  selected?: HostedLaneSelection,
) {
  finishPendingCheckoutDelta(root);
  const stale = readHostedLaneCheckout(root);
  invariant(stale, 'NOT_FOUND', 'Open a hosted Lane before saving.');
  if (onto)
    invariant(
      stale.selection.laneId === onto.origin.laneId &&
        stale.selection.head === onto.origin.head &&
        stale.selection.sourceVersion === onto.origin.sourceVersion,
      'WORK_STALE',
      'This checkout no longer holds the exact saved source the resolution was made from.',
    );
  const transport = new ConvexLaneTransport(exchange),
    laneId = onto?.laneId ?? stale.selection.laneId,
    lane = selected?.laneId === laneId ? selected : await transport.select(laneId);
  const repair = keepPatchCommand(root, lane.laneId);
  invariant(
    lane.state === 'active',
    'LANE_NOT_ACTIVE',
    `Lane ${lane.laneId} is ${lane.state}; nothing can be saved to it. Keep your edits and abandon this checkout: ${repair}`,
  );
  if (canonicalPayload(lane) === canonicalPayload(stale.selection)) return null;
  let state = stale.state,
    objects = '';
  const install: {
    path: string;
    file: NativeFile | undefined;
    old: NativeFile | undefined;
    keep?: boolean;
    deleted?: boolean;
  }[] = [];
  const keptAt = onto ? join(clientCacheRoot(root), 'resolution-kept', lane.laneId) : null;
  const materialized = new Set(stale.materialized);
  if (lane.head !== stale.selection.head) {
    const cache = new HostedCheckoutCache(clientCacheRoot(root), transport);
    await cache.ensure([lane.head]);
    state = parseNativeState(readFileSync(join(cache.objects, lane.head)));
    const before = new Map(stale.state.files.map(file => [file.path, file])),
      after = new Map(state.files.map(file => [file.path, file]));
    const inScope = (path: string) =>
      stale.scope === null || stale.scope.some(root => path === root || path.startsWith(`${root}/`));
    const conflicts: string[] = [];
    for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const old = before.get(path),
        next = after.get(path);
      if (canonicalPayload(old ?? null) === canonicalPayload(next ?? null)) continue;
      const present = materialized.has(path) ? old : undefined,
        wanted = next && (materialized.has(path) || inScope(path)) ? next : undefined;
      materialized.delete(path);
      if (wanted) materialized.add(path);
      // Both sides made the same change, or the path stays unmaterialized.
      if (onDisk(root, path, wanted)) continue;
      if (!onDisk(root, path, present)) {
        if (keptAt) install.push({ path, file: wanted, old: present, keep: true });
        else conflicts.push(path);
      } else install.push({ path, file: wanted, old: present });
    }
    invariant(
      !conflicts.length,
      'SAVE_REBASE_CONFLICT',
      `Your unsaved edits and the Lane's newer saved head both change ${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : ''}. Nothing was changed. Keep your edits as a patch and abandon this checkout, then re-apply them in a fresh Lane: ${repair}`,
    );
    await cache.ensure(install.flatMap(item => (item.file ? [item.file.blob] : [])));
    objects = cache.objects;
  }
  const marker: HostedLaneCheckoutMarker = hostedLaneCheckoutMarkerSchema.parse({
    ...stale,
    selection: lane,
    state,
    tree: sourceTree(state.files),
    materialized: [...materialized].sort(),
  });
  workLocked(join(clientCacheRoot(root), 'lock'), () => {
    settlePendingCheckoutDelta(root);
    invariant(
      canonicalPayload(readHostedLaneCheckout(root)) === canonicalPayload(stale),
      'WORK_STALE',
      'Another command updated this checkout while it was being repaired. Retry the same save.',
    );
    // Recheck each path under the lock: an edit since the scan is preserved.
    for (const item of install)
      invariant(
        item.keep || onDisk(root, item.path, item.old),
        'SAVE_REBASE_CONFLICT',
        `${item.path} changed while the checkout was being repaired. Nothing was saved; retry the same save.`,
      );
    // Unsaved bytes the resolution also changes move out of the source tree first (copied,
    // then replaced), so the folder holds the resolution and the edit stays recoverable.
    for (const item of install.filter(item => item.keep)) {
      if (!checkoutPathExists(join(root, item.path))) {
        item.deleted = true;
        continue;
      }
      const kept = join(keptAt!, item.path);
      mkdirSync(dirname(kept), { recursive: true, mode: 0o700 });
      cpSync(join(root, item.path), kept, { recursive: true, verbatimSymlinks: true, force: true });
      syncDirectory(dirname(kept));
    }
    for (const item of install) {
      const target = join(root, item.path);
      if (checkoutPathExists(target)) rmSync(target, { recursive: Boolean(item.keep) });
      if (!item.file) continue;
      mkdirSync(dirname(target), { recursive: true });
      invariant(
        realpathSync(dirname(target)) === join(root, dirname(item.path)),
        'UNSAFE_PATH',
        'Checkout directories must be real.',
      );
      installHostedFile(root, objects, item.file);
      syncDirectory(dirname(target));
    }
    durableReplace(join(root, '.forge/hosted-lane.json'), JSON.stringify(marker));
    // A save pinned to the old baseline either moved the Lane or will be refused; never look it up again.
    rmSync(pendingSavePath(root, stale), { force: true });
  });
  const kept = install.filter(item => item.keep && !item.deleted).map(item => item.path),
    deletedLocally = install.filter(item => item.deleted).map(item => item.path);
  return {
    from: stale.selection.head,
    to: lane.head,
    updatedPaths: install.map(item => item.path),
    ...(kept.length ? { kept, keptAt } : {}),
    // Unsaved local deletions of files the resolution changes: the resolution's bytes are back.
    ...(deletedLocally.length ? { deletedLocally } : {}),
  };
}
