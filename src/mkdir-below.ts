// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/** Creates `directory` and any missing parents strictly below `anchor`, which must already exist.
 * Components are made one at a time without `recursive`, so a deleted owner is never recreated
 * between a check and the mkdir: the missing anchor fails with ENOENT instead. */
export function mkdirBelow(anchor: string, directory: string, mode = 0o700): void {
  const rest = relative(anchor, directory);
  if (rest.startsWith(`..${sep}`) || rest === '..' || isAbsolute(rest))
    throw new Error(`Directory ${directory} is not below ${anchor}.`);
  if (!statSync(anchor).isDirectory()) throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
  let current = anchor;
  for (const part of rest.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      mkdirSync(current, { mode });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}
