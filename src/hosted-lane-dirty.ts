// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readHostedLaneCheckout, type HostedLaneCheckoutMarker } from './hosted-lane-checkout-marker.js';
import type { NativeFile } from './state/format.js';
import { forgeCachePath } from './forge-cache-paths.js';
import { digest } from './hash.js';
import { gitlinkDirectoryPointer } from './gitlink-workspace.js';
import { scanSourcePaths } from './source-paths.js';
import {
  cachedSourcePaths,
  indexedBlob,
  readCheckoutStatIndex,
  statIndexRefresh,
  treeRecorder,
} from './checkout-stat-index.js';
import { deltaApplyPending } from './hosted-checkout-delta-pending.js';
import { diskMode } from './source-links.js';
import { workingMatches, worktreeText } from './checkout-text.js';

const LARGE_FILE = 256 * 1024 * 1024;
/** True when the checkout differs from its saved baseline, or when that cannot be established
 * (an in-place apply is running or was interrupted: the marker may not describe the bytes yet).
 * Local: it hashes files in place (skipping those the checkout stat index vouches for). With
 * `refresh` (a command working in this Lane), a clean pass also refreshes racy stat-index entries,
 * as Git status does, so files installed or saved inside the racy window are read once more, not on
 * every check. Housekeeping probes leave it off: they write nothing, so they never look like use. */
export function hostedLaneDirty(
  root: string,
  {
    refresh,
    selection,
  }: {
    refresh?: boolean;
    selection?: Pick<HostedLaneCheckoutMarker['selection'], 'laneId' | 'head'>;
  } = {},
): boolean {
  try {
    if (deltaApplyPending(root)) return true;
    const marker = readHostedLaneCheckout(root);
    if (
      !marker ||
      (selection &&
        (marker.selection.laneId !== selection.laneId || marker.selection.head !== selection.head))
    )
      return true;
    return laneChanges(root, marker, { ...(refresh === undefined ? {} : { refresh }), limit: 1 }).length > 0;
  } catch {
    return true;
  }
}

/** The paths of this checkout that differ from `expected` (by default the head its marker names):
 * the same comparison as hostedLaneDirty, listing up to `limit` paths. `expected` describes another
 * tree on this marker's checkout (what a settling save captured). Throws when a file cannot be read.
 * Cost (Issue 48835eea): one lstat per saved file, plus one per listed directory. The source walk
 * (listing every directory, applying ignore rules) runs only when the last recorded walk no longer
 * holds (checkout-tree.json, checkout-stat-index: an entry was created, deleted or renamed, an ignore file changed, or it
 * is racy); `record` (a command working in this Lane) then keeps that walk for the next check. */
export function laneChanges(
  root: string,
  marker: HostedLaneCheckoutMarker,
  options: {
    refresh?: boolean;
    record?: boolean;
    limit?: number;
    scan?: () => string[];
    expected?: { files: readonly NativeFile[]; materialized: readonly string[] };
  } = {},
): string[] {
  const files = options.expected?.files ?? marker.state.files,
    limit = options.limit ?? Number.POSITIVE_INFINITY,
    changed: string[] = [];
  const baseline = new Map(files.map(file => [file.path, file]));
  const refresh = statIndexRefresh(root);
  const retained = [...baseline.keys()];
  const local =
      cachedSourcePaths(root, retained) ??
      options.scan?.() ??
      scanSourcePaths(root, {
        retained,
        tree: options.record || options.refresh ? treeRecorder(root) : undefined,
      }),
    index = readCheckoutStatIndex(root),
    text = worktreeText(root, [...files]);
  for (const path of local) {
    if (changed.length >= limit) return changed;
    const old = baseline.get(path);
    if (!old) {
      changed.push(path);
      continue;
    }
    const absolute = join(root, path),
      stat = lstatSync(absolute);
    // A submodule checkout (the scanner returns a directory only for one) stands for its HEAD.
    if (stat.isDirectory()) {
      if (old.mode !== 'gitlink' || digest(gitlinkDirectoryPointer(root, path)) !== old.blob)
        changed.push(path);
      continue;
    }
    if (!stat.isSymbolicLink() && !stat.isFile()) {
      changed.push(path);
      continue;
    }
    const mode = stat.isSymbolicLink()
      ? 'symlink'
      : old.mode === 'gitlink'
        ? 'gitlink'
        : diskMode(stat, old.mode);
    // An exact stat-index match vouches for the bytes, a large file's too.
    if (mode === old.mode && indexedBlob(index, path, stat, old.blob)) {
      refresh.kept(path, stat, old.blob);
      continue;
    }
    if (!stat.isSymbolicLink() && stat.size > LARGE_FILE) {
      changed.push(path);
      continue;
    }
    const bytes = stat.isSymbolicLink()
      ? readlinkSync(absolute, { encoding: 'buffer' })
      : readFileSync(absolute);
    if (mode !== old.mode || !workingMatches(text, path, bytes, old.blob, mode)) changed.push(path);
    else refresh.read(path, stat, old.blob);
  }
  const present = new Set(local);
  for (const path of options.expected?.materialized ?? marker.materialized)
    if (changed.length < limit && !forgeCachePath(path) && !present.has(path)) changed.push(path);
  if (options.refresh && !changed.length) refresh.commit();
  return changed;
}
