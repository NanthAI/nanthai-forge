// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { forgeCachePath } from './forge-cache-paths.js';
import { digest } from './hash.js';
import { gitlinkDirectoryPointer } from './gitlink-workspace.js';
import { nativePaths } from './source-paths.js';
import { indexedBlob, readCheckoutStatIndex, statIndexRefresh } from './checkout-stat-index.js';
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
export function hostedLaneDirty(root: string, options: { refresh?: boolean } = {}): boolean {
  try {
    if (deltaApplyPending(root)) return true;
    const marker = readHostedLaneCheckout(root);
    if (!marker) return true;
    const baseline = new Map(marker.state.files.map(file => [file.path, file]));
    const refresh = statIndexRefresh(root);
    const local = nativePaths(root, [...baseline.keys()]),
      index = readCheckoutStatIndex(root),
      text = worktreeText(root, marker.state.files);
    for (const path of local) {
      const old = baseline.get(path);
      if (!old) return true;
      const absolute = join(root, path),
        stat = lstatSync(absolute);
      // A submodule checkout (the scanner returns a directory only for one) stands for its HEAD.
      if (stat.isDirectory()) {
        if (old.mode !== 'gitlink' || digest(gitlinkDirectoryPointer(root, path)) !== old.blob) return true;
        continue;
      }
      if (!stat.isSymbolicLink() && (!stat.isFile() || stat.size > LARGE_FILE)) return true;
      const mode = stat.isSymbolicLink()
        ? 'symlink'
        : old.mode === 'gitlink'
          ? 'gitlink'
          : diskMode(stat, old.mode);
      if (mode === old.mode && indexedBlob(index, path, stat, old.blob)) {
        refresh.kept(path, stat, old.blob);
        continue;
      }
      const bytes = stat.isSymbolicLink()
        ? readlinkSync(absolute, { encoding: 'buffer' })
        : readFileSync(absolute);
      if (mode !== old.mode || !workingMatches(text, path, bytes, old.blob, mode)) return true;
      refresh.read(path, stat, old.blob);
    }
    const present = new Set(local);
    if (marker.materialized.some(path => !forgeCachePath(path) && !present.has(path))) return true;
    if (options.refresh) refresh.commit();
    return false;
  } catch {
    return true;
  }
}
