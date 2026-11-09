// SPDX-License-Identifier: Apache-2.0
// Every read of a file's executable or group/other permission bits goes through here (lint rule
// forge/no-raw-mode-bits).
// Windows filesystems store no executable bit (as Git's core.fileMode=false): there a regular
// file keeps the mode its recorded version had, so edits never add or drop executable and a
// new file is a plain file. macOS and Linux read the bit from disk.

type RecordedMode = 'file' | 'executable' | 'symlink' | 'gitlink' | null | undefined;

export const executableBitStored = (platform: NodeJS.Platform = process.platform) => platform !== 'win32';

/** The mode to record for a regular file whose disk mode bits are `mode`. */
export function regularFileMode(
  mode: number,
  recorded?: RecordedMode,
  platform: NodeJS.Platform = process.platform,
): 'executable' | 'file' {
  if (!executableBitStored(platform)) return recorded === 'executable' ? 'executable' : 'file';
  return mode & 0o111 ? 'executable' : 'file';
}

/** Whether a regular file on disk agrees with its recorded file or executable mode. */
export function executableBitMatches(
  mode: number,
  recorded: RecordedMode,
  platform: NodeJS.Platform = process.platform,
) {
  return regularFileMode(mode, recorded, platform) === (recorded === 'executable' ? 'executable' : 'file');
}

/** Git's spelling of a regular file's mode; `recorded` is the Git mode before the change. */
export const gitFileMode = (
  mode: number,
  recorded?: string | null,
  platform: NodeJS.Platform = process.platform,
) =>
  regularFileMode(mode, recorded === '100755' ? 'executable' : 'file', platform) === 'executable'
    ? '100755'
    : '100644';

/** Whether permission bits keep group and others out. Windows stores no such bits: privacy there
 * comes from the user profile's access list, which Forge's directories inherit. */
export const ownerOnly = (mode: number, platform: NodeJS.Platform = process.platform) =>
  !executableBitStored(platform) || (mode & 0o077) === 0;
