// SPDX-License-Identifier: Apache-2.0
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ForgeError, invariant } from './errors.js';

/** A checked-out submodule at a saved source path: a real directory holding `.git`
 * (a directory or a `gitdir:` file). Scanners treat it as one opaque leaf, as Git does. */
export function gitlinkDirectory(root: string, path: string): boolean {
  try {
    const stat = lstatSync(join(root, path));
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const git = lstatSync(join(root, path, '.git'));
    return (git.isDirectory() && !git.isSymbolicLink()) || git.isFile();
  } catch {
    return false;
  }
}

/** Small private read that never follows a final link and never blocks on a special file. */
function readSmall(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    invariant(
      stat.isFile() && stat.size <= limit,
      'INVALID_GITLINK',
      'Submodule Git metadata is not a small file.',
    );
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!read) break;
      offset += read;
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The Git directory of a submodule checkout: `.git` itself, or the target of a `gitdir:` file. */
export function gitlinkGitDirectory(root: string, path: string): string {
  const directory = join(root, path),
    dotGit = join(directory, '.git'),
    stat = lstatSync(dotGit);
  if (stat.isDirectory() && !stat.isSymbolicLink()) return dotGit;
  const match = /^gitdir: (.+?)\r?\n?$/.exec(readSmall(dotGit, 4096));
  invariant(match, 'INVALID_GITLINK', `Submodule ${path} has an unreadable .git file.`);
  return isAbsolute(match[1]!) ? match[1]! : resolve(directory, match[1]!);
}

/** The pointer bytes a submodule checkout stands for, read inertly from its HEAD (the full
 * commit SHA, the same bytes a pointer file holds). No Git command or repository code runs.
 * A branch checkout refuses: the saved pointer is the commit a detached HEAD names, as in a
 * superproject's `git submodule update`. */
export function gitlinkDirectoryPointer(root: string, path: string): Buffer {
  let head: string;
  try {
    head = readSmall(join(gitlinkGitDirectory(root, path), 'HEAD'), 4096);
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw new ForgeError(
      'INVALID_GITLINK',
      `Submodule ${path} has no readable HEAD. Restore it (git -C ${path} checkout --detach <commit>) or replace the directory with a file holding the commit SHA.`,
    );
  }
  const symbolic = /^ref:\s*(\S+)/.exec(head);
  if (symbolic)
    throw new ForgeError(
      'SUBMODULE_HEAD_SYMBOLIC',
      `Submodule ${path} has branch ${symbolic[1]} checked out. Forge saves the commit a detached HEAD names: run git -C ${path} checkout --detach, then save again.`,
      undefined,
      { path, ref: symbolic[1] },
    );
  invariant(
    /^[0-9a-f]{40}(?:[0-9a-f]{24})?\n?$/.test(head),
    'INVALID_GITLINK',
    `Submodule ${path} HEAD does not name a full commit SHA.`,
  );
  return Buffer.from(head.trimEnd());
}
