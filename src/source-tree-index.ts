// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { IndexEntry } from './work-hosted-index.js';
/** Paths only, pinned to an immutable State; source bytes remain on-demand reads. */
export function sourceTreeEntries(
  head: string,
  files: readonly { path: string; mode?: string }[],
  pathsPerRow = 100,
): IndexEntry[] {
  const paths = files.map(file => file.path).sort();
  const entries: IndexEntry[] = [];
  for (let offset = 0; offset < paths.length; offset += pathsPerRow)
    entries.push({
      collection: 'sourceTreePaths',
      key: `${head}:${offset}`,
      parent: head,
      position: offset,
      value: JSON.stringify({ paths: paths.slice(offset, offset + pathsPerRow) }),
    });
  entries.push({
    collection: 'sourceTrees',
    key: head,
    parent: '',
    position: 0,
    value: JSON.stringify({
      head,
      files: paths.length,
      ...(files.some(file => file.mode === 'gitlink')
        ? { submodules: files.filter(file => file.mode === 'gitlink').length }
        : {}),
    }),
  });
  return entries;
}
