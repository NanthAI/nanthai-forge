// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { forgeCachePath } from './forge-cache-paths.js';
import { digest } from './hash.js';
import { nativePaths } from './source-paths.js';

const LARGE_FILE = 256 * 1024 * 1024;
/** True when the checkout differs from its saved baseline, or when that cannot be established.
 * Read-only and local: it hashes files in place and writes nothing, unlike a save capture. */
export function hostedLaneDirty(root: string): boolean {
  try {
    const marker = readHostedLaneCheckout(root);
    if (!marker) return true;
    const baseline = new Map(marker.state.files.map(file => [file.path, file]));
    const local = nativePaths(root, [...baseline.keys()]);
    for (const path of local) {
      const old = baseline.get(path);
      if (!old) return true;
      const absolute = join(root, path),
        stat = lstatSync(absolute);
      if (!stat.isSymbolicLink() && (!stat.isFile() || stat.size > LARGE_FILE)) return true;
      const mode = stat.isSymbolicLink()
        ? 'symlink'
        : old.mode === 'gitlink'
          ? 'gitlink'
          : stat.mode & 0o111
            ? 'executable'
            : 'file';
      const bytes = stat.isSymbolicLink()
        ? readlinkSync(absolute, { encoding: 'buffer' })
        : readFileSync(absolute);
      if (mode !== old.mode || digest(bytes) !== old.blob) return true;
    }
    const present = new Set(local);
    return marker.materialized.some(path => !forgeCachePath(path) && !present.has(path));
  } catch {
    return true;
  }
}
