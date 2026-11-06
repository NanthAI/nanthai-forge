// SPDX-License-Identifier: Apache-2.0
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { checkoutPathExists as exists } from './hosted-checkout-files.js';
import { syncDirectory } from './native-durability.js';
import { digest } from './hash.js';
import { nativeFile } from './native-file.js';
import { safeRelative } from './safe-relative.js';
import { invariant } from './errors.js';
const file = z.object({ path: z.string().refine(safeRelative), blob: z.string(), mode: z.string() });
const journalSchema = z.object({
  before: z.array(file),
  after: z.array(file),
  marker: z.string(),
  stage: z.string().regex(/^checkout-[a-zA-Z0-9]+$/),
});
function matches(root: string, expected: { path: string; blob: string; mode: string }) {
  try {
    if (lstatSync(join(root, expected.path)).isDirectory()) return false;
    const actual = nativeFile(root, expected.path);
    return digest(actual.bytes) === expected.blob && actual?.mode === expected.mode;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}
function sameInode(left: string, right: string) {
  if (!exists(left) || !exists(right)) return false;
  const a = lstatSync(left),
    b = lstatSync(right);
  return a.dev === b.dev && a.ino === b.ino;
}
function publishFile(from: string, to: string) {
  // Both files live on the checkout volume. A hard link publishes the independent
  // staged inode without overwriting a concurrently occupied destination.
  if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from, { encoding: 'buffer' }), to);
  else linkSync(from, to);
  syncDirectory(dirname(to));
  rmSync(from);
  syncDirectory(dirname(from));
}
function emptyDirectory(path: string) {
  if (!exists(path)) return;
  if (lstatSync(path).isDirectory()) {
    for (const name of readdirSync(path)) emptyDirectory(join(path, name));
    rmdirSync(path);
  } // Never recursively erase local artifacts.
}
function parents(root: string, path: string) {
  let current = root;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    if (!exists(current)) {
      mkdirSync(current);
      syncDirectory(dirname(current));
    }
    const stat = lstatSync(current);
    invariant(
      stat.isDirectory() && !stat.isSymbolicLink(),
      'WORK_CONFLICT',
      'A pull destination parent changed. Preserve the obstruction, then rerun the original nforge pull command.',
    );
  }
}
/** Recover a partial per-file publication written by an older client (publish.json) before
 * checkout validation; current clients publish through the shared delta journal
 * (hosted-checkout-delta.ts). A completed marker commits the tree; otherwise restore only our
 * changed paths from backup. Occupied paths with different bytes are never silently overwritten. */
export function recoverMainPublication(root: string, cache: string) {
  const path = join(cache, 'publish.json'),
    backup = join(cache, 'publish-backup');
  if (!exists(path)) return;
  const journal = journalSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  // A crash between exclusive publication and unlink leaves a private second
  // name for the same inode. Detach only names retained by this journal.
  for (const next of journal.after) {
    const staged = join(cache, journal.stage, next.path),
      target = join(root, next.path);
    if (sameInode(staged, target)) rmSync(staged);
  }
  for (const old of journal.before) {
    const saved = join(backup, old.path),
      target = join(root, old.path);
    if (
      sameInode(saved, target) ||
      (exists(saved) && lstatSync(saved).isSymbolicLink() && matches(backup, old) && matches(root, old))
    )
      rmSync(saved);
  }
  const marker = join(root, '.forge/hosted-main.json');
  if (!exists(marker) || readFileSync(marker, 'utf8') !== journal.marker) {
    const before = new Map(journal.before.map(item => [item.path, item]));
    // Remove installed new files before restoring file/directory transitions.
    for (const next of journal.after) {
      const target = join(root, next.path),
        old = before.get(next.path);
      if (matches(root, next)) rmSync(target);
      else if (exists(target) && !lstatSync(target).isDirectory())
        invariant(
          old &&
            matches(root, old) &&
            (!exists(join(backup, old.path)) || sameInode(target, join(backup, old.path))),
          'WORK_CONFLICT',
          `Local edits at ${JSON.stringify(next.path)} obstruct interrupted pull recovery. Preserve that file outside the checkout, then rerun nforge pull ROOT with the original operation.`,
        );
    }
    for (const old of journal.before) {
      const saved = join(backup, old.path),
        target = join(root, old.path);
      if (!exists(saved)) continue;
      if (sameInode(saved, target)) {
        rmSync(saved);
        continue;
      }
      emptyDirectory(target);
      invariant(
        !exists(target),
        'WORK_CONFLICT',
        `Local edits at ${JSON.stringify(old.path)} obstruct pull recovery. Preserve the file, then rerun the original nforge pull command.`,
      );
      parents(root, old.path);
      publishFile(saved, target);
      syncDirectory(dirname(target));
    }
  }
  rmSync(backup, { recursive: true, force: true });
  rmSync(join(cache, journal.stage), { recursive: true, force: true });
  rmSync(path);
  syncDirectory(cache);
}
