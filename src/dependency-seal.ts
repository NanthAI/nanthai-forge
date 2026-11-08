// SPDX-License-Identifier: Apache-2.0
import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** A finished shared install is read-only: every file and directory loses its write bits, so one Lane's
 * tools cannot change what every Lane that shares the install runs. The entry folder (Forge's own
 * markers) and each `node_modules` root stay writable, so tools can still create their `.cache`/`.vite`
 * style folders beside the packages. Links are never followed. No-op on Windows, which has no mode bits. */
export function sealInstall(entry: string, roots: string[]): void {
  if (process.platform === 'win32') return;
  const open = new Set([entry, ...roots]);
  const walk = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
    if (!open.has(path)) chmodSync(path, stat.mode & ~0o222);
  };
  walk(entry);
}

/** Make a sealed tree writable again. Directories first, so their children can then be changed. */
function unseal(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, stat.mode | 0o700);
    for (const name of readdirSync(path)) unseal(join(path, name));
  }
}

/** Delete an install, sealed or not. A failed plain delete is retried after unsealing. */
export function removeInstall(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    if (!['EACCES', 'EPERM', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    unseal(path);
    rmSync(path, { recursive: true, force: true });
  }
}
