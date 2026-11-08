// SPDX-License-Identifier: Apache-2.0
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { digest } from './hash.js';
import { ForgeError } from './errors.js';
import { durableReplace, syncDirectory } from './native-durability.js';
import { checkoutPathExists as exists } from './hosted-checkout-files.js';
import { readCheckoutStatIndex, statEntry, writeCheckoutStatIndex } from './checkout-stat-index.js';
import {
  deltaJournalName,
  deltaMatches as matches,
  deltaPendingError,
  deltaRetainedName,
  fold,
  readDeltaJournal,
  writeDeltaJournal,
  type DeltaJournal,
  type DeltaPin,
} from './hosted-checkout-delta.js';
import { exactly, parentOf, respellBack, respellForward } from './hosted-checkout-delta-respell.js';

export type DeltaSettlement = {
  outcome: 'published' | 'rolled-back';
  /** Kept moved-aside bytes that differed from their baseline (also listed in delta-retained.json). */
  retained: string[];
  /** Set when a local edit made the apply roll back: the checkout is its prior baseline plus that
   * edit, and the apply's own command refuses with it. */
  conflict?: ForgeError;
};
const rerun = 'Move it out of the checkout, then rerun the command.';
const fileDigest = (path: string) => (exists(path) ? digest(readFileSync(path)) : null);
/** A version 1 journal names no target digest; once its stage marker moved, the root marker of
 * the same operation is the published target. */
function legacyPublished(rootMarker: string, journal: DeltaJournal) {
  if (journal.priorMarker !== null || !exists(rootMarker)) return false;
  try {
    return JSON.parse(readFileSync(rootMarker, 'utf8')).operationId === journal.operationId;
  } catch {
    return false;
  }
}
/** Every touched path must resolve inside the checkout through real directories: a parent replaced
 * by a link or a file after an interruption is refused, never followed. */
function parentGuard(root: string) {
  const real = new Set<string>();
  return (path: string) => {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (real.has(parent)) continue;
      let stat;
      try {
        stat = lstatSync(join(root, parent));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw deltaPendingError(`${JSON.stringify(parent)} is no longer a real directory.`, parent, rerun);
      real.add(parent);
    }
  };
}
/** Durable list of kept displaced folders; entries the user already removed drop out. Reads never
 * write; an addition (under the work lock) also persists the pruning. */
export function retainedDeltaBackups(cacheRoot: string, add?: string): string[] {
  const list = join(cacheRoot, deltaRetainedName);
  let kept: string[] = [];
  try {
    const value: unknown = exists(list) ? JSON.parse(readFileSync(list, 'utf8')) : [];
    kept = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    kept = [];
  }
  const present = kept.filter(path => exists(path));
  if (!add) return present;
  if (!present.includes(add)) present.push(add);
  durableReplace(list, JSON.stringify(present));
  return present;
}
function syncAll(directories: Iterable<string>) {
  for (const directory of new Set(directories)) if (exists(directory)) syncDirectory(directory);
}
/** Directories holding kept bytes, so the retained list never points at unflushed names. */
const backupDirectories = (backup: string, journal: DeltaJournal) => [
  ...journal.displace.map(file => dirname(join(backup, file.path))).filter(path => exists(path)),
  backup,
];

/** Remove a directory tree that holds only directories; anything else stays and throws ENOTEMPTY.
 * Never follows a link. */
function removeEmptyTree(path: string) {
  for (const name of readdirSync(path)) {
    const child = join(path, name),
      stat = lstatSync(child);
    if (stat.isDirectory() && !stat.isSymbolicLink()) removeEmptyTree(child);
  }
  rmdirSync(path);
}
function removeEmptied(root: string, directory: string, track: (path: string) => void) {
  track(directory);
  try {
    rmdirSync(join(root, directory));
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw error;
  }
}

/** Finish or undo an interrupted (or this process's) in-place install, under the work lock.
 * - Root marker is the target: the install published; only bookkeeping remains.
 * - Root marker is the prior one and the stage is whole: roll forward. A local edit found before
 *   anything was installed restores every moved path and refuses, from any command.
 * - Stage marker missing, or a decided rollback: remove installed bytes that are exactly ours and
 *   restore moved-aside bytes; a later edit to an installed path refuses and keeps the journal.
 * - Any other marker: refuse and keep everything; finishing would vouch for unknown bytes.
 * `abort` (the clone root after an in-process failure) rolls an unpublished apply back now, so the
 * working tree is never left half-applied while no command runs. */
export function settleCheckoutDelta(
  root: string,
  cacheRoot: string,
  options: { abort?: boolean } = {},
): DeltaSettlement | null {
  const journalPath = join(cacheRoot, deltaJournalName);
  if (!exists(journalPath)) return null;
  const journal = readDeltaJournal(journalPath);
  const stage = join(cacheRoot, journal.stage),
    backup = join(cacheRoot, journal.backup),
    stageMarker = join(stage, '.forge', journal.marker),
    rootMarker = join(root, '.forge', journal.marker);
  const now = fileDigest(rootMarker),
    target =
      journal.targetMarker ?? fileDigest(stageMarker) ?? (legacyPublished(rootMarker, journal) ? now : null);
  const steps = { journal, journalPath, root, cacheRoot, stage, backup };
  let at = journal.operationId;
  try {
    if (now !== null && now === target) return finish(steps);
    if (journal.priorMarker !== null ? now !== journal.priorMarker : now === null)
      throw deltaPendingError(
        'the checkout marker changed after it started.',
        `.forge/${journal.marker}`,
        journal.marker === 'hosted-main.json'
          ? 'Copy out any edits you need, then nforge clone the project into a new directory.'
          : 'Copy out any edits you need, then open this Lane in a new directory (start or open with a path).',
      );
    if (options.abort || journal.aborting || !exists(stageMarker))
      return rollBack(steps, path => (at = path));
    return rollForward({ ...steps, stageMarker, rootMarker }, path => (at = path));
  } catch (error) {
    // A filesystem refusal names its path and keeps the journal; anything else is a defect.
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof ForgeError || typeof code !== 'string') throw error;
    throw deltaPendingError(
      `${code} at ${JSON.stringify(at)}.`,
      at,
      'Fix that path, then rerun the command.',
    );
  }
}
type Steps = {
  journal: DeltaJournal;
  journalPath: string;
  root: string;
  cacheRoot: string;
  stage: string;
  backup: string;
};
function rollForward(
  steps: Steps & { stageMarker: string; rootMarker: string },
  track: (path: string) => void,
): DeltaSettlement {
  const { journal, root, stage, backup } = steps;
  const guard = parentGuard(root);
  const pending = new Set(
    journal.install.filter(file => exists(join(stage, file.path))).map(file => file.path),
  );
  const installing = new Set(journal.install.map(file => file.path));
  const present = exactly(root, journal);
  for (const file of journal.displace) {
    if (installing.has(file.path) && !pending.has(file.path)) continue;
    track(file.path);
    guard(file.path);
    const from = join(root, file.path),
      to = join(backup, file.path);
    if (present(file.path) && !exists(to)) {
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      renameSync(from, to);
    }
  }
  // New directory spellings next (shallowest first), so emptied-directory paths below are spelled
  // as the target spells them; a rollback renames them back.
  for (const entry of journal.respell ?? []) {
    guard(entry.path);
    respellForward(root, entry, track);
  }
  // A directory taking a file's place (or holding an incoming file's name) is emptied first.
  // Compared by folded spelling: on a case-insensitive filesystem `Foo/` holds the name of `foo`.
  const installPaths = journal.install.map(file => fold(file.path));
  const flipped = (directory: string) =>
    installPaths.some(path => fold(directory) === path || fold(directory).startsWith(`${path}/`));
  for (const directory of journal.directories) if (flipped(directory)) removeEmptied(root, directory, track);
  const changed = journal.displace.filter(
    file => exists(join(backup, file.path)) && !matches(join(backup, file.path), file),
  );
  const occupied = journal.install.filter(
    file => pending.has(file.path) && exists(join(steps.root, file.path)),
  );
  // Nothing installed yet: an edit undoes the apply and refuses, as the clean check would have.
  if ((changed.length || occupied.length) && pending.size === journal.install.length) {
    const edited = changed[0] ?? occupied[0]!;
    return rollBack(
      steps,
      track,
      new ForgeError(
        'WORK_CONFLICT',
        `Local checkout changes at ${JSON.stringify(edited.path)} are preserved.`,
        undefined,
        changed.length
          ? { obstruction: { path: edited.path, kind: 'source-edit', expectedDigest: edited.blob } }
          : { obstruction: { path: edited.path, kind: 'extra-source' } },
      ),
    );
  }
  for (const file of journal.install) {
    if (!pending.has(file.path)) continue;
    track(file.path);
    guard(file.path);
    const to = join(root, file.path);
    mkdirSync(dirname(to), { recursive: true });
    if (exists(to)) {
      if (lstatSync(to).isDirectory())
        throw deltaPendingError(`a directory now holds ${JSON.stringify(file.path)}.`, file.path, rerun);
      // Recreated after installing began: keep it beside the displaced bytes, never replace it.
      const spare = join(backup, 'occupied', randomUUID(), file.path);
      mkdirSync(dirname(spare), { recursive: true, mode: 0o700 });
      renameSync(to, spare);
    }
    renameSync(join(stage, file.path), to);
  }
  const parents = [...journal.install, ...journal.displace, ...(journal.respell ?? [])].map(file =>
    dirname(join(root, file.path)),
  );
  for (const directory of journal.directories) {
    if (!flipped(directory)) removeEmptied(root, directory, track);
    parents.push(dirname(join(root, directory)));
  }
  // Every parent the journal touched, including renames done before an interruption, is durable
  // before the marker vouches for it.
  syncAll(parents);
  renameSync(steps.stageMarker, steps.rootMarker);
  syncDirectory(dirname(steps.rootMarker));
  return finish(steps);
}
function finish(steps: Steps): DeltaSettlement {
  const { journal, root, backup } = steps;
  // Unchanged entries keep vouching for unchanged inodes. Installed ones are racy (just renamed)
  // until a later clean check or dirty check re-reads them once and refreshes the index.
  const index = readCheckoutStatIndex(root);
  for (const file of journal.displace) index.entries.delete(file.path);
  for (const file of journal.install)
    try {
      index.entries.set(file.path, statEntry(lstatSync(join(root, file.path)), file.blob));
    } catch {
      index.entries.delete(file.path);
    }
  writeCheckoutStatIndex(root, index.since, index.entries);
  const kept =
    exists(join(backup, 'occupied')) ||
    journal.displace.some(file => exists(join(backup, file.path)) && !matches(join(backup, file.path), file));
  return retire(steps, kept, 'published');
}
/** Regenerable folders go before the journal, so an interruption here leaves the journal to finish
 * the cleanup on the next command instead of an untracked moved-aside folder. Kept bytes are
 * flushed and listed first. */
function retire(steps: Steps, kept: boolean, outcome: DeltaSettlement['outcome'], conflict?: ForgeError) {
  const { journal, cacheRoot, stage, backup } = steps;
  if (kept) {
    syncAll(backupDirectories(backup, journal));
    retainedDeltaBackups(cacheRoot, backup);
  }
  rmSync(stage, { recursive: true, force: true });
  if (!kept) rmSync(backup, { recursive: true, force: true });
  rmSync(steps.journalPath, { force: true });
  syncDirectory(cacheRoot);
  return { outcome, retained: kept ? [backup] : [], ...(conflict ? { conflict } : {}) };
}
/** Return the checkout to its prior baseline. Installed paths are removed only while they hold
 * exactly the incoming bytes; moved-aside bytes go back wherever the path is free. */
function rollBack(steps: Steps, track: (path: string) => void, conflict?: ForgeError): DeltaSettlement {
  const { journal, root, cacheRoot, stage, backup } = steps;
  if (!journal.aborting) writeDeltaJournal(cacheRoot, { ...journal, aborting: true });
  const guard = parentGuard(root),
    touched: string[] = [];
  const present = exactly(root, journal);
  for (const file of journal.install) {
    const at = join(root, file.path);
    if (exists(join(stage, file.path)) || !present(file.path)) continue;
    track(file.path);
    guard(file.path);
    if (!wasInstalled(at, file, journal, backup)) continue;
    rmSync(at);
    touched.push(dirname(at));
  }
  for (const entry of [...(journal.respell ?? [])].reverse()) {
    guard(entry.path);
    respellBack(root, entry, track);
    touched.push(join(root, parentOf(entry.path)));
  }
  let kept = exists(join(backup, 'occupied'));
  for (const file of journal.displace) {
    const from = join(backup, file.path),
      to = join(root, file.path);
    if (!exists(from)) continue;
    track(file.path);
    guard(file.path);
    // A directory the install made at a file's name goes once only directories remain in it.
    const directory = exists(to) && lstatSync(to).isDirectory();
    if (directory)
      try {
        removeEmptyTree(to);
        touched.push(dirname(to));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
      }
    if (exists(to)) {
      kept = true;
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    touched.push(dirname(to));
  }
  syncAll(touched);
  return retire(steps, kept, 'rolled-back', conflict);
}
/** An installed path is ours to remove only while it holds exactly the incoming bytes. Anything
 * else was written after the interruption and refuses, keeping the journal for a rerun. */
function wasInstalled(at: string, file: DeltaPin, journal: DeltaJournal, backup: string) {
  if (matches(at, file)) return true;
  const displaced = journal.displace.some(item => item.path === file.path);
  // Never moved aside and never installed: it is the untouched baseline (or a user's own file).
  if (!displaced || !exists(join(backup, file.path))) return false;
  throw deltaPendingError(
    `${JSON.stringify(file.path)} changed after the apply was interrupted.`,
    file.path,
    rerun,
  );
}
