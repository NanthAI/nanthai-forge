// SPDX-License-Identifier: Apache-2.0
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { checkoutPathExists as exists } from './hosted-checkout-files.js';
import { durableReplace, syncDirectory } from './native-durability.js';
import { digest } from './hash.js';
import { nativeFile } from './native-file.js';
import { safeRelative } from './safe-relative.js';
import { invariant } from './errors.js';
import type { NativeFile } from './native-state-format.js';
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
/** Recover a partial per-file publication before checkout validation. A completed
 * marker commits the tree; otherwise restore only our changed paths from backup.
 * Occupied paths with different bytes are never silently overwritten. */
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
/** Keep ROOT and all surviving directories in place. Stage and backup are local
 * regenerable data; the marker is published last and an interrupted apply rolls back. */
export function publishMainInPlace(
  root: string,
  cache: string,
  stage: string,
  before: NativeFile[],
  after: NativeFile[],
) {
  const old = new Map(before.map(item => [item.path, item]));
  const next = new Map(after.map(item => [item.path, item]));
  const changedBefore = before.filter(
    item => next.get(item.path)?.blob !== item.blob || next.get(item.path)?.mode !== item.mode,
  );
  const changedAfter = after.filter(
    item => old.get(item.path)?.blob !== item.blob || old.get(item.path)?.mode !== item.mode,
  );
  const backup = join(cache, 'publish-backup'),
    journal = join(cache, 'publish.json');
  const marker = readFileSync(join(stage, '.forge/hosted-main.json'), 'utf8');
  invariant(
    !exists(journal) && !exists(backup),
    'WORK_CONFLICT',
    'Resume the interrupted nforge pull before publishing another checkout.',
  );
  mkdirSync(backup);
  durableReplace(
    journal,
    JSON.stringify({ before: changedBefore, after: changedAfter, marker, stage: basename(stage) }),
  );
  try {
    for (const item of changedBefore) {
      parents(backup, item.path);
      renameSync(join(root, item.path), join(backup, item.path));
      syncDirectory(dirname(join(root, item.path)));
      syncDirectory(dirname(join(backup, item.path)));
      invariant(
        matches(backup, item),
        'WORK_CONFLICT',
        `Local edits at ${JSON.stringify(item.path)} changed during pull. They are restored; move edits into a Lane and rerun the original nforge pull command.`,
      );
    }
    for (const item of changedAfter) {
      const target = join(root, item.path);
      emptyDirectory(target);
      invariant(
        !exists(target),
        'WORK_CONFLICT',
        `Pull destination ${JSON.stringify(item.path)} changed. Preserve the obstruction and rerun nforge pull ROOT.`,
      );
      parents(root, item.path);
      publishFile(join(stage, item.path), target);
      syncDirectory(dirname(target));
    }
    durableReplace(join(root, '.forge/hosted-main.json'), marker);
    syncDirectory(root);
  } catch (error) {
    recoverMainPublication(root, cache);
    throw error;
  }
  recoverMainPublication(root, cache);
}
