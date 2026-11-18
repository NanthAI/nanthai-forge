// SPDX-License-Identifier: Apache-2.0
// The Code place's file tree, one folder at a time (convex/projectCodeBrowse.ts): the server reads the State's path
// list it already verifies for every source read and returns only the folders the reader opened, each with its
// subfolders' first pages, so the browser never downloads a whole State and the next folder opens without a read.
// Pure; shared by the server action, the web screen and their tests.

/** Entries per folder page, folders per reply (the opened path's ancestors) and changed paths per comparison. */
export const CODE_DIR_PAGE = 200;
export const CODE_DIR_DEPTH = 24;
export const CODE_CHANGES_PAGE = 300;
/** Landings one "which landings touched this file" read compares (the newest first). */
export const CODE_TOUCHED_PAIRS = 8;

export type CodeEntry = {
  name: string;
  path: string;
  kind: 'dir' | 'file' | 'symlink' | 'submodule';
  /** Files anywhere under a folder. */
  files?: number;
};
export type CodeDir = { path: string; entries: CodeEntry[]; total: number; next: number | null };
export type CodeChange = { path: string; status: 'added' | 'deleted' | 'modified' };

type Path = { path: string; mode: string };
const kindOf = (mode: string): CodeEntry['kind'] =>
  mode === 'symlink' ? 'symlink' : mode === 'gitlink' ? 'submodule' : 'file';

/** The folders on the way to `path`: '' first, then each parent; a folder path includes itself. */
export function ancestors(path: string, isDir: boolean): string[] {
  const parts = path ? path.split('/') : [];
  const upTo = isDir ? parts.length : parts.length - 1;
  const out = [''];
  for (let i = 1; i <= Math.min(upTo, CODE_DIR_DEPTH); i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

/** One page of one folder: folders first, then files, each by name. `paths` is sorted (the State's own order). */
export function folderPage(paths: readonly Path[], dir: string, cursor = 0, limit = CODE_DIR_PAGE): CodeDir {
  const prefix = dir ? `${dir}/` : '';
  const folders = new Map<string, number>();
  const files: CodeEntry[] = [];
  for (const { path, mode } of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const cut = rest.indexOf('/');
    if (cut === -1) files.push({ name: rest, path, kind: kindOf(mode) });
    else folders.set(rest.slice(0, cut), (folders.get(rest.slice(0, cut)) ?? 0) + 1);
  }
  const entries: CodeEntry[] = [
    ...[...folders.keys()]
      .sort()
      .map(name => ({ name, path: prefix + name, kind: 'dir' as const, files: folders.get(name)! })),
    ...files,
  ];
  const start = Math.max(0, Math.min(cursor, entries.length));
  const end = Math.min(entries.length, start + limit);
  return {
    path: dir,
    entries: entries.slice(start, end),
    total: entries.length,
    next: end < entries.length ? end : null,
  };
}

/** Bytes of subfolder pages one folder read may add (Item a3b55a6e): the folders a reader can open next. */
export const CODE_AHEAD_BYTES = 64 * 1024;

/**
 * `page`, then the first page of each folder it lists, in order, while those pages fit `budget` bytes. A reader who
 * opens one of them needs no read; one level only, so the tree is still read one folder at a time, never whole.
 */
export function withChildren(paths: readonly Path[], page: CodeDir, budget = CODE_AHEAD_BYTES): CodeDir[] {
  const prefix = page.path ? `${page.path}/` : '';
  const inside = prefix ? paths.filter(entry => entry.path.startsWith(prefix)) : paths;
  const out = [page];
  let used = 0;
  for (const entry of page.entries) {
    if (entry.kind !== 'dir') continue;
    const child = folderPage(inside, entry.path);
    used += JSON.stringify(child).length;
    if (used > budget) break;
    out.push(child);
  }
  return out;
}

/** What a path names in this State: a file (with its mode), a folder, or nothing. */
export function pathKind(paths: readonly Path[], path: string): 'dir' | 'file' | null {
  if (!path) return 'dir';
  const prefix = `${path}/`;
  for (const entry of paths) {
    if (entry.path === path) return 'file';
    if (entry.path.startsWith(prefix)) return 'dir';
  }
  return null;
}

/** The paths one landing changed, in path order, at most one page. */
export function changedPaths(
  paths: readonly { path: string; status: string }[],
  limit = CODE_CHANGES_PAGE,
): { changes: CodeChange[]; total: number } {
  const changed = paths.filter(path => path.status !== 'unchanged') as CodeChange[];
  return {
    changes: changed.slice(0, limit).map(({ path, status }) => ({ path, status })),
    total: changed.length,
  };
}
