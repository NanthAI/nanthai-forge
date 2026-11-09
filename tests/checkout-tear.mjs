// SPDX-License-Identifier: Apache-2.0
import { lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCheckoutStatIndex, writeCheckoutStatIndex, statEntry } from '../dist/checkout-stat-index.js';

/** A system crash's torn file: new bytes of the same length while the stat index still records
 * the file's current metadata (a crash loses data, not the install's own record of it). */
export function tearInstalled(root, torn) {
  const index = readCheckoutStatIndex(root);
  for (const [path, bytes] of Object.entries(torn)) {
    const entry = index.entries.get(path);
    if (!entry) throw Error(`${path} is not indexed`);
    writeFileSync(join(root, path), bytes);
    index.entries.set(path, statEntry(lstatSync(join(root, path)), entry[5]));
  }
  writeCheckoutStatIndex(root, index.since, index.entries);
}
