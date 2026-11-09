// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { NativeFile } from './native-state-format.js';
import { digest } from './hash.js';
import { ForgeError } from './errors.js';
import { durableReplace } from './native-durability.js';
import { diskShapeMatches } from './source-links.js';

/** One pending in-place apply per client cache; the work lock serializes writers. */
export const deltaJournalName = 'delta-apply.json';
/** Displaced bytes kept because they differed from their verified baseline; reported by every
 * later checkout result until the user removes them. */
export const deltaRetainedName = 'delta-retained.json';
const name = z.string().regex(/^delta-[A-Za-z0-9_-]+$/);
const markerDigest = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .nullable();
const relative = z
  .string()
  .min(1)
  .refine(
    path => !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..'),
  );
const pinned = z
  .object({ path: relative, blob: z.string(), mode: z.enum(['file', 'executable', 'symlink', 'gitlink']) })
  .strict();
const fields = {
  operationId: z.uuid(),
  stage: name,
  backup: name,
  marker: z.string().regex(/^[A-Za-z0-9._-]+$/),
  install: z.array(pinned),
  displace: z.array(pinned),
  directories: z.array(relative),
};
/** Version 2 names the marker it replaces and the marker it publishes, so finishing never moves a
 * marker backwards or vouches for a tree it did not finish. `aborting` makes a decided rollback
 * resume as a rollback. Version 1 (no digests) is still finished, with the stage marker as target. */
/** A directory whose name changes only by case or Unicode normalization: `from` (its installed
 * spelling) moves to `temporary` in the same parent, then to `path`, so case-insensitive and
 * case-sensitive filesystems both end at the exact spelling. Shallowest first. */
const respellEntry = z
  .object({
    path: relative,
    from: relative,
    temporary: z.string().regex(/^\.forge-respell-[0-9a-f-]+$/),
  })
  .strict();
/** Version 3 adds `respell` (possibly empty): the apply changes a spelling, so paths are compared
 * by exact directory entry, never by what a case-insensitive lookup resolves. Version 2 journals
 * are still written for every other apply, so older clients keep finishing them. */
const journalSchema = z
  .object({
    schema: z.union([z.literal(2), z.literal(3)]),
    ...fields,
    priorMarker: markerDigest,
    targetMarker: markerDigest,
    aborting: z.literal(true).optional(),
    respell: z.array(respellEntry).optional(),
  })
  .strict()
  .refine(journal => (journal.schema === 3) === (journal.respell !== undefined));
const legacyJournalSchema = z.object({ schema: z.literal(1), ...fields }).strict();
export type DeltaJournal = z.infer<typeof journalSchema>;
export type DeltaPin = z.infer<typeof pinned>;
export type DeltaRespell = z.infer<typeof respellEntry>;
/** `respell` is set (possibly empty) when an incoming path differs from an installed one only by
 * spelling; it lists the directories to rename, shallowest first. */
export type CheckoutDelta = {
  install: NativeFile[];
  remove: NativeFile[];
  respell?: Omit<DeltaRespell, 'temporary'>[];
};

const ancestors = (files: readonly { path: string }[]) => {
  const directories = new Set<string>();
  for (const file of files)
    for (let i = file.path.indexOf('/'); i !== -1; i = file.path.indexOf('/', i + 1))
      directories.add(file.path.slice(0, i));
  return directories;
};
/** Spelling-insensitive identity: case-insensitive and normalization-insensitive filesystems
 * (default APFS, Windows) give these one directory entry. */
export const fold = (path: string) => path.normalize('NFC').toLowerCase();
const leaf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
/** Changed paths between the installed materialized files and the target. Without `transitions`
 * it is null when an incoming path or parent differs from an installed one only by case or Unicode
 * normalization, or when a path turns from a file into a directory or back: those rare shapes keep
 * the full private-stage install, which publishes the exact spelling. With `transitions` (the
 * clone root, which never swaps its directory) both apply in place: the old file moves aside
 * before the new directory is made, a directory emptied by removals goes before a file takes its
 * name, a file's new spelling installs after the old one moves aside, and a directory's new
 * spelling is a journaled rename (`respell`). Only an ambiguous spelling (two installed or two
 * target paths sharing one folded name) still returns null. */
export function checkoutDelta(
  prior: readonly NativeFile[],
  target: readonly NativeFile[],
  options: { transitions?: boolean } = {},
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
    !options.transitions &&
    (install.some(file => priorDirectories.has(file.path)) ||
      remove.some(file => targetDirectories.has(file.path)))
  )
    return null;
  const spelled = new Map<string, string>(),
    ambiguous = new Set<string>();
  for (const path of [...before.keys(), ...priorDirectories]) {
    const key = fold(path),
      seen = spelled.get(key);
    if (seen !== undefined && seen !== path) ambiguous.add(key);
    spelled.set(key, path);
  }
  let respell: CheckoutDelta['respell'];
  const claimed = new Map<string, string>();
  for (const path of [...install.map(file => file.path), ...ancestors(install)]) {
    const key = fold(path),
      installed = spelled.get(key);
    if (installed === undefined || installed === path) continue;
    // The old spelling must leave the target entirely and name exactly one installed path.
    if (
      !options.transitions ||
      ambiguous.has(key) ||
      after.has(installed) ||
      targetDirectories.has(installed) ||
      (claimed.get(key) ?? path) !== path
    )
      return null;
    claimed.set(key, path);
    respell ??= [];
    if (priorDirectories.has(installed) && targetDirectories.has(path) && leaf(installed) !== leaf(path))
      respell.push({ path, from: installed });
  }
  respell?.sort(
    (a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path),
  );
  return respell ? { install, remove, respell } : { install, remove };
}
/** Whether `path` exists under exactly this spelling, component by component, as directory
 * entries list it (a case-insensitive lookup would also find another spelling). Listings are
 * cached for one snapshot; create a new checker after changing the tree. */
export function spelledExactly(root: string) {
  const listed = new Map<string, Set<string> | null>();
  const names = (directory: string) => {
    if (!listed.has(directory))
      try {
        listed.set(directory, new Set(readdirSync(join(root, directory))));
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        listed.set(directory, null);
      }
    return listed.get(directory);
  };
  return (path: string) => {
    const parts = path.split('/');
    return parts.every((part, i) => Boolean(names(parts.slice(0, i).join('/'))?.has(part)));
  };
}
/** True when every non-directory under `path` is a removed source file, so the removals leave
 * only empty directories there (a file-to-directory flip in reverse). */
function emptiedBy(root: string, path: string, removed: (path: string) => boolean): boolean {
  for (const name of readdirSync(join(root, path))) {
    const child = `${path}/${name}`,
      stat = lstatSync(join(root, child));
    if (stat.isDirectory() && !stat.isSymbolicLink() ? !emptiedBy(root, child, removed) : !removed(child))
      return false;
  }
  return true;
}
/** Disk shapes the in-place install cannot take without moving untracked content: an incoming
 * path held by a directory that the removals do not empty, or an incoming parent held by a
 * non-directory that is not replaced. A case-insensitive lookup of a respelled path finds the old
 * spelling, which counts as removed. */
export function deltaObstructed(root: string, delta: CheckoutDelta) {
  const exact = new Set(delta.remove.map(file => file.path)),
    folded = delta.respell ? new Set(delta.remove.map(file => fold(file.path))) : null;
  const removed = (path: string) => exact.has(path) || Boolean(folded?.has(fold(path)));
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
        if (stat.isDirectory() && !stat.isSymbolicLink() && !emptiedBy(root, path, removed)) return path;
      } else if ((!stat.isDirectory() || stat.isSymbolicLink()) && !removed(path)) return path;
    }
  }
  return null;
}
/** Exact bytes and mode of one path, never following a link or a second name of the inode. */
export function deltaMatches(path: string, file: DeltaPin) {
  const stat = lstatSync(path);
  const bytes = stat.isSymbolicLink()
    ? readlinkSync(path, { encoding: 'buffer' })
    : stat.isFile() && stat.nlink === 1
      ? readFileSync(path)
      : null;
  return Boolean(bytes && digest(bytes) === file.blob && diskShapeMatches(stat, file.mode));
}
/** Every path whose current bytes move aside, pinned to the bytes the caller verified there:
 * removed files and incoming paths a file or link already holds (its prior blob, or the incoming
 * one for a path the baseline did not have). A directory at an incoming path is emptied by the
 * removals instead (see deltaObstructed), never moved. */
export function deltaDisplacement(root: string, delta: CheckoutDelta, prior: readonly NativeFile[]) {
  const before = new Map(prior.map(file => [file.path, file]));
  // A new spelling is held only by an entry of exactly that name, never by the old spelling a
  // case-insensitive lookup resolves to (that one moves aside as a removal).
  const spelled = delta.respell ? spelledExactly(root) : null;
  const held = (path: string) => {
    if (spelled && !before.has(path) && !spelled(path)) return false;
    try {
      const stat = lstatSync(join(root, path));
      return !stat.isDirectory() || stat.isSymbolicLink();
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
  };
  return [
    ...delta.remove,
    ...delta.install.filter(file => held(file.path)).map(file => before.get(file.path) ?? file),
  ].map(({ path, blob, mode }) => ({ path, blob, mode }));
}
/** Journal an in-place install of a private, already durable stage. `displace` names every path
 * whose current bytes move aside, with the bytes the caller verified there. */
export function journalCheckoutDelta(
  cacheRoot: string,
  input: Omit<DeltaJournal, 'schema' | 'backup' | 'directories' | 'aborting'> & {
    targetFiles: readonly { path: string }[];
  },
) {
  const { targetFiles, ...rest } = input,
    targetDirectories = ancestors(targetFiles),
    installed = new Set(rest.install.map(file => file.path));
  // A directory emptied under a respelled parent is removed under the parent's new spelling.
  const deepest = [...(rest.respell ?? [])].reverse();
  const spelledNow = (path: string) => {
    const entry = deepest.find(item => path === item.from || path.startsWith(`${item.from}/`));
    return entry ? entry.path + path.slice(entry.from.length) : path;
  };
  const directories = [
    ...new Set([...ancestors(rest.displace.filter(file => !installed.has(file.path)))].map(spelledNow)),
  ].filter(path => !targetDirectories.has(path));
  directories.sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a));
  const journal = journalSchema.parse({
    schema: rest.respell ? 3 : 2,
    ...rest,
    backup: `delta-${randomUUID()}-displaced`,
    directories,
  });
  durableReplace(join(cacheRoot, deltaJournalName), JSON.stringify(journal));
  return journal;
}
/** The directory renames a journal carries: only those whose installed spelling is on disk and
 * whose new spelling is not yet a separate entry (on a case-sensitive filesystem an untracked
 * directory may already hold it; files then install into it and the old one is removed if
 * emptied). Undefined when the delta changes no spelling. */
export function deltaRespell(root: string, delta: CheckoutDelta): DeltaRespell[] | undefined {
  if (!delta.respell) return undefined;
  const spelled = spelledExactly(root);
  return delta.respell
    .filter(entry => spelled(entry.from) && !spelled(entry.path))
    .map(entry => ({ ...entry, temporary: `.forge-respell-${randomUUID()}` }));
}
/** Typed refusal for an untracked file or directory where the apply must install: nothing was
 * fetched or changed. */
export function deltaObstructionError(path: string) {
  return new ForgeError(
    'WORK_CONFLICT',
    `Local checkout content at ${JSON.stringify(path)} is preserved.`,
    undefined,
    { obstruction: { kind: 'extra-source', path } },
  );
}
export function writeDeltaJournal(cacheRoot: string, journal: DeltaJournal) {
  durableReplace(join(cacheRoot, deltaJournalName), JSON.stringify(journalSchema.parse(journal)));
}
/** Typed refusal for an interrupted apply that cannot finish here. The journal, its stage and any
 * moved-aside bytes are kept, so the same command finishes it once the cause is gone. */
export function deltaPendingError(reason: string, path: string, next: string) {
  return new ForgeError(
    'WORK_CONFLICT',
    `An interrupted local apply in this checkout cannot finish: ${reason} Nothing more was changed; the apply journal (.forge-client/${deltaJournalName}) and its staged files are kept. ${next}`,
    undefined,
    { obstruction: { kind: 'delta-apply-pending', path }, reason },
  );
}
export function readDeltaJournal(path: string): DeltaJournal {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    value = undefined;
  }
  const version = (value as { schema?: unknown } | undefined)?.schema;
  if (typeof version === 'number' && version > 3)
    throw new ForgeError(
      'CLI_UPGRADE_REQUIRED',
      `A newer nforge started an apply in this checkout (journal version ${version}). Update nforge, then rerun the command; the newer version finishes it.`,
    );
  const legacy = legacyJournalSchema.safeParse(value);
  if (legacy.success)
    return { ...legacy.data, schema: 2, priorMarker: null, targetMarker: null } satisfies DeltaJournal;
  const parsed = journalSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw deltaPendingError(
    'its journal is unreadable.',
    deltaJournalName,
    'Keep the checkout as it is and report this; recover-apply from a retained sync keeps your changed files and restores the baseline.',
  );
}
