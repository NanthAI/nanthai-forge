// SPDX-License-Identifier: Apache-2.0
import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { NativeFile } from './native-state-format.js';
import { digest } from './hash.js';
import { ForgeError } from './errors.js';
import { durableReplace, syncDirectory } from './native-durability.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { readCheckoutStatIndex, statEntry, writeCheckoutStatIndex } from './checkout-stat-index.js';

/** One pending in-place apply per client cache; the work lock serializes writers. */
export const deltaJournalName = 'delta-apply.json';
/** Displaced bytes kept because they differed from their verified baseline; reported by every
 * later checkout result until the user removes them. */
export const deltaRetainedName = 'delta-retained.json';
const name = z.string().regex(/^delta-[A-Za-z0-9_-]+$/);
const relative = z
  .string()
  .min(1)
  .refine(
    path => !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..'),
  );
const pinned = z
  .object({ path: relative, blob: z.string(), mode: z.enum(['file', 'executable', 'symlink', 'gitlink']) })
  .strict();
const journalSchema = z
  .object({
    schema: z.literal(1),
    operationId: z.uuid(),
    stage: name,
    backup: name,
    marker: z.string().regex(/^[A-Za-z0-9._-]+$/),
    install: z.array(pinned),
    displace: z.array(pinned),
    directories: z.array(relative),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;
export type CheckoutDelta = { install: NativeFile[]; remove: NativeFile[] };

const ancestors = (files: readonly { path: string }[]) => {
  const directories = new Set<string>();
  for (const file of files)
    for (let i = file.path.indexOf('/'); i !== -1; i = file.path.indexOf('/', i + 1))
      directories.add(file.path.slice(0, i));
  return directories;
};
/** Changed paths between the installed materialized files and the target. Null when a path turns
 * from a file into a directory or back: that rare shape keeps the full private-stage install. */
export function checkoutDelta(
  prior: readonly NativeFile[],
  target: readonly NativeFile[],
): CheckoutDelta | null {
  const before = new Map(prior.map(file => [file.path, file])),
    after = new Set(target.map(file => file.path));
  const install = target.filter(file => {
    const old = before.get(file.path);
    return !old || old.blob !== file.blob || old.mode !== file.mode;
  });
  const remove = prior.filter(file => !after.has(file.path));
  if (!install.length && !remove.length) return { install, remove };
  const priorDirectories = ancestors(prior),
    targetDirectories = ancestors(target);
  if (
    install.some(file => priorDirectories.has(file.path)) ||
    remove.some(file => targetDirectories.has(file.path))
  )
    return null;
  return { install, remove };
}
/** Disk shapes the in-place install cannot take without moving untracked content: an incoming
 * path held by a directory, or an incoming parent held by a non-directory that is not replaced. */
export function deltaObstructed(root: string, delta: CheckoutDelta) {
  const removed = new Set(delta.remove.map(file => file.path));
  for (const file of delta.install) {
    const parts = file.path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join('/');
      let stat;
      try {
        stat = lstatSync(join(root, path));
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) break;
        throw error;
      }
      if (i === parts.length) {
        if (stat.isDirectory() && !stat.isSymbolicLink()) return path;
      } else if ((!stat.isDirectory() || stat.isSymbolicLink()) && !removed.has(path)) return path;
    }
  }
  return null;
}
function matches(path: string, file: z.infer<typeof pinned>) {
  const stat = lstatSync(path);
  const bytes = stat.isSymbolicLink()
    ? readlinkSync(path, { encoding: 'buffer' })
    : stat.isFile() && stat.nlink === 1
      ? readFileSync(path)
      : null;
  return Boolean(
    bytes &&
    digest(bytes) === file.blob &&
    (stat.isSymbolicLink()
      ? file.mode === 'symlink'
      : file.mode !== 'symlink' && Boolean(stat.mode & 0o111) === (file.mode === 'executable')),
  );
}
/** Journal an in-place install of a private, already durable stage. `displace` names every path
 * whose current bytes move aside, with the bytes the caller verified there. */
export function journalCheckoutDelta(
  cacheRoot: string,
  input: Omit<Journal, 'schema' | 'backup' | 'directories'> & { targetFiles: readonly { path: string }[] },
) {
  const { targetFiles, ...rest } = input,
    targetDirectories = ancestors(targetFiles),
    installed = new Set(rest.install.map(file => file.path));
  const directories = [...ancestors(rest.displace.filter(file => !installed.has(file.path)))].filter(
    path => !targetDirectories.has(path),
  );
  directories.sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a));
  const journal = journalSchema.parse({
    schema: 1,
    ...rest,
    backup: `delta-${randomUUID()}-displaced`,
    directories,
  });
  durableReplace(join(cacheRoot, deltaJournalName), JSON.stringify(journal));
  return journal;
}
const exists = checkoutPathExists;
/** Roll a journaled install forward. Idempotent at every rename boundary, so crash recovery and a
 * fresh apply run the same steps. A fresh apply that finds a displaced path changed since its check
 * restores every path before anything is installed and refuses, like the clean check. Displaced
 * bytes are kept unless all of them match their verified baseline. */
export function settleCheckoutDelta(root: string, cacheRoot: string, fresh = false): string | null {
  const journalPath = join(cacheRoot, deltaJournalName);
  if (!exists(journalPath)) return null;
  const journal = journalSchema.parse(JSON.parse(readFileSync(journalPath, 'utf8')));
  const stage = join(cacheRoot, journal.stage),
    backup = join(cacheRoot, journal.backup);
  const pending = new Set(
    journal.install.filter(file => exists(join(stage, file.path))).map(file => file.path),
  );
  const installing = new Set(journal.install.map(file => file.path));
  const touched = new Set<string>();
  for (const file of journal.displace) {
    if (installing.has(file.path) && !pending.has(file.path)) continue;
    const from = join(root, file.path),
      to = join(backup, file.path);
    if (exists(from) && !exists(to)) {
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      renameSync(from, to);
      touched.add(dirname(from));
    }
  }
  const changed = journal.displace.filter(
    file => exists(join(backup, file.path)) && !matches(join(backup, file.path), file),
  );
  if (changed.length && fresh && pending.size === journal.install.length) {
    for (const file of journal.displace) {
      const from = join(backup, file.path),
        to = join(root, file.path);
      if (exists(from) && !exists(to)) renameSync(from, to);
    }
    for (const directory of touched) syncDirectory(directory);
    rmSync(journalPath, { force: true });
    syncDirectory(cacheRoot);
    rmSync(stage, { recursive: true, force: true });
    if (!journal.displace.some(file => exists(join(backup, file.path))))
      rmSync(backup, { recursive: true, force: true });
    const file = changed[0]!;
    throw new ForgeError(
      'WORK_CONFLICT',
      `Local checkout changes at ${JSON.stringify(file.path)} are preserved.`,
      undefined,
      { obstruction: { path: file.path, kind: 'source-edit', expectedDigest: file.blob } },
    );
  }
  let retained = changed.length > 0;
  for (const file of journal.install) {
    if (!pending.has(file.path)) continue;
    const to = join(root, file.path);
    mkdirSync(dirname(to), { recursive: true });
    if (exists(to)) {
      // Recreated after an interruption: keep it beside the displaced bytes, never replace it.
      const spare = join(backup, 'occupied', randomUUID(), file.path);
      mkdirSync(dirname(spare), { recursive: true, mode: 0o700 });
      renameSync(to, spare);
      retained = true;
    }
    renameSync(join(stage, file.path), to);
    touched.add(dirname(to));
  }
  for (const directory of journal.directories)
    try {
      rmdirSync(join(root, directory));
      touched.add(dirname(join(root, directory)));
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
    }
  for (const directory of touched) if (exists(directory)) syncDirectory(directory);
  const marker = join(stage, '.forge', journal.marker);
  if (exists(marker)) {
    renameSync(marker, join(root, '.forge', journal.marker));
    syncDirectory(join(root, '.forge'));
  }
  // Unchanged entries keep vouching for unchanged inodes; installed ones are re-read once.
  const index = readCheckoutStatIndex(root);
  for (const file of journal.displace) index.entries.delete(file.path);
  for (const file of journal.install)
    try {
      index.entries.set(file.path, statEntry(lstatSync(join(root, file.path)), file.blob));
    } catch {
      index.entries.delete(file.path);
    }
  writeCheckoutStatIndex(root, index.since, index.entries);
  rmSync(journalPath, { force: true });
  syncDirectory(cacheRoot);
  rmSync(stage, { recursive: true, force: true });
  if (!retained) rmSync(backup, { recursive: true, force: true });
  else {
    const list = join(cacheRoot, deltaRetainedName),
      kept: string[] = exists(list) ? JSON.parse(readFileSync(list, 'utf8')) : [];
    if (!kept.includes(backup)) durableReplace(list, JSON.stringify([...kept, backup]));
  }
  return retained ? backup : null;
}
