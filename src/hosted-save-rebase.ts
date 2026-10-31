// SPDX-License-Identifier: Apache-2.0
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HostedCheckoutCache } from './hosted-checkout-cache.js';
import { checkoutPathExists, installHostedFile } from './hosted-checkout-files.js';
import {
  hostedLaneCheckoutMarkerSchema,
  readHostedLaneCheckout,
  type HostedLaneCheckoutMarker,
} from './hosted-lane-checkout-marker.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';
import { parseNativeState, type NativeFile } from './native-state-format.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { durableReplace, syncDirectory } from './native-durability.js';
import { workLocked } from './work-lock.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';

type Exchange = ConstructorParameters<typeof ConvexLaneTransport>[0];
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** One retained save per checkout baseline; its reply may be lost while it publishes. */
export const pendingSavePath = (root: string, marker: unknown) =>
  join(`${root}.forge-client`, `save-baseline-${digest(canonicalPayload(marker))}.json`);

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
  return Boolean(
    bytes &&
    digest(bytes) === file.blob &&
    (stat.isSymbolicLink()
      ? file.mode === 'symlink'
      : file.mode !== 'symlink' && Boolean(stat.mode & 0o111) === (file.mode === 'executable')),
  );
}

/** Move a checkout whose server Lane moved underneath it (a save that completed
 * after its reply was lost, a sync whose local apply was refused) onto the
 * current server Lane. Only paths the server changed are touched, and only when
 * the working file still equals the old baseline; local edits are never
 * overwritten. One Lane read; a moved head adds one manifest and the changed
 * blobs in page-sized batches. Returns null when the checkout is already current. */
export async function rebaseHostedCheckout(root: string, exchange: Exchange) {
  const stale = readHostedLaneCheckout(root);
  invariant(stale, 'NOT_FOUND', 'Open a hosted Lane before saving.');
  const transport = new ConvexLaneTransport(exchange),
    lane = await transport.select(stale.selection.laneId);
  const repair = keepPatchCommand(root, lane.laneId);
  invariant(
    lane.state === 'active',
    'LANE_NOT_ACTIVE',
    `Lane ${lane.laneId} is ${lane.state}; nothing can be saved to it. Keep your edits and abandon this checkout: ${repair}`,
  );
  if (canonicalPayload(lane) === canonicalPayload(stale.selection)) return null;
  let state = stale.state,
    objects = '';
  const install: { path: string; file: NativeFile | undefined; old: NativeFile | undefined }[] = [];
  const materialized = new Set(stale.materialized);
  if (lane.head !== stale.selection.head) {
    const cache = new HostedCheckoutCache(`${root}.forge-client`, transport);
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
      if (!onDisk(root, path, present)) conflicts.push(path);
      else install.push({ path, file: wanted, old: present });
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
    materialized: [...materialized].sort(),
  });
  workLocked(join(`${root}.forge-client`, 'lock'), () => {
    invariant(
      canonicalPayload(readHostedLaneCheckout(root)) === canonicalPayload(stale),
      'WORK_STALE',
      'Another command updated this checkout while it was being repaired. Retry the same save.',
    );
    // Recheck each path under the lock: an edit since the scan is preserved.
    for (const item of install)
      invariant(
        onDisk(root, item.path, item.old),
        'SAVE_REBASE_CONFLICT',
        `${item.path} changed while the checkout was being repaired. Nothing was saved; retry the same save.`,
      );
    for (const item of install) {
      const target = join(root, item.path);
      if (checkoutPathExists(target)) rmSync(target);
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
  return { from: stale.selection.head, to: lane.head, updatedPaths: install.map(item => item.path) };
}
