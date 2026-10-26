// SPDX-License-Identifier: Apache-2.0
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  chmodSync,
  fsyncSync,
  type Stats,
  symlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readSyncJournal, syncApplication } from './native-sync-journal.js';
import { durableReplace, syncDirectory } from './native-durability.js';
import { NativeSource, type NativeFile } from './native-source.js';
import { safeRelative } from './files.js';
import { nativeFile } from './native-file.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
export type SyncTarget = { path: string; mode: NativeFile['mode']; blob?: string; bytes?: Buffer };
type Target = SyncTarget;
function stat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}
function prepareParents(root: string, path: string) {
  let directory = root;
  for (const part of path.split('/').slice(0, -1)) {
    directory = join(directory, part);
    const found = stat(directory);
    if (!found) {
      mkdirSync(directory, { mode: 0o700 });
      syncDirectory(dirname(directory));
    } else
      invariant(
        found.isDirectory() && !found.isSymbolicLink(),
        'SYNC_PATH_BLOCKED',
        `An untracked file blocks a synced directory: ${path}. Move it and sync again.`,
      );
  }
}
function removeFile(root: string, path: string) {
  const target = join(root, path),
    found = stat(target);
  if (found) {
    invariant(found.isFile() || found.isSymbolicLink(), 'UNSAFE_PATH', `Cannot replace ${path}.`);
    unlinkSync(target);
    syncDirectory(dirname(target));
  }
  const parts = path.split('/');
  for (let index = parts.length - 1; index > 0; index--) {
    const directory = join(root, ...parts.slice(0, index));
    if (!stat(directory)?.isDirectory() || readdirSync(directory).length) break;
    rmdirSync(directory);
    syncDirectory(dirname(directory));
  }
}
/** Fault-injection points for crash-safety tests; unset in normal use. */
export const syncTestHooks: {
  beforeWorkspace?: () => void;
  afterWorkspace?: () => void;
  afterRemove?: () => void;
  duringWrite?: (fd: number) => void;
  afterReplace?: () => void;
  afterPlan?: () => void;
} = {};
export const syncFileKey = (file?: Target) =>
  file ? `${file.bytes ? digest(file.bytes) : file.blob}:${file.mode}` : undefined;
/** Move the Lane workspace from `from` (its recorded head) to `to`. Every path must
 * already hold either version, so an interrupted earlier sync resumes safely and
 * anything else is an uncheckpointed edit. Files are written before metadata. */
export function syncWorkspace(
  source: NativeSource,
  root: string,
  head: string,
  from: NativeFile[],
  to: Target[],
  owner?: { current: NativeFile[]; resuming: boolean },
) {
  root = resolve(root);
  invariant(
    [...from, ...to].every(file => safeRelative(file.path)),
    'UNSAFE_PATH',
    'Synced paths must be relative.',
  );
  const name = owner ? 'work/owner-root-apply.json' : 'workspace-sync.json';
  const journal = join(root, '.forge', name),
    signature = digest(
      JSON.stringify({ head, from, to: to.map(file => ({ path: file.path, key: syncFileKey(file) })) }),
    ),
    prior = readSyncJournal(root, name, syncApplication),
    resuming = prior?.signature === signature,
    current = new Map(
      (owner?.current ?? source.capture(root, false, head)).map(file => [file.path, syncFileKey(file)]),
    ),
    before = new Map(from.map(file => [file.path, syncFileKey(file)])),
    after = new Map(to.map(file => [file.path, file]));
  // New tracked files may be hidden by a just-synced ignore rule. Validate
  // their actual bytes as well, rather than treating an ignored file as absent.
  for (const file of to) {
    if (current.has(file.path)) continue;
    const found = stat(join(root, file.path));
    if (!found || (!found.isFile() && !found.isSymbolicLink())) continue;
    const { bytes, mode } = nativeFile(root, file.path);
    current.set(file.path, `${digest(bytes)}:${mode}`);
  }
  const paths = [...new Set([...current.keys(), ...before.keys(), ...after.keys()])];
  invariant(
    paths.every(
      path =>
        (owner && !owner.resuming
          ? before.get(path) === current.get(path)
          : [before.get(path), syncFileKey(after.get(path))].includes(current.get(path))) ||
        (resuming && prior.removing.includes(path) && !current.has(path)),
    ),
    owner ? 'OWNER_ROOT_DIRTY' : 'LANE_DIRTY',
    owner
      ? 'Owner tracked files contain local edits; they were preserved.'
      : 'The Lane has uncheckpointed edits. Checkpoint first, then sync.',
  );
  const removing = from.filter(file => !after.has(file.path)).map(file => file.path);
  if (!resuming) durableReplace(journal, JSON.stringify({ signature, removing }));
  syncTestHooks.afterPlan?.();
  syncTestHooks.beforeWorkspace?.();
  // Remove obsolete paths first, including file/directory transitions. The
  // durable plan makes their absence recognisable after any interruption.
  for (const path of removing) {
    if (current.has(path)) removeFile(root, path);
    syncTestHooks.afterRemove?.();
  }
  for (const file of to) {
    if (current.get(file.path) === syncFileKey(file)) continue;
    invariant(safeRelative(file.path), 'UNSAFE_PATH', 'Synced paths must be relative.');
    prepareParents(root, file.path);
    const target = join(root, file.path),
      found = stat(target);
    invariant(
      !found || (current.has(file.path) && (found.isFile() || found.isSymbolicLink())),
      'SYNC_PATH_BLOCKED',
      `Cannot replace ${file.path}.`,
    );
    // Staging stays on the workspace filesystem, excluded from source capture.
    const temporary = join(root, '.forge', `sync-content-${randomUUID()}.tmp`);
    if (file.mode === 'symlink') {
      symlinkSync(file.bytes ?? source.object(file.blob!), temporary);
    } else {
      const fd = openSync(temporary, 'wx', file.mode === 'executable' ? 0o700 : 0o600);
      try {
        syncTestHooks.duringWrite?.(fd);
        writeFileSync(fd, file.bytes ?? source.object(file.blob!));
        chmodSync(temporary, file.mode === 'executable' ? 0o700 : 0o600);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    renameSync(temporary, target);
    syncTestHooks.afterReplace?.();
  }
  // Also flush on replay when every file already matches: the previous
  // process may have died after rename but before directory publication.
  const directories = new Set([root, join(root, '.forge')]);
  for (const path of paths) {
    let directory = dirname(join(root, path));
    while (directory !== root) {
      const found = stat(directory);
      if (found?.isDirectory() && !found.isSymbolicLink()) directories.add(directory);
      directory = dirname(directory);
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) syncDirectory(directory);
  syncTestHooks.afterWorkspace?.();
}
