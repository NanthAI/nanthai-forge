// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { linkInstall } from './dependency-link.js';
import { linkDirectory } from './source-links.js';

/** A Lane's `node_modules` that Forge linked, and the key of the install it points at.
 * Cheap to read: one lstat, plus one readlink or one small marker file. */
export type ForgeLink = { fingerprint: string; entry: string; folders: string[] };
export type Relinked = { from: string };

const ENTRY_NAME = /^(npm|pnpm|yarn|bun)(?:-scripts)?-([0-9a-f]{24})$/;
/** Written inside a Lane-owned (real directory) `node_modules` so a later sync knows Forge built it. */
const MARKER = '.forge-linked.json';
/** Beside `.forge-complete` in a cache entry: the manager-version-free key its Lane links compare against.
 * (Only npm's entry name is that key; the others also hash the resolved manager version.) */
const ENTRY_FINGERPRINT = '.forge-fingerprint';

const stat = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/** Remember which install a linked-directory `node_modules` (workspaces, pnpm, yarn, bun) was built from.
 * A single symlink needs no marker: its target names the install. */
export function recordLink(root: string, link: ForgeLink): void {
  const modules = join(root, 'node_modules'),
    found = stat(modules);
  try {
    if (found?.isDirectory()) writeFileSync(join(modules, MARKER), JSON.stringify(link));
    else if (found?.isSymbolicLink() && !basename(link.entry).startsWith('npm-'))
      writeFileSync(join(link.entry, ENTRY_FINGERPRINT), link.fingerprint);
  } catch {
    /* A Lane without the marker is left alone on later syncs, as before. */
  }
}

/** The install a Forge-made `node_modules` was linked to; null when it is absent or not Forge's
 * (an install the agent ran itself is never touched). */
export function readLink(root: string): ForgeLink | null {
  const modules = join(root, 'node_modules'),
    found = stat(modules);
  if (found?.isSymbolicLink()) {
    try {
      const target = readlinkSync(modules),
        entry = dirname(target),
        match = ENTRY_NAME.exec(basename(entry));
      if (!isAbsolute(target) || basename(target) !== 'node_modules' || !match) return null;
      const fingerprint =
        match[1] === 'npm' ? match[2]! : readFileSync(join(entry, ENTRY_FINGERPRINT), 'utf8').trim();
      return /^[0-9a-f]{24}$/.test(fingerprint) ? { fingerprint, entry, folders: [] } : null;
    } catch {
      return null;
    }
  }
  if (!found?.isDirectory()) return null;
  try {
    const marker = JSON.parse(readFileSync(join(modules, MARKER), 'utf8')) as Partial<ForgeLink>;
    const ok =
      typeof marker.fingerprint === 'string' &&
      /^[0-9a-f]{24}$/.test(marker.fingerprint) &&
      typeof marker.entry === 'string' &&
      isAbsolute(marker.entry) &&
      Array.isArray(marker.folders) &&
      marker.folders.every(
        folder => typeof folder === 'string' && !isAbsolute(folder) && !folder.split('/').includes('..'),
      );
    return ok ? (marker as ForgeLink) : null;
  } catch {
    return null;
  }
}

/** True when everything in a linked `node_modules` is something Forge made or a tool cache:
 * links, `@scope` directories of links and dot-entries (the marker, `.vite`). Anything else is the
 * agent's own install, kept. */
function onlyLinks(directory: string, top = true): boolean {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return true;
  }
  return names.every(name => {
    const found = stat(join(directory, name));
    if (!found || found.isSymbolicLink() || name.startsWith('.')) return true;
    return top && name.startsWith('@') && found.isDirectory() && onlyLinks(join(directory, name), false);
  });
}

/** Remove a Forge-made link so a new one can be made; returns how to put it back, or why it was kept. */
function retire(root: string, link: ForgeLink): (() => void) | string {
  const modules = ['', ...link.folders].map(folder => join(root, folder, 'node_modules'));
  if (!link.folders.length && stat(modules[0]!)?.isSymbolicLink()) {
    const target = readlinkSync(modules[0]!);
    rmSync(modules[0]!, { force: true });
    return () => {
      if (!stat(modules[0]!)) linkDirectory(target, modules[0]!);
    };
  }
  const present = modules.filter(path => stat(path));
  if (!present.every(path => stat(path)!.isDirectory() && onlyLinks(path)))
    return 'node_modules holds installs Forge did not link, so it was kept; delete it to relink.';
  for (const path of present) rmSync(path, { recursive: true, force: true });
  return () => {
    try {
      if (!stat(join(root, 'node_modules'))) linkInstall(link.entry, root, link.folders);
    } catch {
      /* Best effort: the failure is already reported by the caller. */
    }
  };
}

/** After files changed in a Lane (a sync, pull or apply, or any later command): when its `node_modules`
 * is a Forge link to an install of an older lockfile, relink it through `relink` (which installs once
 * into the shared cache if the new key is not there yet). Returns null when there is nothing to do.
 * A failed relink puts the previous link back, so a Lane never ends with less than it had. */
export async function relinkIfStale<T extends { status: string }>(
  root: string,
  currentKey: string,
  relink: () => Promise<T>,
): Promise<{ status: 'stale'; reason: string } | (T & { relinked?: Relinked }) | null> {
  const link = readLink(root);
  if (!link || link.fingerprint === currentKey) return null;
  const undo = retire(root, link);
  if (typeof undo === 'string') return { status: 'stale', reason: undo };
  let result: T;
  try {
    result = await relink();
  } catch (error) {
    undo();
    throw error;
  }
  if (result.status === 'linked' || result.status === 'installed')
    return { ...result, relinked: { from: link.fingerprint } };
  undo();
  return result;
}
