// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { carryOverlapBases } from './hosted-overlap-text.js';
import { clientCacheRoot } from './root-paths.js';
import { sourceTree } from './source-tree.js';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { HostedCheckoutCache } from './hosted-checkout-cache.js';
import { checkoutPathExists, installHostedFile } from './hosted-checkout-files.js';
import {
  hostedLaneCheckoutMarkerSchema,
  readHostedLaneCheckout,
  type HostedLaneCheckoutMarker,
} from './hosted-lane-checkout-marker.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';
import type { HostedLaneSelection } from './hosted-lane.js';
import { parseNativeState, type NativeFile } from './state/format.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { durableReplace, syncDirectory } from './state/durability.js';
import { workLocked } from './work-lock.js';
import { ForgeError, invariant } from './errors.js';
import { finishPendingCheckoutDelta, settlePendingCheckoutDelta } from './hosted-checkout-delta-pending.js';
import { diskShapeMatches } from './source-links.js';
import type { TextAttributes } from './git-attributes.js';
import { workingMatches, worktreeText } from './checkout-text.js';
import { pendingSavePath } from './hosted-save-pending.js';
import { journalCheckoutDelta, resolutionDeltaStagePrefix, type DeltaPin } from './hosted-checkout-delta.js';
import { readSource } from './files.js';
import { hasConflictMarkers } from './conflict-markers.js';
import { markNativeTextConflicts, wholeFileConflict } from './native-text-merge.js';
import { digest } from './hash.js';
import {
  isTextBytes,
  SOURCE_TEXT_MERGE_MAX_BYTES,
  SOURCE_TEXT_MERGE_MAX_LINES,
  sourceTextLines,
} from './text-bytes.js';
import { hostedLaneMarkerName } from './hosted-lane-checkout-marker.js';
export { pendingSavePath };

type Exchange = ConstructorParameters<typeof ConvexLaneTransport>[0];
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The one command that always gets an agent unstuck: keep every unsaved edit
 * in a patch next to the checkout, abandon, and re-apply in a fresh Lane. */
export function keepPatchCommand(root: string, laneId: string) {
  return `nforge agent ${shell(root)} abandon ${shell(JSON.stringify({ laneId, reason: 'Re-apply in a fresh Lane', keepPatch: true }))}`;
}

/** Exact working-tree identity, never following a link target. */
function onDisk(root: string, path: string, file: NativeFile | undefined, text: TextAttributes | null) {
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
    bytes && workingMatches(text, path, bytes, file.blob, file.mode) && diskShapeMatches(stat, file.mode),
  );
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
  onto?: {
    laneId: string;
    origin: { laneId: string; head: string; sourceVersion: number };
    /** The copies folder name for this draft (resolutionCopies); the Lane id by default. */
    copies?: string;
  },
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
  // The checkout's `.gitattributes` decide working line endings (44ef42b9) for checks and installs.
  const text = worktreeText(root, stale.state.files);
  const install: {
    path: string;
    file: NativeFile | undefined;
    old: NativeFile | undefined;
    keep?: boolean;
    deleted?: boolean;
  }[] = [];
  const keptAt = onto ? join(clientCacheRoot(root), 'resolution-kept', onto.copies ?? lane.laneId) : null;
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
      if (onDisk(root, path, wanted, text)) continue;
      if (!onDisk(root, path, present, text)) {
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
        item.keep || onDisk(root, item.path, item.old, text),
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
      installHostedFile(root, objects, item.file, true, text);
      syncDirectory(dirname(target));
    }
    durableReplace(join(root, '.forge/hosted-lane.json'), JSON.stringify(marker));
    // The resolution's row starts from its origin's, so this folder's first baselines carry over (c2388099).
    if (onto) carryOverlapBases(clientCacheRoot(root), stale.selection.laneId, lane.laneId);
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

export type ConflictInputs = { base: NativeFile | null; left: NativeFile | null; right: NativeFile | null };
const maxDraftBytes = 4 * SOURCE_TEXT_MERGE_MAX_BYTES;
const regular = (file: NativeFile | null | undefined): file is NativeFile =>
  file?.mode === 'file' || file?.mode === 'executable';

function readMergeFile(root: string, path: string, limit: number, pin?: string) {
  try {
    return readSource(root, path, limit, pin);
  } catch (error) {
    if (error instanceof ForgeError && error.code === 'FILE_LIMIT') return null;
    throw error;
  }
}

function textEdit(root: string, file: NativeFile) {
  const path = join(root, file.path);
  if (!checkoutPathExists(path) || !diskShapeMatches(lstatSync(path), file.mode)) return null;
  const bytes = readMergeFile(root, file.path, SOURCE_TEXT_MERGE_MAX_BYTES);
  return bytes && isTextBytes(bytes) && sourceTextLines(bytes) <= SOURCE_TEXT_MERGE_MAX_LINES ? bytes : null;
}

/** Replay a local diff3 draft from the pinned sync inputs and the preserved late edits. The
 * Lane's saved source remains the server draft. Publish changed paths with the checkout journal
 * so a crash or an editor racing the apply keeps the original bytes recoverable. */
export async function foldLateSyncEdits(
  root: string,
  exchange: Exchange,
  lane: HostedLaneSelection,
  copied: { paths: string[]; at: string },
  inputs: ReadonlyMap<string, ConflictInputs>,
  /** The copies folder name for this draft (resolutionCopies). */
  copies = lane.laneId,
) {
  finishPendingCheckoutDelta(root);
  const draft = readHostedLaneCheckout(root);
  if (draft?.selection.laneId !== lane.laneId || draft.selection.head !== lane.head) return;
  const localPaths = new Set(copied.paths);
  const files = draft.state.files.flatMap(file => {
    const input = inputs.get(file.path);
    return localPaths.has(file.path) &&
      regular(file) &&
      regular(input?.left) &&
      input.left.mode === file.mode &&
      input.left.blob !== file.blob &&
      (!input.base || regular(input.base)) &&
      (!input.right || regular(input.right)) &&
      textEdit(copied.at, file)
      ? [{ file, input }]
      : [];
  });
  if (!files.length) return;
  const cacheRoot = clientCacheRoot(root);
  const cache = new HostedCheckoutCache(cacheRoot, new ConvexLaneTransport(exchange));
  try {
    await cache.ensure(
      files.flatMap(({ input }) => [input.base, input.right].flatMap(side => (side ? [side.blob] : []))),
    );
  } catch {
    // This rendering is optional. The existing draft and kept-copy recovery are usable offline.
    return;
  }
  const objects = cache.objects;
  const archived = join(cacheRoot, 'resolution-folded', copies);
  workLocked(join(cacheRoot, 'lock'), () => {
    settlePendingCheckoutDelta(root);
    const current = readHostedLaneCheckout(root);
    if (current?.selection.laneId !== lane.laneId || current.selection.head !== lane.head) return;
    const text = worktreeText(root, current.state.files);
    const install: DeltaPin[] = [],
      displace: DeltaPin[] = [];
    const folded: string[] = [];
    let stage: string | undefined;
    let journaled = false;
    try {
      for (const { file, input } of files) {
        const path = file.path;
        if (checkoutPathExists(join(archived, path))) continue;
        const late = textEdit(copied.at, file);
        const working = readMergeFile(root, path, maxDraftBytes);
        if (
          !late ||
          !working ||
          !hasConflictMarkers(working) ||
          !diskShapeMatches(lstatSync(join(root, path)), file.mode)
        )
          continue;
        const checkoutBytes = (bytes: Buffer) => text?.toWorktree(path, bytes) ?? bytes;
        const side = (pin: NativeFile | null) =>
          pin ? readMergeFile(objects, pin.blob, SOURCE_TEXT_MERGE_MAX_BYTES, pin.blob) : Buffer.alloc(0);
        const base = side(input.base),
          right = side(input.right);
        if (!base || !right) continue;
        const sides = [base, late, right].map(checkoutBytes) as [Buffer, Buffer, Buffer];
        const labels: [string, string] = ['lane', 'target'];
        const marked = markNativeTextConflicts(...sides, labels, 'right-first');
        if (!marked) continue;
        const merged = marked.conflicted ? marked.bytes : wholeFileConflict(...sides, labels)!;
        if (working.equals(merged)) {
          folded.push(path);
          continue;
        }
        if (!workingMatches(text, path, working, file.blob, file.mode)) continue;
        stage ??= mkdtempSync(join(cacheRoot, resolutionDeltaStagePrefix));
        const target = join(stage, path);
        mkdirSync(dirname(target), { recursive: true });
        durableReplace(target, merged, file.mode === 'executable' ? 0o755 : 0o644);
        install.push({ path, blob: digest(merged), mode: file.mode });
        displace.push({ path, blob: digest(working), mode: file.mode });
      }
      if (stage) {
        const operationId = randomUUID();
        const marker = `.forge/${hostedLaneMarkerName}`;
        const before = readSource(root, marker, Number.MAX_SAFE_INTEGER);
        if (!before) return;
        const after = JSON.stringify({ ...current, operationId });
        mkdirSync(join(stage, '.forge'));
        durableReplace(join(stage, marker), after);
        journalCheckoutDelta(cacheRoot, {
          operationId,
          stage: basename(stage),
          marker: hostedLaneMarkerName,
          priorMarker: digest(before),
          targetMarker: digest(after),
          install,
          displace,
          targetFiles: current.state.files,
        });
        journaled = true;
        const settled = settlePendingCheckoutDelta(root);
        if (settled?.retained.length)
          throw new ForgeError(
            'WORK_CONFLICT',
            `Local checkout changes were kept at ${settled.retained.join(', ')}. Retry the sync to view any remaining conflict copies.`,
          );
        if (settled?.outcome === 'published') folded.push(...install.map(file => file.path));
      }
      for (const path of folded) {
        const from = join(copied.at, path),
          to = join(archived, path);
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        renameSync(from, to);
        syncDirectory(dirname(to));
        syncDirectory(dirname(from));
      }
    } finally {
      if (stage && !journaled) rmSync(stage, { recursive: true, force: true });
    }
  });
}
