// SPDX-License-Identifier: Apache-2.0
import { symlinkSync, writeFileSync, type Stats } from 'node:fs';
import { executableBitMatches, regularFileMode } from './file-mode.js';

// Windows refuses symlinks without Developer Mode or administrator rights (EPERM). There a
// recorded source link is written as a regular file holding its target, as Git does with
// core.symlinks=false, and such a file reads back as the recorded link; editing the file edits
// the link target. Directory links that are not source (dependency folders, CLI builds) use
// junctions, which need no privilege. macOS and Linux always create real links.

type RecordedMode = 'file' | 'executable' | 'symlink' | 'gitlink' | null | undefined;
const refused = (error: unknown) => ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '');

/** Write a source link; returns false when Windows refused it and a target file was written. */
export function writeSourceLink(
  target: Buffer | string,
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch (error) {
    if (platform !== 'win32' || !refused(error)) throw error;
    writeFileSync(path, target, { flag: 'wx', mode: 0o600 });
    return false;
  }
}

/** A link to a directory that is not source: a junction on Windows (absolute, no privilege). */
export function linkDirectory(target: string, path: string, platform: NodeJS.Platform = process.platform) {
  symlinkSync(target, path, platform === 'win32' ? 'junction' : 'dir');
}

/** Whether a regular file stands for its recorded link (Windows link fallback). */
export const linkFallback = (
  stat: Pick<Stats, 'isFile'>,
  recorded: RecordedMode,
  platform: NodeJS.Platform = process.platform,
) => platform === 'win32' && recorded === 'symlink' && stat.isFile();

/** The mode to record for a file or link on disk, given its recorded mode. */
export function diskMode(
  stat: Pick<Stats, 'isFile' | 'isSymbolicLink' | 'mode'>,
  recorded: RecordedMode,
  platform: NodeJS.Platform = process.platform,
): 'file' | 'executable' | 'symlink' {
  if (stat.isSymbolicLink() || linkFallback(stat, recorded, platform)) return 'symlink';
  return regularFileMode(stat.mode, recorded, platform);
}

/** Whether a file or link on disk has the shape its recorded mode names (bytes compared apart). */
export function diskShapeMatches(
  stat: Pick<Stats, 'isFile' | 'isSymbolicLink' | 'mode'>,
  recorded: RecordedMode,
  platform: NodeJS.Platform = process.platform,
) {
  if (stat.isSymbolicLink()) return recorded === 'symlink';
  if (!stat.isFile()) return false;
  if (recorded === 'symlink') return linkFallback(stat, recorded, platform);
  // A submodule kept as its pointer file (gitlink) matches like a plain file.
  return executableBitMatches(stat.mode, recorded, platform);
}
