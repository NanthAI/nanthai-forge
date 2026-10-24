// SPDX-License-Identifier: Apache-2.0
import type { IndexEntry } from './work-hosted-index.js';
/** Paths only, pinned to an immutable State; source bytes remain on-demand reads. */
export function sourceTreeEntries(head: string, files: readonly { path: string }[]): IndexEntry[] {
  const paths = files.map(file => file.path).sort();
  const entries: IndexEntry[] = [];
  for (let offset = 0; offset < paths.length; offset += 100)
    entries.push({
      collection: 'sourceTreePaths',
      key: `${head}:${offset}`,
      parent: head,
      position: offset,
      value: JSON.stringify({ paths: paths.slice(offset, offset + 100) }),
    });
  entries.push({
    collection: 'sourceTrees',
    key: head,
    parent: '',
    position: 0,
    value: JSON.stringify({ head, files: paths.length }),
  });
  return entries;
}
