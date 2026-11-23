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
/** The exact side of a changed file: its blob and mode, or null where it does not exist. */
export type CodeSide = { blob: string; mode: string } | null;
/** `before` and `after` are present only for a signed-in member's read: the reader can draw the file's diff from
 * them, which a signed-out visitor cannot. */
export type CodeChange = {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  before?: CodeSide;
  after?: CodeSide;
};

type Path = { path: string; mode: string };
const kindOf = (mode: string): CodeEntry['kind'] =>
  mode === 'symlink' ? 'symlink' : mode === 'gitlink' ? 'submodule' : 'file';

function lowerBound(paths: readonly Path[], path: string, start = 0, end = paths.length) {
  while (start < end) {
    const middle = start + Math.floor((end - start) / 2);
    if (paths[middle]!.path < path) start = middle + 1;
    else end = middle;
  }
  return start;
}

export function fileAt<T extends Path>(paths: readonly T[], path: string): T | undefined {
  const entry = paths[lowerBound(paths, path)];
  return entry?.path === path ? entry : undefined;
}

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
  const folders: CodeEntry[] = [];
  const files: CodeEntry[] = [];
  const startAt = dir ? lowerBound(paths, prefix) : 0;
  // '0' immediately follows '/' in the State's path order, so this excludes lookalike names.
  const endAt = dir ? lowerBound(paths, `${dir}0`, startAt) : paths.length;
  for (let index = startAt; index < endAt;) {
    const { path, mode } = paths[index]!;
    const cut = path.indexOf('/', prefix.length);
    if (cut === -1) {
      files.push({ name: path.slice(prefix.length), path, kind: kindOf(mode) });
      index++;
    } else {
      const child = path.slice(0, cut);
      const end = lowerBound(paths, `${child}0`, index + 1, endAt);
      folders.push({ name: child.slice(prefix.length), path: child, kind: 'dir', files: end - index });
      index = end;
    }
  }
  // Prefix folders can be encountered in a different order than their bare names (a!/ then a/).
  folders.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const total = folders.length + files.length;
  const start = Math.max(0, Math.min(cursor, total));
  const end = Math.min(total, start + limit);
  return {
    path: dir,
    entries: [
      ...folders.slice(start, end),
      ...files.slice(Math.max(0, start - folders.length), Math.max(0, end - folders.length)),
    ],
    total,
    next: end < total ? end : null,
  };
}

/** Bytes of subfolder pages one folder read may add (Item a3b55a6e): the folders a reader can open next. */
export const CODE_AHEAD_BYTES = 64 * 1024;
const utf8 = new TextEncoder();

/**
 * `page`, then the first page of each folder it lists, in order, while those pages fit `budget` bytes. A reader who
 * opens one of them needs no read; one level only, so the tree is still read one folder at a time, never whole.
 */
export function withChildren(paths: readonly Path[], page: CodeDir, budget = CODE_AHEAD_BYTES): CodeDir[] {
  const out = [page];
  let used = 0;
  for (const entry of page.entries) {
    if (entry.kind !== 'dir') continue;
    const child = folderPage(paths, entry.path);
    used += utf8.encode(JSON.stringify(child)).length;
    if (used > budget) break;
    out.push(child);
  }
  return out;
}

/** What a path names in this State: a file (with its mode), a folder, or nothing. */
export function pathKind(paths: readonly Path[], path: string): 'dir' | 'file' | null {
  if (!path) return 'dir';
  if (fileAt(paths, path)) return 'file';
  const prefix = `${path}/`;
  return paths[lowerBound(paths, prefix)]?.path.startsWith(prefix) ? 'dir' : null;
}

/** The paths one landing changed, in path order, at most one page. `sides` adds each file's before and after blob. */
export function changedPaths(
  paths: readonly { path: string; status: string; before?: CodeSide; after?: CodeSide }[],
  limit = CODE_CHANGES_PAGE,
  sides = false,
): { changes: CodeChange[]; total: number } {
  const changed = paths.filter(path => path.status !== 'unchanged') as CodeChange[];
  const side = (value: CodeSide | undefined): CodeSide =>
    value ? { blob: value.blob, mode: value.mode } : null;
  return {
    changes: changed
      .slice(0, limit)
      .map(({ path, status, before, after }) =>
        sides ? { path, status, before: side(before), after: side(after) } : { path, status },
      ),
    total: changed.length,
  };
}
