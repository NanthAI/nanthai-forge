// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, cpSync, lstatSync, rmSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { childEnv } from '../scripts/child-env.mjs';

export type NativeClone = { method: 'clone' | 'copy'; reason?: string };
const apfsTypes = new Map<number, boolean>();

function macCloneReason(source: string, destination: string) {
  if (lstatSync(source).dev !== lstatSync(dirname(destination)).dev) return 'EXDEV';
  const type = statfsSync(source).type;
  let apfs = apfsTypes.get(type);
  if (apfs === undefined) {
    try {
      const options = { env: childEnv(), stdio: 'pipe' as const, encoding: 'utf8' as const };
      // diskutil takes a device/mount point, not an arbitrary file. df -P gives
      // the mounted device even through macOS Data-volume firmlinks.
      const device = execFileSync('/bin/df', ['-P', source], options)
        .trim()
        .split('\n')
        .at(-1)!
        .split(/\s+/)[0]!;
      if (!device.startsWith('/dev/')) return 'not-apfs';
      const info = execFileSync('/usr/sbin/diskutil', ['info', '-plist', device], {
        env: childEnv(),
        stdio: 'pipe',
        encoding: 'utf8',
      });
      apfs = /<key>FilesystemType<\/key>\s*<string>apfs<\/string>/i.test(info);
      apfsTypes.set(type, apfs);
    } catch {
      return 'clone-capability-unavailable';
    }
  }
  return apfs ? undefined : 'not-apfs';
}

/** Destination is private, new scratch owned by the caller. No shell, hardlinks,
 * repository commands. The caller normalizes metadata and verifies bytes
 * before publishing; copy fallback is always observable. */
export function cloneNativePath(source: string, destination: string, tree = false): NativeClone {
  try {
    lstatSync(destination);
    throw Object.assign(new Error('Clone destination exists.'), { code: 'EEXIST' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const copy = (reason: string): NativeClone => {
    if (tree) cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
    else copyFileSync(source, destination, constants.COPYFILE_EXCL);
    return { method: 'copy', reason };
  };
  // macOS cp -c silently copies on unsupported volumes. Establish APFS and the
  // same device first, so a successful cp never misreports that fallback.
  if (process.platform === 'darwin') {
    const reason = macCloneReason(source, destination);
    if (reason) return copy(reason);
  }
  try {
    if (process.platform === 'darwin') {
      // libuv's COPYFILE_FICLONE_FORCE returns ENOSYS on macOS. cp -c calls
      // clonefile(2); one recursive invocation also avoids a process per file.
      execFileSync('/bin/cp', ['-cR', source, destination], {
        env: childEnv(),
        stdio: 'pipe',
      });
    } else if (tree) {
      cpSync(source, destination, {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE_FORCE,
      });
    } else copyFileSync(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE);
    return { method: 'clone' };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { status?: number };
    // Disk, access and publication errors are not evidence of unavailable clones.
    if (
      !['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'ENOENT'].includes(failure.code ?? '') &&
      !(process.platform === 'darwin' && failure.status === 1)
    )
      throw error;
    rmSync(destination, { recursive: tree, force: true });
    return copy(failure.code ?? `clonefile-command-exit-${failure.status}`);
  }
}
