// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acquireHeavySlot, heavySlotDirectory, tryHeavySlot } from './heavy-slots.js';
import { heavySlots, readClientSettings } from './client-settings.js';

export type DependencyInstaller = (directory: string) => Promise<void>;
export type SharedDependencies =
  | { status: 'off' | 'none' | 'present' }
  | { status: 'linked' | 'installed'; key: string; path: string }
  | { status: 'failed'; key: string; message: string };

export function dependencyCacheDirectory() {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'forge', 'deps');
}
/** npm installs are keyed by the exact lockfile, package.json, platform and Node major version,
 * so a Lane with a different lockfile never shares another Lane's install. */
export function dependencyKey(root: string): string | null {
  let lock: Buffer, manifest: Buffer;
  try {
    lock = readFileSync(join(root, 'package-lock.json'));
    manifest = readFileSync(join(root, 'package.json'));
  } catch {
    return null;
  }
  return createHash('sha256')
    .update(lock)
    .update('\0')
    .update(manifest)
    .update(`\0${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}`)
    .digest('hex')
    .slice(0, 24);
}
const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
const complete = (entry: string, key: string) => {
  try {
    return readFileSync(join(entry, '.forge-complete'), 'utf8') === key;
  } catch {
    return false;
  }
};
export const npmInstaller: DependencyInstaller = directory =>
  new Promise((resolve, reject) => {
    const child = spawn('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: directory,
      // npm output goes to stderr; stdout stays the command's JSON receipt.
      stdio: ['ignore', 2, 2],
    });
    child.once('error', reject);
    child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`npm ci exited ${code}`))));
  });

/** Link ROOT/node_modules to the machine's install for this exact lockfile, installing it once.
 * Leaves an existing node_modules alone. Concurrent opens of the same lockfile install once. */
export async function shareDependencies(
  root: string,
  options: { install?: DependencyInstaller; enabled?: boolean; cache?: string } = {},
): Promise<SharedDependencies> {
  if (!(options.enabled ?? readClientSettings().shareDependencies)) return { status: 'off' };
  const key = dependencyKey(root);
  if (!key) return { status: 'none' };
  if (exists(join(root, 'node_modules'))) return { status: 'present' };
  const cache = options.cache ?? dependencyCacheDirectory(),
    entry = join(cache, `npm-${key}`);
  let installed = false;
  if (!complete(entry, key)) {
    mkdirSync(cache, { recursive: true });
    // The per-lockfile lock reuses the heavy-slot primitive with one slot; a dead holder is reclaimed.
    const locks = join(cache, `npm-${key}.lock`);
    const lock = tryHeavySlot(locks, 1) ?? (await acquireHeavySlot(locks, 1));
    try {
      if (!complete(entry, key)) {
        for (const name of readdirSync(cache))
          if (name.startsWith(`npm-${key}.tmp-`)) rmSync(join(cache, name), { recursive: true, force: true });
        rmSync(entry, { recursive: true, force: true });
        const stage = mkdtempSync(join(cache, `npm-${key}.tmp-`));
        copyFileSync(join(root, 'package.json'), join(stage, 'package.json'));
        copyFileSync(join(root, 'package-lock.json'), join(stage, 'package-lock.json'));
        const settings = readClientSettings(),
          slots = heavySlots(settings.localHeavySlots);
        const slot = slots ? await acquireHeavySlot(heavySlotDirectory(), slots) : null;
        try {
          await (options.install ?? npmInstaller)(stage);
        } catch (error) {
          rmSync(stage, { recursive: true, force: true });
          return { status: 'failed', key, message: error instanceof Error ? error.message : String(error) };
        } finally {
          if (slot) rmSync(slot, { recursive: true, force: true });
        }
        writeFileSync(join(stage, '.forge-complete'), key);
        renameSync(stage, entry);
        installed = true;
      }
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  const path = join(entry, 'node_modules');
  if (!exists(path)) return { status: 'none' };
  symlinkSync(path, join(root, 'node_modules'), 'dir');
  return { status: installed ? 'installed' : 'linked', key, path };
}
