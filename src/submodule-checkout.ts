// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { readSource } from './files.js';
import { gitlinkCommit, gitmoduleUrls } from './gitlink.js';
import { gitlinkDirectory, gitlinkDirectoryPointer } from './gitlink-workspace.js';
import { durableReplace, syncDirectory, syncFile } from './native-durability.js';
import { canonicalRoot, clientCacheRoot } from './root-paths.js';
import { safeRelative } from './safe-relative.js';
import { SubmoduleFetcher, vetted } from './submodule-materialize.js';
import { checkoutRepository, moveCheckout } from './submodule-repository.js';
import { inTestProcess } from './test-isolation.js';
import { workLocked } from './work-lock.js';

/** Checkout machinery (install, pull, clean, rollback) works on pointer files; a checked-out
 * submodule waits here, beside the checkout and outside it, while that machinery runs. */
const parkName = 'submodules';
const sha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
/** `pointer`: the HEAD it was parked at (nothing moves it while parked); `target`: the commit a
 * restore in progress is placing. */
const entrySchema = z
  .object({ path: z.string().refine(safeRelative), pointer: sha.optional(), target: sha.optional() })
  .strict();

export type SubmoduleCheckoutReport = {
  materialized: string[];
  refused: { path: string; commit: string; url: string | null; reason: string }[];
  kept: { path: string; at: string; reason: string }[];
  notice?: string;
};

/** Shared shallow fetches for every clone and Lane of this OS user: one bare repository per
 * URL, each commit fetched once. `FORGE_SUBMODULES=off` keeps pointer files (the opt-out). */
export function submoduleCacheDirectory(): string | null {
  if (['off', '0', 'false'].includes(process.env.FORGE_SUBMODULES ?? '')) return null;
  const configured = process.env.FORGE_SUBMODULE_CACHE;
  if (configured) return resolve(configured);
  if (inTestProcess()) return null;
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'forge', 'submodules');
}

const key = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 32);
/** Gitlink paths the checkout marker installed (sparse Lanes: only materialized ones). A marker
 * without a gitlink costs one substring check. */
function checkoutGitlinks(root: string): string[] {
  for (const name of ['hosted-lane.json', 'hosted-main.json']) {
    let bytes: Buffer | null = null;
    try {
      bytes = readSource(root, `.forge/${name}`, Number.MAX_SAFE_INTEGER);
    } catch {
      bytes = null;
    }
    if (!bytes) continue;
    if (!bytes.includes('"gitlink"')) return [];
    const marker = JSON.parse(bytes.toString('utf8')) as {
      state?: { files?: { path: string; mode: string }[] };
      materialized?: string[];
    };
    const materialized = Array.isArray(marker.materialized) ? new Set(marker.materialized) : null;
    return (marker.state?.files ?? [])
      .filter(file => file.mode === 'gitlink' && safeRelative(file.path))
      .filter(file => !materialized || materialized.has(file.path))
      .map(file => file.path);
  }
  return [];
}
/** Every parent is a real directory inside the checkout, so a rename never leaves it. */
function realParents(root: string, path: string) {
  let directory = root;
  for (const part of path.split('/').slice(0, -1)) {
    directory = join(directory, part);
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}
/** The commit a pointer file names, or null when the path holds anything else. */
function pointerFile(root: string, path: string): string | null {
  try {
    if (!realParents(root, path)) return null;
    const stat = lstatSync(join(root, path));
    if (!stat.isFile() || stat.size > 65) return null;
    return gitlinkCommit(readFileSync(join(root, path)));
  } catch {
    return null;
  }
}
function writePointer(root: string, path: string, commit: string) {
  durableReplace(join(root, path), commit, 0o644);
  syncFile(join(root, path));
}
function entries(park: string) {
  if (!existsSync(park)) return [];
  return readdirSync(park)
    .filter(name => /^[0-9a-f]{32}\.json$/.test(name))
    .map(name => {
      const id = name.slice(0, -5);
      return { id, ...entrySchema.parse(JSON.parse(readFileSync(join(park, name), 'utf8'))) };
    });
}
function forget(park: string, id: string) {
  rmSync(join(park, `${id}.json`), { force: true });
  syncDirectory(park);
}
/** Finish an interrupted park or restore: a missing path gets back its pointer file (the restore
 * target when one was journaled), so the checkout is always a valid pointer-file tree. */
function recoverPark(root: string, park: string) {
  for (const entry of entries(park)) {
    const parked = join(park, entry.id);
    if (!existsSync(parked)) forget(park, entry.id);
    else if (!existsSync(join(root, entry.path)) && realParents(root, entry.path))
      writePointer(
        root,
        entry.path,
        entry.target ?? entry.pointer ?? gitlinkDirectoryPointer(park, entry.id).toString(),
      );
  }
}
/** Park each checked-out submodule and leave its pointer file. Nothing moves when any HEAD
 * refuses (a branch checkout), so the refusal leaves the checkout exactly as it was. */
function park(root: string, parkDirectory: string, paths: string[]) {
  recoverPark(root, parkDirectory);
  const held = paths.filter(
    path =>
      realParents(root, path) && gitlinkDirectory(root, path) && !existsSync(join(parkDirectory, key(path))),
  );
  const pointers = held.map(path => gitlinkDirectoryPointer(root, path).toString());
  if (!held.length) return;
  mkdirSync(parkDirectory, { recursive: true, mode: 0o700 });
  held.forEach((path, i) => {
    const id = key(path);
    durableReplace(join(parkDirectory, `${id}.json`), JSON.stringify({ path, pointer: pointers[i] }));
    renameSync(join(root, path), join(parkDirectory, id));
    syncDirectory(parkDirectory);
    writePointer(root, path, pointers[i]!);
    syncDirectory(dirname(join(root, path)));
  });
}
/** Swap a pointer file for a submodule directory when the pointer still names `commit`. */
function place(root: string, parkDirectory: string, path: string, commit: string, id: string) {
  if (pointerFile(root, path) !== commit) return false;
  durableReplace(
    join(parkDirectory, `${id}.json`),
    JSON.stringify({ path, pointer: commit, target: commit }),
  );
  rmSync(join(root, path));
  renameSync(join(parkDirectory, id), join(root, path));
  syncDirectory(dirname(join(root, path)));
  forget(parkDirectory, id);
  return true;
}

/** Restore parked submodules and materialize new pointer files as checkouts. Network work runs
 * outside the checkout lock; each swap re-checks the pointer under it. */
async function restore(root: string, parkDirectory: string, paths: string[], online: boolean) {
  const lock = join(clientCacheRoot(root), 'lock');
  const report: SubmoduleCheckoutReport = { materialized: [], refused: [], kept: [] };
  const parked = new Map(
    workLocked(lock, () => (recoverPark(root, parkDirectory), entries(parkDirectory))).map(entry => [
      entry.path,
      entry,
    ]),
  );
  const cache = online ? submoduleCacheDirectory() : null;
  const modules = (() => {
    try {
      const bytes = readSource(root, '.gitmodules', 1024 * 1024);
      return bytes ? gitmoduleUrls(bytes.toString('utf8')) : new Map<string, string>();
    } catch {
      return new Map<string, string>();
    }
  })();
  const fetcher = cache ? new SubmoduleFetcher({ cache }) : null;
  const keep = (path: string, reason: string) => {
    const entry = parked.get(path);
    if (entry) report.kept.push({ path, at: join(parkDirectory, entry.id), reason });
    parked.delete(path);
  };
  try {
    for (const path of paths) {
      const commit = pointerFile(root, path);
      if (!commit) continue;
      const entry = parked.get(path),
        raw = modules.get(path) ?? null,
        chosen = vetted({ url: raw, origin: undefined });
      if (entry) {
        const head = entry.pointer ?? null;
        if (head !== commit) {
          if (!fetcher || !('url' in chosen)) {
            keep(
              path,
              `its checkout is at ${head?.slice(0, 12) ?? 'an unreadable HEAD'} and the pointer moved to ${commit.slice(0, 12)}; ${fetcher ? `the URL is unusable (${'reason' in chosen ? chosen.reason : ''})` : 'submodule fetches are off'}`,
            );
            continue;
          }
          const pinned = await fetcher.pin(chosen.url, commit);
          const moved =
            typeof pinned === 'string'
              ? pinned
              : await moveCheckout(fetcher, cache!, chosen.url, commit, parkDirectory, entry.id).then(
                  () => null,
                  () => 'local changes in the submodule block checking out the new commit',
                );
          if (moved) {
            keep(
              path,
              `the pointer moved to ${commit.slice(0, 12)} and ${moved}. Commit or stash there, then rerun the command`,
            );
            continue;
          }
          durableReplace(join(parkDirectory, `${entry.id}.json`), JSON.stringify({ path, pointer: commit }));
        }
        if (workLocked(lock, () => place(root, parkDirectory, path, commit, entry.id))) parked.delete(path);
        continue;
      }
      if (!fetcher) continue;
      if (!('url' in chosen)) {
        report.refused.push({ path, commit, url: raw, reason: chosen.reason });
        continue;
      }
      const pinned = await fetcher.pin(chosen.url, commit);
      if (typeof pinned === 'string') {
        report.refused.push({ path, commit, url: raw, reason: pinned });
        continue;
      }
      await mkdir(parkDirectory, { recursive: true, mode: 0o700 });
      const fresh = join(parkDirectory, `new-${randomUUID()}`),
        nested: SubmoduleCheckoutReport = { materialized: [], refused: [], kept: [] };
      try {
        await checkoutRepository(fetcher, cache!, chosen.url, commit, fresh, nested, path);
        const id = key(path);
        // Parked first (journaled, then renamed), so an interrupted swap recovers like a restore.
        const placed = workLocked(lock, () => {
          if (existsSync(join(parkDirectory, id))) return false;
          durableReplace(join(parkDirectory, `${id}.json`), JSON.stringify({ path, pointer: commit }));
          renameSync(fresh, join(parkDirectory, id));
          syncDirectory(parkDirectory);
          return place(root, parkDirectory, path, commit, id);
        });
        if (placed) {
          report.materialized.push(path, ...nested.materialized);
          report.refused.push(...nested.refused);
        }
      } catch {
        report.refused.push({ path, commit, url: raw, reason: 'checkout-failed' });
      } finally {
        await rm(fresh, { recursive: true, force: true });
      }
    }
    for (const path of [...parked.keys()])
      keep(
        path,
        paths.includes(path)
          ? 'its path no longer holds the pointer file'
          : 'it is no longer a submodule in this checkout',
      );
  } finally {
    await fetcher?.dispose();
  }
  if (report.refused.length)
    report.notice = `${report.refused.length} submodule(s) stay pointer files (${report.refused
      .slice(0, 3)
      .map(item => `${item.path}: ${item.reason}`)
      .join(
        '; ',
      )}). Only credential-free HTTPS URLs are fetched; private submodules are not fetched yet. Edit a pointer file's SHA to change its commit.`;
  if (report.kept.length)
    report.notice = `${report.notice ? `${report.notice} ` : ''}${report.kept.length} submodule checkout(s) kept outside the working tree: ${report.kept
      .map(item => `${item.path} at ${item.at} (${item.reason})`)
      .join('; ')}.`;
  return report;
}

/** Run checkout machinery with submodules as pointer files, then put checkouts back: parked
 * ones restored (moved to a new pinned commit when the pointer changed), new ones fetched once
 * per URL and commit into the shared cache. Unsaved submodule work is never deleted. */
export async function withSubmoduleCheckouts<T extends object>(
  root: string,
  run: () => Promise<T>,
): Promise<T | (T & { submodules: SubmoduleCheckoutReport })> {
  root = canonicalRoot(root);
  const parkDirectory = join(clientCacheRoot(root), parkName);
  const before = checkoutGitlinks(root);
  if (before.length || existsSync(parkDirectory))
    workLocked(join(clientCacheRoot(root), 'lock'), () => park(root, parkDirectory, before));
  let result: T;
  try {
    result = await run();
  } catch (error) {
    // The tree is still its baseline: put parked checkouts back without fetching anything.
    if (existsSync(parkDirectory))
      await restore(root, parkDirectory, checkoutGitlinks(root), false).catch(() => undefined);
    throw error;
  }
  const after = checkoutGitlinks(root);
  if (!after.length && !existsSync(parkDirectory)) return result;
  const report = await restore(root, parkDirectory, after, true);
  return report.materialized.length || report.refused.length || report.kept.length
    ? { ...result, submodules: report }
    : result;
}
