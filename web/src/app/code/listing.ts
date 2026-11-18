// SPDX-License-Identifier: Apache-2.0
// The folders one tab has listed at one exact State (Item a3b55a6e). A folder read brings its subfolders' first pages
// (src/code-tree.ts withChildren), so a folder the reader can see opens from here with no read; opening it asks once,
// in the background, for the level below. States never change, so nothing here expires during the visit.
import type { CodeDir } from './code-data';

export type Listing = { dirs: Map<string, CodeDir>; ahead: Set<string> };

/** Keeps a reply's folders. `append` is the folder a "show more" page extends; any other folder already listed is
 * kept as it is (it may hold more pages than a subfolder preview). */
export function keepListing(
  listing: Listing,
  reply: { dirs?: readonly CodeDir[]; ahead?: string },
  append?: string,
) {
  for (const dir of reply.dirs ?? []) {
    const was = listing.dirs.get(dir.path);
    if (dir.path === append && was)
      listing.dirs.set(dir.path, { ...dir, entries: [...was.entries, ...dir.entries] });
    else if (!was) listing.dirs.set(dir.path, dir);
  }
  if (reply.ahead !== undefined) listing.ahead.add(reply.ahead);
}

/** What opening `dir` needs: nothing, a background read of the level below, or a read before it can show. */
export function listingNeed(listing: Listing, dir: string): 'none' | 'ahead' | 'read' {
  return !listing.dirs.has(dir) ? 'read' : listing.ahead.has(dir) ? 'none' : 'ahead';
}
