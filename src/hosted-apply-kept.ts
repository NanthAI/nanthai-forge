// SPDX-License-Identifier: Apache-2.0
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ForgeError, invariant } from './errors.js';
import { digest } from './hash.js';
import { retainedRootSibling } from './root-paths.js';
import { syncDirectory, syncFile } from './state/durability.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import type { CheckoutChange } from './hosted-checkout-clean.js';
import type { NativeFile } from './state/format.js';
import { diskShapeMatches, writeSourceLink } from './source-links.js';

/** Local changes an explicit recover-apply set aside are kept this long after the apply is confirmed. */
export const KEPT_APPLY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Entries listed in one status read. */
const LISTED = 20;
const PATHS_SHOWN = 20;

/** Lives in the outermost client cache, so evicting a nested Lane copy never removes it, and nothing
 * is created beside the project root. */
export const keptApplyRoot = (root: string) => join(retainedRootSibling(root, '.forge-client'), 'kept-apply');

export const keptEntrySchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(['edited', 'extra', 'deleted']),
    /** Digest of the bytes kept, or null when nothing was copied for this path. */
    digest: z.string().nullable(),
  })
  .strict();
export type KeptEntry = z.infer<typeof keptEntrySchema>;

/** A kept path is relative, forward-slashed and never climbs out of its round folder. */
export function safeRelative(path: string) {
  invariant(
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.includes('\0')),
    'UNSAFE_PATH',
    'A kept path must stay inside its folder.',
  );
  return path;
}

const real = (path: string) => {
  const stat = lstatSync(path);
  return stat.isDirectory() && !stat.isSymbolicLink();
};
function copyOne(live: string, destination: string): string {
  const stat = lstatSync(live);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(live, { encoding: 'buffer' });
    writeSourceLink(readlinkSync(live), destination);
    return digest(target);
  }
  invariant(
    stat.isFile(),
    'UNSAFE_PATH',
    'A local change is neither a regular file nor a link. Move it out of the checkout, then recover again.',
  );
  const bytes = readFileSync(live);
  writeFileSync(destination, bytes, { mode: stat.mode & 0o777 });
  syncFile(destination);
  return digest(bytes);
}
function walk(root: string, prefix: string, out: string[]) {
  for (const name of readdirSync(join(root, prefix))) {
    const path = `${prefix}/${name}`,
      stat = lstatSync(join(root, path));
    if (stat.isDirectory() && !stat.isSymbolicLink()) walk(root, path, out);
    else out.push(path);
  }
}

/** Copy only the changed paths into `round` (a folder that mirrors checkout paths) and describe every
 * path the apply would overwrite or remove. Deleted baseline files keep no bytes: the baseline has them.
 * A directory standing where a saved file belongs is kept file by file. Idempotent. */
export function preserveChanges(
  root: string,
  round: string,
  changes: readonly CheckoutChange[],
): KeptEntry[] {
  mkdirSync(round, { recursive: true, mode: 0o700 });
  const entries: KeptEntry[] = [],
    made = new Set<string>([round]);
  const keep = (path: string, kind: KeptEntry['kind']) => {
    safeRelative(path);
    const destination = join(round, path);
    entries.push({ path, kind, digest: copyOne(join(root, path), destination) });
    for (let at = dirname(destination); at.length >= round.length; at = dirname(at)) made.add(at);
  };
  for (const change of changes) {
    safeRelative(change.path);
    if (change.kind === 'deleted') {
      entries.push({ path: change.path, kind: 'deleted', digest: null });
      continue;
    }
    if (change.kind === 'edited' && real(join(root, change.path))) {
      const inside: string[] = [];
      walk(root, change.path, inside);
      entries.push({ path: change.path, kind: 'edited', digest: null });
      for (const path of inside) keep(path, 'extra');
      continue;
    }
    keep(change.path, change.kind);
  }
  for (const directory of made) syncDirectory(directory);
  return entries;
}

function filesUnder(root: string, path: string, out: string[]) {
  const stat = lstatSync(join(root, path));
  if (stat.isDirectory() && !stat.isSymbolicLink())
    for (const name of readdirSync(join(root, path))) filesUnder(root, `${path}/${name}`, out);
  else out.push(path);
}
/** Local content inside a misplaced legacy read-cache folder (`.forge-client`, `..forge-client`). Those
 * folders are ignored as caches, but anything in them other than verified-looking objects is somebody's
 * file, and a nested Lane copy is evicted whole. Returned as extra files so recovery keeps them. */
export function misplacedCacheContent(root: string, files: readonly { path: string }[]): CheckoutChange[] {
  const found: string[] = [];
  for (const name of ['.forge-client', '..forge-client']) {
    if (files.some(file => file.path === name || file.path.startsWith(`${name}/`))) continue;
    let stat;
    try {
      stat = lstatSync(join(root, name));
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    for (const entry of readdirSync(join(root, name))) {
      const path = `${name}/${entry}`;
      const objects = entry === 'objects' ? lstatSync(join(root, path)) : null;
      if (!objects?.isDirectory() || objects.isSymbolicLink()) {
        filesUnder(root, path, found);
        continue;
      }
      for (const id of readdirSync(join(root, path))) {
        const object = lstatSync(join(root, path, id));
        if (!(/^[a-f0-9]{64}$/.test(id) && object.isFile() && object.nlink === 1))
          filesUnder(root, `${path}/${id}`, found);
      }
    }
  }
  return found.map(path => ({ path, kind: 'extra' as const }));
}

export type LiveState = 'kept' | 'baseline' | 'gone' | 'other';
/** Where one kept path stands now: unchanged since it was kept, already the baseline, absent, or edited
 * again (which starts another round instead of overwriting it). */
export function liveState(root: string, entry: KeptEntry, file: NativeFile | undefined): LiveState {
  let stat;
  try {
    stat = lstatSync(join(root, entry.path));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'gone';
    throw error;
  }
  if (stat.isDirectory() && !stat.isSymbolicLink())
    return entry.kind === 'edited' && !entry.digest ? 'kept' : 'other';
  const bytes = stat.isSymbolicLink()
    ? readlinkSync(join(root, entry.path), { encoding: 'buffer' })
    : stat.isFile()
      ? readFileSync(join(root, entry.path))
      : null;
  const seen = bytes ? digest(bytes) : null;
  if (seen && entry.digest && seen === entry.digest) return 'kept';
  if (seen && file && seen === file.blob && diskShapeMatches(stat, file.mode)) return 'baseline';
  return 'other';
}

function removeEmptyTree(path: string) {
  for (const name of readdirSync(path)) {
    const child = join(path, name),
      stat = lstatSync(child);
    if (stat.isDirectory() && !stat.isSymbolicLink()) removeEmptyTree(child);
  }
  rmdirSync(path);
}
const quietly = (code: unknown) => ['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(String(code));

/** Take the kept paths out of the live tree: extra files, then directories that stood where saved files
 * belong. Everything else, including ignored artifacts, stays. Throws ENOTEMPTY-style conflicts as
 * WORK_CONFLICT so the caller keeps another round. */
export function clearKept(root: string, entries: readonly KeptEntry[]) {
  const parents = new Set<string>();
  for (const entry of entries)
    if (entry.kind === 'extra') {
      rmSync(join(root, entry.path), { force: true });
      parents.add(dirname(entry.path));
    }
  for (const entry of entries)
    if (entry.kind === 'edited' && !entry.digest)
      try {
        if (checkoutPathExists(join(root, entry.path)) && real(join(root, entry.path)))
          removeEmptyTree(join(root, entry.path));
      } catch (error) {
        if (!quietly((error as NodeJS.ErrnoException).code)) throw error;
        throw new ForgeError(
          'WORK_CONFLICT',
          `Local content at ${JSON.stringify(entry.path)} changed again; it is preserved.`,
        );
      }
  // A folder left empty only by the removal above is not part of the baseline.
  for (const start of parents)
    for (let at = start; at && at !== '.'; at = dirname(at))
      try {
        rmdirSync(join(root, at));
      } catch (error) {
        if (!quietly((error as NodeJS.ErrnoException).code)) throw error;
        break;
      }
}

/** Move staged baseline files into the live tree one path at a time. Each rename is atomic, replaces a
 * file or link, and creates no state outside the changed paths. */
export function installBaseline(root: string, stage: string, files: readonly NativeFile[]) {
  const touched = new Set<string>();
  for (const file of files) {
    safeRelative(file.path);
    const target = join(root, file.path);
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = join(root, ...parts.slice(0, i));
      try {
        invariant(
          real(parent),
          'WORK_CONFLICT',
          `Local content at ${JSON.stringify(parts.slice(0, i).join('/'))} is preserved.`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(parent);
        touched.add(dirname(parent));
      }
    }
    renameSync(join(stage, file.path), target);
    touched.add(dirname(target));
  }
  for (const directory of touched) syncDirectory(directory);
}

const receiptShape = z
  .object({
    restored: z.boolean().optional(),
    confirmedAt: z.number().optional(),
    preservedAt: z.string().optional(),
    additionalPreservedAt: z.array(z.string()).optional(),
    rounds: z.record(z.string(), z.array(keptEntrySchema)).optional(),
    /** Found in a prior checkout after publication; kept until deleted, never swept by expiry. */
    held: z.boolean().optional(),
  })
  .passthrough();
export type KeptApplySummary = {
  id: string;
  directory: string;
  /** Epoch ms once the apply it belongs to was confirmed; absent until then. */
  confirmedAt?: number;
  /** Epoch ms after which a confirmed entry is removed; absent until confirmed. */
  expiresAt?: number;
  edited: number;
  extra: number;
  deleted: number;
  paths: { edited: string[]; extra: string[]; deleted: string[] };
  note: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function names(cache: string) {
  try {
    return readdirSync(cache).filter(name => uuid.test(name));
  } catch {
    return [];
  }
}
function summarize(cache: string, id: string): KeptApplySummary | null {
  const directory = join(cache, id);
  let receipt;
  try {
    if (!real(directory)) return null;
    receipt = receiptShape.parse(JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8')));
  } catch {
    return null;
  }
  const paths = { edited: [] as string[], extra: [] as string[], deleted: [] as string[] },
    counts = { edited: 0, extra: 0, deleted: 0 };
  for (const entries of Object.values(receipt.rounds ?? {}))
    for (const entry of entries) {
      counts[entry.kind]++;
      if (paths[entry.kind].length < PATHS_SHOWN) paths[entry.kind].push(entry.path);
    }
  return {
    id,
    directory,
    ...(receipt.confirmedAt
      ? { confirmedAt: receipt.confirmedAt, expiresAt: receipt.confirmedAt + KEPT_APPLY_TTL_MS }
      : {}),
    ...counts,
    paths,
    note: receipt.held
      ? 'Local bytes found in the previous checkout after an apply are kept here until you delete this folder. Copy back what you need.'
      : receipt.confirmedAt
        ? 'Your local changes are kept here until the expiry time. Copy back what you need.'
        : 'Your local changes are kept here until the apply is confirmed, then for seven days. Copy back what you need.',
  };
}

/** Status view: one small receipt read per kept entry, newest listing capped. No Convex calls. */
export function listKeptApply(root: string) {
  const cache = keptApplyRoot(root),
    all = names(cache),
    shown = all.slice(0, LISTED).flatMap(id => summarize(cache, id) ?? []);
  return { entries: shown, more: Math.max(0, all.length - LISTED) };
}

/** Sweep one client cache directory by path (used when its project root is gone). */
export function sweepKeptApplyCache(cache: string, now = Date.now()) {
  const directory = join(cache, 'kept-apply');
  for (const id of names(directory)) {
    const summary = summarize(directory, id);
    if (summary?.expiresAt && summary.expiresAt <= now)
      rmSync(summary.directory, { recursive: true, force: true });
  }
  try {
    rmdirSync(directory);
  } catch {
    /* Entries remain, or it is already gone. */
  }
}

/** Remove a client cache but leave kept local changes in place until their own retention ends. */
export function removeCachePreservingKept(cache: string) {
  let kept = false;
  try {
    kept = readdirSync(join(cache, 'kept-apply')).length > 0;
  } catch {
    kept = false;
  }
  if (!kept) return rmSync(cache, { recursive: true, force: true });
  for (const name of readdirSync(cache))
    if (name !== 'kept-apply') rmSync(join(cache, name), { recursive: true, force: true });
}

/** Remove entries whose confirmed apply is older than the TTL. Never touches an unconfirmed entry. */
export function sweepKeptApply(root: string, now = Date.now()): string[] {
  const cache = keptApplyRoot(root),
    removed: string[] = [];
  for (const id of names(cache)) {
    const summary = summarize(cache, id);
    if (summary?.expiresAt && summary.expiresAt <= now) {
      rmSync(summary.directory, { recursive: true, force: true });
      removed.push(id);
    }
  }
  return removed;
}

/** Added to a status read only when something is kept. Never throws: a damaged entry is skipped. */
export function keptApplyEnvelope(root: string) {
  try {
    const listing = listKeptApply(root);
    return listing.entries.length || listing.more ? { keptApply: listing } : {};
  } catch {
    return {};
  }
}
